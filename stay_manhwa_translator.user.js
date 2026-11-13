// ==UserScript==
// @name         Stay Manhwa & Manga Local Translator
// @namespace    http://tampermonkey.net/
// @version      3.0.0
// @description  Automatic chapter image discovery, sequential chapter queue, server communication, and mobile-friendly UI for Safari Stay.
// @author       Anthony
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      192.168.1.110
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // -------------------------------------------------------------
    // CONFIGURATION & PERSISTENCE
    // -------------------------------------------------------------
    const STORAGE_PREFIX = 'MANHWA_TRANSLATOR_';

    function getStorage(key, fallback) {
        if (typeof GM_getValue !== 'undefined') {
            try { return GM_getValue(STORAGE_PREFIX + key, fallback); } catch (_) { }
        }
        try {
            const val = localStorage.getItem(STORAGE_PREFIX + key);
            return val !== null ? JSON.parse(val) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function setStorage(key, value) {
        if (typeof GM_setValue !== 'undefined') {
            try { GM_setValue(STORAGE_PREFIX + key, value); return; } catch (_) { }
        }
        try {
            localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
        } catch (_) { }
    }

    const CONFIG = {
        serverUrl: getStorage('SERVER_URL', 'http://192.168.1.110:8765'),
        apiKey: getStorage('API_KEY', ''),
        minWidth: 280,
        minHeight: 280,
        minArea: 100000,
        minAspectRatio: 0.15,
        maxAspectRatio: 3.5,
        scanThrottleMs: 1000
    };

    // -------------------------------------------------------------
    // STATE  (Phase 1 — discovery)
    // -------------------------------------------------------------
    const STATE = {
        discoveredPages: [],      // Array of PageItem objects
        seenUrls: new Set(),      // Canonical URL deduplication set
        seenElements: new WeakSet(),
        serverOnline: false,
        lastHealthCheck: 0,
        isScanning: false,
        panelOpen: false,
        activeTab: 'pages',       // 'pages' | 'results' | 'settings'
        allResults: [],           // Array of { pageIndex, pageId, result } — accumulated across chapter
        lastResult: null          // Most recently viewed result (for single-page view compatibility)
    };

    // -------------------------------------------------------------
    // QUEUE STATE  (Phase 2 — chapter translation)
    //
    // Concurrency contract:
    //   - QUEUE.requestActive === true means a server request is currently
    //     in flight. No new queue iteration, no single-page translate,
    //     and no queue start may begin while this flag is true.
    //   - The flag is set to true immediately before dispatching a request
    //     and cleared only inside the request's onload / onerror / ontimeout
    //     callbacks, never earlier.
    //   - QUEUE.isRunning controls whether the queue loop continues after
    //     the current request completes. It is set false by pause/stop but
    //     the request itself still runs to completion.
    // -------------------------------------------------------------
    const QUEUE = {
        isRunning: false,     // Queue loop is active (may be paused)
        isPaused: false,      // Pause requested — finish current, halt before next
        isStopped: false,     // Stop requested — finish current, then exit loop
        requestActive: false, // A server request is currently in flight (request lock)
        currentPageId: null,  // ID of the page currently being processed
        mode: 'all'           // 'all' | 'selected' — determines eligibility filter
    };

    // -------------------------------------------------------------
    // URL NORMALIZATION & DEDUPLICATION
    // (Normalised URLs used only for deduplication — originals preserved for fetching)
    // -------------------------------------------------------------
    function normalizeImageUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') return '';
        const trimmed = rawUrl.trim();
        if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
            return trimmed;
        }

        try {
            const parsed = new URL(trimmed, window.location.href);
            // Remove common transient or cache-busting tracking params
            const dropParams = [
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                't', 'timestamp', '_', 'cache', 'nocache', 'v', 'token', 'auth'
            ];
            dropParams.forEach(p => parsed.searchParams.delete(p));
            return parsed.toString();
        } catch (_) {
            return trimmed.split('?')[0];
        }
    }

    // Returns candidate normalised URLs for deduplication.
    // The page.fetchUrl (original URL) is set separately to preserve query params needed for fetching.
    function extractCandidateUrls(element) {
        const rawCandidates = [];

        // 1. Standard img src
        if (element.src) rawCandidates.push(element.src);

        // 2. Common lazy-loading attributes
        const lazyAttrs = [
            'data-src', 'data-original', 'data-lazy-src', 'data-lazy',
            'data-url', 'data-page-url', 'data-full-url', 'data-origin',
            'data-echo', 'data-actualsrc', 'data-cfsrc', 'data-real-src'
        ];
        for (const attr of lazyAttrs) {
            const val = element.getAttribute(attr);
            if (val) rawCandidates.push(val);
        }

        // 3. srcset inspection
        const srcset = element.getAttribute('srcset') || element.srcset;
        if (srcset && typeof srcset === 'string') {
            const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
            if (parts.length > 0) {
                // Select highest resolution or last entry in srcset
                const last = parts[parts.length - 1].split(' ')[0];
                if (last) rawCandidates.push(last);
            }
        }

        // 4. Background image style
        const bg = element.style && element.style.backgroundImage;
        if (bg && bg !== 'none') {
            const match = bg.match(/url\(['"']?(.*?)['"']?\)/i);
            if (match && match[1]) rawCandidates.push(match[1]);
        }

        // Return raw URLs (before normalisation) as the first element so callers
        // can store them as fetchUrl, alongside the normalised form for deduplication.
        return rawCandidates
            .filter(Boolean)
            .map(raw => ({ raw: raw.trim(), normalized: normalizeImageUrl(raw) }))
            .filter(u => u.normalized);
    }

    // -------------------------------------------------------------
    // IMAGE FILTERING HEURISTICS
    // -------------------------------------------------------------
    const EXCLUDED_KEYWORDS = [
        'avatar', 'logo', 'icon', 'banner', 'button', 'nav', 'advert', 'advertisement', 'ads',
        'sponsor', 'comment', 'footer', 'header', 'social', 'discord', 'patreon',
        'badge', 'emoji', 'pixel', 'tracking', 'spacer', 'spinner', 'loader'
    ];

    function isLikelyAdvertisementOrUI(element, url) {
        const lowerUrl = (url || '').toLowerCase();

        // 1. Check parent hierarchy for ads or UI widgets
        let current = element;
        let depth = 0;
        while (current && depth < 5) {
            const className = (current.className || '').toString().toLowerCase();
            const id = (current.id || '').toLowerCase();
            const role = (current.getAttribute ? (current.getAttribute('role') || '') : '').toLowerCase();

            if (role === 'banner' || role === 'navigation') return true;

            for (const kw of EXCLUDED_KEYWORDS) {
                // Only match whole-word or delimited patterns to avoid false-positives
                // on comic titles that might contain 'icon' or 'nav'
                const pattern = new RegExp(`(^|[-_\\s])${kw}([-_\\s]|$)`, 'i');
                if (pattern.test(className) || pattern.test(id)) {
                    return true;
                }
            }
            current = current.parentElement;
            depth++;
        }

        // 2. URL keyword check (strict delimiter matching)
        for (const kw of ['/avatars/', '/logos/', '/icons/', '/ads/', 'adsbygoogle', '/banners/']) {
            if (lowerUrl.includes(kw)) return true;
        }

        return false;
    }

    function evaluateImageDimensions(element) {
        const naturalWidth = element.naturalWidth || 0;
        const naturalHeight = element.naturalHeight || 0;
        const rect = element.getBoundingClientRect();
        const renderedWidth = Math.round(rect.width);
        const renderedHeight = Math.round(rect.height);

        // Best dimension estimate
        const effectiveWidth = naturalWidth > 0 ? naturalWidth : renderedWidth;
        const effectiveHeight = naturalHeight > 0 ? naturalHeight : renderedHeight;

        return {
            naturalWidth,
            naturalHeight,
            renderedWidth,
            renderedHeight,
            effectiveWidth,
            effectiveHeight,
            aspectRatio: effectiveHeight > 0 ? (effectiveWidth / effectiveHeight) : 1
        };
    }

    function isLegitimateMangaPage(element, url) {
        if (!url) return false;
        if (isLikelyAdvertisementOrUI(element, url)) return false;

        const dims = evaluateImageDimensions(element);

        // If neither natural nor rendered dimensions are known yet (e.g. unloaded lazy image)
        // check if parent container has manga chapter indicators
        if (dims.effectiveWidth === 0 && dims.effectiveHeight === 0) {
            const parent = element.closest && element.closest(
                '.page, .chapter-image, .reader-image, .wp-manga-chapter-img, .page-break, .reading-content'
            );
            if (parent) return true;
            return false;
        }

        // Dimension and area checks
        if (dims.effectiveWidth < CONFIG.minWidth && dims.effectiveHeight < CONFIG.minHeight) {
            return false;
        }

        const area = dims.effectiveWidth * dims.effectiveHeight;
        if (area < CONFIG.minArea) {
            return false;
        }

        // Aspect ratio checks
        if (dims.aspectRatio < CONFIG.minAspectRatio || dims.aspectRatio > CONFIG.maxAspectRatio) {
            return false;
        }

        return true;
    }

    // -------------------------------------------------------------
    // NATURAL READING ORDER & DISCOVERY
    // -------------------------------------------------------------
    function calculateVerticalOffset(element) {
        const rect = element.getBoundingClientRect();
        return rect.top + window.scrollY;
    }

    function scanForMangaPages() {
        if (STATE.isScanning) return;
        STATE.isScanning = true;

        const newlyDiscovered = [];
        const seenUrlsOnScan = new Set(STATE.seenUrls);

        // ---- Helper: attempt to register a page from an element + candidate list ----
        function tryRegisterElement(targetEl, candidates) {
            if (candidates.length === 0) return;

            // Use the first normalised URL for deduplication
            const { raw: fetchUrl, normalized: dedupUrl } = candidates[0];
            if (seenUrlsOnScan.has(dedupUrl)) return;

            if (isLegitimateMangaPage(targetEl, dedupUrl)) {
                seenUrlsOnScan.add(dedupUrl);
                STATE.seenUrls.add(dedupUrl);

                const dims = evaluateImageDimensions(targetEl);
                const top = calculateVerticalOffset(targetEl);

                newlyDiscovered.push({
                    id: 'page_' + Math.random().toString(36).substr(2, 9),
                    element: targetEl,
                    fetchUrl: fetchUrl,  // Original URL — preserved for image fetching
                    url: dedupUrl,       // Normalised URL — used for deduplication & display only
                    naturalWidth: dims.naturalWidth,
                    naturalHeight: dims.naturalHeight,
                    renderedWidth: dims.renderedWidth,
                    renderedHeight: dims.renderedHeight,
                    top: top,
                    selected: true,
                    status: 'waiting',   // Phase 2: canonical initial status
                    result: null
                });
            }
        }

        // 1. Scan standard images
        const imgElements = Array.from(
            document.querySelectorAll('img, picture source, [data-src], [data-original]')
        );

        for (const el of imgElements) {
            const targetEl = el.tagName.toLowerCase() === 'source'
                ? (el.parentElement && el.parentElement.querySelector('img') || el)
                : el;

            tryRegisterElement(targetEl, extractCandidateUrls(el));
        }

        // 2. Scan background-image div containers (webtoon reader style)
        const bgContainers = Array.from(
            document.querySelectorAll('.page, .chapter-img, .manga-page, div[style*="background"]')
        );
        for (const el of bgContainers) {
            if (el.tagName.toLowerCase() === 'img') continue;
            tryRegisterElement(el, extractCandidateUrls(el));
        }

        // 3. Experimental Canvas Reader Detection (Report unsupported without crashing)
        const canvases = Array.from(document.querySelectorAll('canvas'));
        for (const canvas of canvases) {
            const rect = canvas.getBoundingClientRect();
            if (rect.width >= CONFIG.minWidth && rect.height >= CONFIG.minHeight) {
                // Check if canvas can be extracted or is tainted
                let isExtractable = false;
                try {
                    const testUrl = canvas.toDataURL('image/jpeg', 0.1);
                    if (testUrl && testUrl.length > 50) isExtractable = true;
                } catch (e) {
                    isExtractable = false;
                }

                const pseudoUrl = `canvas://${canvas.id || 'unnamed'}_${Math.round(rect.top)}`;
                if (!seenUrlsOnScan.has(pseudoUrl)) {
                    seenUrlsOnScan.add(pseudoUrl);
                    STATE.seenUrls.add(pseudoUrl);

                    newlyDiscovered.push({
                        id: 'page_' + Math.random().toString(36).substr(2, 9),
                        element: canvas,
                        fetchUrl: pseudoUrl,
                        url: isExtractable ? pseudoUrl : `canvas://[CORS-Protected]_${Math.round(rect.top)}`,
                        naturalWidth: canvas.width || Math.round(rect.width),
                        naturalHeight: canvas.height || Math.round(rect.height),
                        renderedWidth: Math.round(rect.width),
                        renderedHeight: Math.round(rect.height),
                        top: calculateVerticalOffset(canvas),
                        selected: isExtractable,
                        isCanvas: true,
                        isExtractable: isExtractable,
                        status: isExtractable ? 'waiting' : 'canvas_protected',
                        result: null
                    });
                }
            }
        }

        if (newlyDiscovered.length > 0) {
            // Append and re-sort strictly by vertical document offset (natural reading order)
            STATE.discoveredPages = STATE.discoveredPages.concat(newlyDiscovered);
            STATE.discoveredPages.sort((a, b) => a.top - b.top);

            updateUI();
        }

        STATE.isScanning = false;
    }

    // -------------------------------------------------------------
    // THROTTLED SCROLL & MUTATION OBSERVER
    // -------------------------------------------------------------
    let lastScanTime = 0;
    function requestThrottledScan() {
        const now = Date.now();
        if (now - lastScanTime >= CONFIG.scanThrottleMs) {
            lastScanTime = now;
            scanForMangaPages();
        }
    }

    function setupObservers() {
        // Watch for dynamically loaded / scrolled pages
        const observer = new MutationObserver((mutations) => {
            let hasImages = false;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1) {
                        if (node.tagName === 'IMG' || node.querySelector && node.querySelector('img, canvas, .page')) {
                            hasImages = true;
                            break;
                        }
                    }
                }
                if (hasImages) break;
            }
            if (hasImages) requestThrottledScan();
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });

        // Scroll listener for lazy loading readers
        window.addEventListener('scroll', () => {
            requestThrottledScan();
        }, { passive: true });
    }

    // -------------------------------------------------------------
    // SERVER COMMUNICATION & BASE64 EXTRACTION
    // -------------------------------------------------------------
    function checkServerHealth(callback) {
        const url = CONFIG.serverUrl.replace(/\/+$/, '') + '/health';

        const handleSuccess = () => {
            STATE.serverOnline = true;
            STATE.lastHealthCheck = Date.now();
            updateUI();
            if (callback) callback(true);
        };

        const handleFailure = () => {
            STATE.serverOnline = false;
            STATE.lastHealthCheck = Date.now();
            updateUI();
            if (callback) callback(false);
        };

        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 3000,
                onload: (res) => {
                    if (res.status === 200) handleSuccess();
                    else handleFailure();
                },
                onerror: handleFailure,
                ontimeout: handleFailure
            });
        } else {
            fetch(url, { method: 'GET', mode: 'cors' })
                .then(r => r.ok ? handleSuccess() : handleFailure())
                .catch(handleFailure);
        }
    }

    // Fetches the image for `page` and returns Base64 data via callback(err, base64).
    // Always uses page.fetchUrl (original URL) — not the normalised dedup URL.
    function convertImageToBase64(page, callback) {
        const el = page.element;

        // Handle canvas element directly
        if (page.isCanvas) {
            if (!page.isExtractable) {
                return callback(new Error('Canvas is DRM or CORS-protected from script access.'));
            }
            try {
                const dataUrl = el.toDataURL('image/jpeg', 0.95);
                const base64 = dataUrl.split(',')[1];
                return callback(null, base64);
            } catch (err) {
                return callback(err);
            }
        }

        // Try standard canvas draw first for cached/loaded <img>
        if (el.tagName.toLowerCase() === 'img' && el.complete && el.naturalWidth > 0) {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = el.naturalWidth;
                canvas.height = el.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(el, 0, 0);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
                const base64 = dataUrl.split(',')[1];
                if (base64 && base64.length > 50) {
                    return callback(null, base64);
                }
            } catch (_) {
                // Canvas tainted by CORS — fallback to GM_xmlhttpRequest blob fetch
            }
        }

        // Fallback: Fetch original image data via GM_xmlhttpRequest (bypasses browser CORS).
        // Uses page.fetchUrl (original URL with query params intact) — not the normalised URL.
        const imageFetchUrl = page.fetchUrl || page.url;
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: imageFetchUrl,
                responseType: 'blob',
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300 && res.response) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            const base64 = (reader.result || '').split(',')[1];
                            callback(null, base64);
                        };
                        reader.onerror = () => callback(new Error('FileReader failed to read image blob.'));
                        reader.readAsDataURL(res.response);
                    } else {
                        callback(new Error(`Failed to load image: HTTP ${res.status}`));
                    }
                },
                onerror: () => callback(new Error('Network error downloading page image.')),
                ontimeout: () => callback(new Error('Timed out downloading page image.'))
            });
        } else {
            callback(new Error('GM_xmlhttpRequest is required for cross-origin image extraction.'));
        }
    }

    // -------------------------------------------------------------
    // REQUEST DISPATCH (shared by queue and single-page translate)
    //
    // Sets QUEUE.requestActive = true before dispatch.
    // Clears it only inside every exit path of onload/onerror/ontimeout.
    // Calls onDone(success) when complete.
    // -------------------------------------------------------------
    function dispatchTranslateRequest(page, onDone) {
        // Acquire request lock
        QUEUE.requestActive = true;
        QUEUE.currentPageId = page.id;
        page.status = 'translating';
        updateUI();

        convertImageToBase64(page, (err, base64Data) => {
            if (err || !base64Data) {
                page.status = 'failed';
                QUEUE.requestActive = false;
                QUEUE.currentPageId = null;
                updateUI();
                if (onDone) onDone(false, err ? err.message : 'No image data');
                return;
            }

            const endpoint = CONFIG.serverUrl.replace(/\/+$/, '') + '/translate';
            const payload = {
                filename: `page_${page.id}.jpg`,
                image_base64: base64Data
            };

            const releaseAndDone = (success, reason) => {
                QUEUE.requestActive = false;
                QUEUE.currentPageId = null;
                updateUI();
                if (onDone) onDone(success, reason);
            };

            const requestOptions = {
                method: 'POST',
                url: endpoint,
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': CONFIG.apiKey
                },
                data: JSON.stringify(payload),
                timeout: 300000, // 5 min timeout for OCR & NLLB processing
                onload: (response) => {
                    if (response.status === 200) {
                        try {
                            const data = JSON.parse(response.responseText);
                            if (data.status === 'success' && data.result) {
                                page.status = 'completed';
                                page.result = data.result;
                                STATE.lastResult = data.result;
                                // Accumulate result — always preserved; never overwritten
                                const existing = STATE.allResults.findIndex(r => r.pageId === page.id);
                                const entry = {
                                    pageIndex: STATE.discoveredPages.indexOf(page),
                                    pageId: page.id,
                                    result: data.result
                                };
                                if (existing >= 0) {
                                    STATE.allResults[existing] = entry;
                                } else {
                                    STATE.allResults.push(entry);
                                    STATE.allResults.sort((a, b) => a.pageIndex - b.pageIndex);
                                }
                                releaseAndDone(true);
                            } else {
                                page.status = 'failed';
                                releaseAndDone(false, data.error || 'Server returned non-success status');
                            }
                        } catch (e) {
                            page.status = 'failed';
                            releaseAndDone(false, 'Failed to parse server JSON response');
                        }
                    } else {
                        page.status = 'failed';
                        releaseAndDone(false, `HTTP ${response.status}`);
                    }
                },
                onerror: () => {
                    page.status = 'failed';
                    releaseAndDone(false, 'Network error reaching translation server');
                },
                ontimeout: () => {
                    page.status = 'failed';
                    releaseAndDone(false, 'Request timed out after 5 minutes');
                }
            };

            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest(requestOptions);
            } else {
                fetch(endpoint, {
                    method: 'POST',
                    headers: requestOptions.headers,
                    body: requestOptions.data
                })
                    .then(r => r.json())
                    .then(data => {
                        if (data.status === 'success' && data.result) {
                            page.status = 'completed';
                            page.result = data.result;
                            STATE.lastResult = data.result;
                            const existing = STATE.allResults.findIndex(r => r.pageId === page.id);
                            const entry = {
                                pageIndex: STATE.discoveredPages.indexOf(page),
                                pageId: page.id,
                                result: data.result
                            };
                            if (existing >= 0) {
                                STATE.allResults[existing] = entry;
                            } else {
                                STATE.allResults.push(entry);
                                STATE.allResults.sort((a, b) => a.pageIndex - b.pageIndex);
                            }
                            releaseAndDone(true);
                        } else {
                            page.status = 'failed';
                            releaseAndDone(false, data.error || 'Non-success from server');
                        }
                    })
                    .catch(() => {
                        page.status = 'failed';
                        releaseAndDone(false, 'fetch() error');
                    });
            }
        });
    }

    // -------------------------------------------------------------
    // SINGLE-PAGE TRANSLATE (manual button)
    //
    // Blocked while QUEUE.requestActive is true (request lock).
    // Does NOT modify QUEUE.isRunning so it is queue-neutral.
    // -------------------------------------------------------------
    function translateSinglePage(page) {
        if (!CONFIG.apiKey) {
            alert('Please configure your private Server Key in the Settings tab first.');
            STATE.activeTab = 'settings';
            updateUI();
            return;
        }

        // Block if any request is in flight (queue or another single-page call)
        if (QUEUE.requestActive) {
            alert('A translation is already in progress. Please wait for it to finish.');
            return;
        }

        // Block if the chapter queue is running (even if currently paused between pages)
        if (QUEUE.isRunning) {
            alert('The chapter queue is active. Pause or stop the queue before translating a single page.');
            return;
        }

        dispatchTranslateRequest(page, (success, reason) => {
            if (!success) {
                alert(`Translation failed: ${reason}`);
            } else {
                STATE.activeTab = 'results';
            }
            updateUI();
        });
    }

    // -------------------------------------------------------------
    // CHAPTER QUEUE — ASYNC LOOP
    //
    // Uses an iterative async loop (not recursive) to process pages
    // in natural reading order, one at a time.
    //
    // Loop invariants:
    //   - processNextPage() is called only when QUEUE.requestActive is false.
    //   - Each iteration: find next eligible page, dispatch, await completion.
    //   - Pause/stop flags are checked BEFORE dispatching the next page.
    //   - The current in-flight request always runs to completion.
    // -------------------------------------------------------------
    function findNextEligiblePage() {
        for (let i = 0; i < STATE.discoveredPages.length; i++) {
            const page = STATE.discoveredPages[i];
            // Skip already-completed, skipped, and protected canvas pages
            if (page.status === 'completed' || page.status === 'canvas_protected') continue;
            // In 'selected' mode, skip unselected pages (mark as skipped)
            if (QUEUE.mode === 'selected' && !page.selected) continue;
            // Only process pages that are waiting
            if (page.status === 'waiting') return page;
        }
        return null;
    }

    async function runQueueLoop() {
        // Guard: only one loop instance may run at a time
        if (QUEUE.isRunning) return;
        QUEUE.isRunning = true;
        QUEUE.isStopped = false;

        updateUI();

        // Iterative loop — no unbounded recursion
        while (true) {
            // Check stop flag before looking for next page
            if (QUEUE.isStopped) {
                break;
            }

            // Check pause flag before dispatching next page
            if (QUEUE.isPaused) {
                // Stay in loop but yield; wait for resumeQueue() to clear the flag
                await new Promise(resolve => {
                    // Poll every 500 ms until unpaused or stopped
                    const id = setInterval(() => {
                        if (!QUEUE.isPaused || QUEUE.isStopped) {
                            clearInterval(id);
                            resolve();
                        }
                    }, 500);
                });
                // After waking, re-check stop flag
                if (QUEUE.isStopped) break;
            }

            // Safety check: request lock should be free here
            if (QUEUE.requestActive) {
                // This should never happen but protect against it
                await new Promise(resolve => setTimeout(resolve, 200));
                continue;
            }

            const page = findNextEligiblePage();
            if (!page) {
                // No more eligible pages — queue is complete
                break;
            }

            if (!CONFIG.apiKey) {
                QUEUE.isRunning = false;
                QUEUE.isStopped = true;
                updateUI();
                alert('Server key is not configured. Set it in Settings before translating.');
                return;
            }

            // Dispatch the request and wait for it to finish
            await new Promise(resolve => {
                dispatchTranslateRequest(page, (success, reason) => {
                    // Log failure reason but continue the queue to the next page
                    if (!success) {
                        // page.status is already 'failed' — queue will skip it next iteration
                        // No alert in queue mode — user sees badge on page card
                    }
                    resolve();
                });
            });
        }

        // Queue has exited (completed, stopped, or error)
        QUEUE.isRunning = false;
        // Keep isPaused/isStopped as they are so the UI can show the final state
        updateUI();
    }

    // Start queue — 'all' translates all waiting pages; 'selected' only selected ones
    function startQueue(mode) {
        if (QUEUE.requestActive || QUEUE.isRunning) {
            // Silently ignore double-start attempts
            return;
        }
        // Reset stop/pause so a fresh run starts cleanly
        QUEUE.isPaused = false;
        QUEUE.isStopped = false;
        QUEUE.mode = mode || 'all';

        // Mark all canvas_protected and unselected (in 'selected' mode) pages as skipped
        // so the progress counter is accurate
        STATE.discoveredPages.forEach(page => {
            if (page.status === 'canvas_protected') return; // already has its own status
            if (QUEUE.mode === 'selected' && !page.selected && page.status === 'waiting') {
                page.status = 'skipped';
            }
        });

        runQueueLoop();
    }

    function pauseQueue() {
        if (!QUEUE.isRunning) return;
        QUEUE.isPaused = true;
        updateUI();
    }

    function resumeQueue() {
        if (!QUEUE.isRunning) return;
        QUEUE.isPaused = false;
        // The polling interval in runQueueLoop() will detect this and continue
        updateUI();
    }

    function stopQueue() {
        QUEUE.isStopped = true;
        QUEUE.isPaused = false; // Clear pause so the poll loop exits cleanly
        // isRunning will be cleared by the loop itself after the current page finishes
        updateUI();
    }

    function retryFailed() {
        // Retry only pages whose status is 'failed' — regardless of checkbox selection.
        // Never touch completed pages.
        let count = 0;
        STATE.discoveredPages.forEach(page => {
            if (page.status === 'failed') {
                page.status = 'waiting';
                count++;
            }
        });
        if (count === 0) return;
        // Reset skipped state caused by previous 'selected' queue run,
        // so retry works even if the failed pages weren't originally selected
        STATE.discoveredPages.forEach(page => {
            if (page.status === 'skipped') page.status = 'waiting';
        });
        startQueue('all');
    }

    // -------------------------------------------------------------
    // PROGRESS HELPERS
    // -------------------------------------------------------------
    function getQueueProgress() {
        const pages = STATE.discoveredPages;
        const total = pages.filter(p => p.status !== 'canvas_protected').length;
        const completed = pages.filter(p => p.status === 'completed').length;
        const failed = pages.filter(p => p.status === 'failed').length;
        const translating = pages.filter(p => p.status === 'translating').length;
        const waiting = pages.filter(p => p.status === 'waiting').length;
        return { total, completed, failed, translating, waiting };
    }

    function queueStatusLabel() {
        if (QUEUE.requestActive && !QUEUE.isRunning) return '⏳ Translating…';
        if (QUEUE.isRunning && QUEUE.isPaused) return '⏸ Paused';
        if (QUEUE.isRunning) return '▶ Running';
        if (QUEUE.isStopped) return '⛔ Stopped';
        const { completed, total } = getQueueProgress();
        if (total > 0 && completed === total) return '✅ Complete';
        return '';
    }

    // -------------------------------------------------------------
    // MOBILE-FRIENDLY USER INTERFACE (SAFARI STAY ERGONOMICS)
    // -------------------------------------------------------------
    let uiRoot = null;

    function buildStyles() {
        return `
            #stay-mt-bubble {
                position: fixed;
                bottom: 24px;
                right: 20px;
                z-index: 2147483640;
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 10px 16px;
                background: #181a20;
                color: #ffffff;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                font-weight: 600;
                border-radius: 30px;
                border: 1px solid #333a48;
                box-shadow: 0 8px 24px rgba(0,0,0,0.45);
                cursor: pointer;
                user-select: none;
                -webkit-tap-highlight-color: transparent;
                transition: transform 0.15s ease, background 0.15s ease;
            }
            #stay-mt-bubble:active { transform: scale(0.96); }
            #stay-mt-bubble .indicator {
                width: 10px; height: 10px; border-radius: 50%; background: #f43f5e;
            }
            #stay-mt-bubble .indicator.online {
                background: #10b981; box-shadow: 0 0 8px #10b981;
            }
            #stay-mt-drawer {
                position: fixed; bottom: 0; left: 0; right: 0;
                max-height: 82vh; background: #12141a; color: #e2e8f0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                border-top: 1px solid #282f3e; border-radius: 20px 20px 0 0;
                box-shadow: 0 -10px 40px rgba(0,0,0,0.7); z-index: 2147483645;
                display: flex; flex-direction: column;
                transform: translateY(100%);
                transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
            }
            #stay-mt-drawer.open { transform: translateY(0); }
            #stay-mt-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 16px 20px 12px; border-bottom: 1px solid #232936;
            }
            #stay-mt-header h3 {
                margin: 0; font-size: 16px; font-weight: 700; color: #f8fafc;
                display: flex; align-items: center; gap: 8px;
            }
            #stay-mt-close {
                background: none; border: none; color: #94a3b8;
                font-size: 24px; line-height: 1; padding: 4px; cursor: pointer;
            }
            #stay-mt-tabs {
                display: flex; background: #181c24; border-bottom: 1px solid #232936;
            }
            .stay-mt-tab {
                flex: 1; text-align: center; padding: 10px; font-size: 13px;
                font-weight: 600; color: #94a3b8; border-bottom: 2px solid transparent; cursor: pointer;
            }
            .stay-mt-tab.active { color: #38bdf8; border-bottom-color: #38bdf8; }
            #stay-mt-content {
                padding: 16px 20px; overflow-y: auto; flex: 1;
                -webkit-overflow-scrolling: touch;
            }
            .stay-mt-actions {
                display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;
            }
            .stay-mt-actions-row2 {
                display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap;
            }
            .stay-mt-btn {
                flex: 1; padding: 9px 10px; border-radius: 10px; border: none;
                font-size: 12px; font-weight: 600; cursor: pointer;
                display: flex; align-items: center; justify-content: center; gap: 5px;
                transition: opacity 0.15s ease; min-width: 80px;
            }
            .stay-mt-btn:active { opacity: 0.75; }
            .stay-mt-btn:disabled { opacity: 0.35; cursor: default; }
            .stay-mt-btn-primary { background: #0284c7; color: #ffffff; }
            .stay-mt-btn-green { background: #059669; color: #ffffff; }
            .stay-mt-btn-amber { background: #d97706; color: #ffffff; }
            .stay-mt-btn-red { background: #dc2626; color: #ffffff; }
            .stay-mt-btn-secondary { background: #232a36; color: #cbd5e1; }
            .stay-mt-queue-status {
                font-size: 12px; font-weight: 700; color: #38bdf8;
                padding: 6px 10px; background: #1a2030;
                border-radius: 8px; margin-bottom: 10px; display: flex;
                align-items: center; justify-content: space-between; gap: 8px;
            }
            .stay-mt-progress-bar-wrap {
                background: #1a2030; border-radius: 6px; height: 6px;
                overflow: hidden; margin-bottom: 12px;
            }
            .stay-mt-progress-bar {
                height: 100%; background: #0284c7;
                transition: width 0.4s ease;
            }
            .stay-mt-page-card {
                display: flex; align-items: center; gap: 12px; padding: 10px 12px;
                background: #181d26; border-radius: 12px; margin-bottom: 8px;
                border: 1px solid #252d3d;
            }
            .stay-mt-page-card.completed { border-color: #10b981; }
            .stay-mt-page-card.translating { border-color: #f59e0b; }
            .stay-mt-page-card.failed { border-color: #dc2626; }
            .stay-mt-page-thumb {
                width: 48px; height: 64px; background: #0f1217;
                border-radius: 6px; object-fit: cover; border: 1px solid #283142; flex-shrink: 0;
            }
            .stay-mt-page-info { flex: 1; min-width: 0; }
            .stay-mt-page-title {
                font-size: 14px; font-weight: 600; color: #f1f5f9; margin-bottom: 2px;
            }
            .stay-mt-page-meta {
                font-size: 11px; color: #94a3b8; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis;
            }
            .stay-mt-page-badge {
                display: inline-block; padding: 2px 6px; border-radius: 6px;
                font-size: 10px; font-weight: 700; text-transform: uppercase; margin-top: 4px;
            }
            .badge-waiting    { background: #334155; color: #cbd5e1; }
            .badge-translating{ background: #d97706; color: #fff; }
            .badge-completed  { background: #059669; color: #fff; }
            .badge-failed     { background: #dc2626; color: #fff; }
            .badge-skipped    { background: #475569; color: #94a3b8; }
            .badge-protected  { background: #64748b; color: #e2e8f0; }
            .stay-mt-page-action-btn {
                background: #273142; color: #38bdf8; border: none;
                border-radius: 8px; padding: 8px 12px; font-size: 12px;
                font-weight: 600; cursor: pointer; white-space: nowrap; flex-shrink: 0;
            }
            .stay-mt-page-action-btn:disabled { opacity: 0.35; cursor: default; }
            .stay-mt-form-group { margin-bottom: 14px; }
            .stay-mt-form-group label {
                display: block; font-size: 12px; font-weight: 600;
                color: #94a3b8; margin-bottom: 6px;
            }
            .stay-mt-input {
                width: 100%; box-sizing: border-box; padding: 10px 12px;
                background: #181d26; border: 1px solid #2b3547; border-radius: 8px;
                color: #f8fafc; font-size: 13px;
            }
            .stay-mt-results-page-header {
                font-size: 13px; font-weight: 700; color: #38bdf8;
                margin: 14px 0 8px; padding-bottom: 4px;
                border-bottom: 1px solid #232936;
            }
            .stay-mt-passage {
                background: #181d26; border-left: 3px solid #38bdf8;
                padding: 10px 14px; border-radius: 0 10px 10px 0; margin-bottom: 10px;
            }
            .stay-mt-orig { font-size: 12px; color: #94a3b8; margin-bottom: 4px; }
            .stay-mt-trans { font-size: 14px; color: #38bdf8; font-weight: 600; }
            .stay-mt-meta-id { font-size: 10px; color: #64748b; margin-top: 4px; }
            .indicator {
                display: inline-block; width: 10px; height: 10px;
                border-radius: 50%; background: #f43f5e; flex-shrink: 0;
            }
            .indicator.online { background: #10b981; box-shadow: 0 0 8px #10b981; }
        `;
    }

    function createUI() {
        if (uiRoot) return;

        const container = document.createElement('div');
        container.id = 'stay-manhwa-translator-root';

        const styleEl = document.createElement('style');
        styleEl.textContent = buildStyles();
        container.appendChild(styleEl);

        // Floating Bubble
        const bubble = document.createElement('div');
        bubble.id = 'stay-mt-bubble';
        bubble.innerHTML = `
            <span class="indicator ${STATE.serverOnline ? 'online' : ''}"></span>
            <span id="stay-mt-bubble-text">📖 0 Pages</span>
        `;
        bubble.addEventListener('click', () => {
            STATE.panelOpen = !STATE.panelOpen;
            if (STATE.panelOpen) {
                checkServerHealth();
                scanForMangaPages();
            }
            updateUI();
        });
        container.appendChild(bubble);

        // Slide-up Drawer Panel
        const drawer = document.createElement('div');
        drawer.id = 'stay-mt-drawer';
        drawer.innerHTML = `
            <div id="stay-mt-header">
                <h3>📖 Manhwa Translator <span style="font-size:11px;font-weight:400;color:#94a3b8;">(${CONFIG.serverUrl})</span></h3>
                <button id="stay-mt-close">&times;</button>
            </div>
            <div id="stay-mt-tabs">
                <div class="stay-mt-tab ${STATE.activeTab === 'pages' ? 'active' : ''}" data-tab="pages">Pages (<span id="stay-mt-tab-count">0</span>)</div>
                <div class="stay-mt-tab ${STATE.activeTab === 'results' ? 'active' : ''}" data-tab="results">Results</div>
                <div class="stay-mt-tab ${STATE.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</div>
            </div>
            <div id="stay-mt-content"></div>
        `;

        drawer.addEventListener('click', (e) => {
            const target = e.target;
            if (!target) return;

            if (target.id === 'stay-mt-close' || (target.closest && target.closest('#stay-mt-close'))) {
                STATE.panelOpen = false;
                updateUI();
                return;
            }

            const tab = target.closest ? target.closest('.stay-mt-tab') : null;
            if (tab && tab.getAttribute('data-tab')) {
                STATE.activeTab = tab.getAttribute('data-tab');
                updateUI();
                return;
            }
        });

        container.appendChild(drawer);
        document.body.appendChild(container);
        uiRoot = container;

        updateUI();
    }

    function updateUI() {
        if (!uiRoot) return;

        const bubble = uiRoot.querySelector('#stay-mt-bubble');
        const bubbleText = uiRoot.querySelector('#stay-mt-bubble-text');
        const bubbleIndicator = uiRoot.querySelector('#stay-mt-bubble .indicator');
        const drawer = uiRoot.querySelector('#stay-mt-drawer');
        const tabCount = uiRoot.querySelector('#stay-mt-tab-count');
        const content = uiRoot.querySelector('#stay-mt-content');

        // Update bubble text: show queue progress when running
        const { total, completed } = getQueueProgress();
        const count = STATE.discoveredPages.length;
        if (bubbleText) {
            if (QUEUE.isRunning || (total > 0 && completed > 0)) {
                bubbleText.textContent = `📖 ${completed}/${total}`;
            } else {
                bubbleText.textContent = `📖 ${count} Page${count === 1 ? '' : 's'}`;
            }
        }
        if (tabCount) tabCount.textContent = count;

        if (bubbleIndicator) {
            if (STATE.serverOnline) {
                bubbleIndicator.classList.add('online');
            } else {
                bubbleIndicator.classList.remove('online');
            }
        }

        // Toggle Drawer
        if (drawer) {
            if (STATE.panelOpen) {
                drawer.classList.add('open');
            } else {
                drawer.classList.remove('open');
            }
        }

        // Update active tab highlight
        uiRoot.querySelectorAll('.stay-mt-tab').forEach(tab => {
            if (tab.getAttribute('data-tab') === STATE.activeTab) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });

        // Render Tab Contents
        if (STATE.activeTab === 'pages') {
            renderPagesTab(content);
        } else if (STATE.activeTab === 'results') {
            renderResultsTab(content);
        } else if (STATE.activeTab === 'settings') {
            renderSettingsTab(content);
        }
    }

    function renderPagesTab(content) {
        if (!content) return;

        const { total, completed, failed, translating, waiting } = getQueueProgress();
        const queueActive = QUEUE.isRunning || QUEUE.requestActive;
        const statusLabel = queueStatusLabel();
        const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

        // ---- Queue status row ----
        let statusHtml = '';
        if (statusLabel || (QUEUE.isRunning || QUEUE.requestActive)) {
            statusHtml = `
                <div class="stay-mt-queue-status">
                    <span>${statusLabel || '▶ Running'}</span>
                    <span>${completed}/${total} done${failed > 0 ? ` · ${failed} failed` : ''}</span>
                </div>
                <div class="stay-mt-progress-bar-wrap">
                    <div class="stay-mt-progress-bar" style="width:${progressPct}%"></div>
                </div>
            `;
        }

        // ---- Discovery controls ----
        let html = statusHtml + `
            <div class="stay-mt-actions">
                <button class="stay-mt-btn stay-mt-btn-secondary" id="stay-mt-rescan">
                    🔄 Rescan
                </button>
                <button class="stay-mt-btn stay-mt-btn-secondary" id="stay-mt-sel-all">
                    ☑ All
                </button>
                <button class="stay-mt-btn stay-mt-btn-secondary" id="stay-mt-desel-all">
                    ☐ None
                </button>
            </div>
        `;

        // ---- Queue action buttons ----
        // Translate All / Selected — disabled if request active or queue already running
        const canStart = !queueActive;
        // Pause — only when running and not paused
        const canPause = QUEUE.isRunning && !QUEUE.isPaused;
        // Resume — only when running and paused
        const canResume = QUEUE.isRunning && QUEUE.isPaused;
        // Stop — only when queue is running
        const canStop = QUEUE.isRunning;
        // Retry Failed — only when there are failed pages and queue is idle
        const hasFailed = failed > 0;
        const canRetry = hasFailed && !queueActive;

        html += `
            <div class="stay-mt-actions-row2">
                <button class="stay-mt-btn stay-mt-btn-primary" id="stay-mt-translate-all" ${canStart ? '' : 'disabled'}>
                    ▶ All
                </button>
                <button class="stay-mt-btn stay-mt-btn-green" id="stay-mt-translate-sel" ${canStart ? '' : 'disabled'}>
                    ▶ Selected
                </button>
                <button class="stay-mt-btn stay-mt-btn-amber" id="stay-mt-pause" ${canPause ? '' : 'disabled'}>
                    ⏸ Pause
                </button>
                <button class="stay-mt-btn stay-mt-btn-secondary" id="stay-mt-resume" ${canResume ? '' : 'disabled'}>
                    ▶ Resume
                </button>
            </div>
            <div class="stay-mt-actions">
                <button class="stay-mt-btn stay-mt-btn-red" id="stay-mt-stop" ${canStop ? '' : 'disabled'}>
                    ⛔ Stop
                </button>
                <button class="stay-mt-btn stay-mt-btn-secondary" id="stay-mt-retry" ${canRetry ? '' : 'disabled'}>
                    🔁 Retry Failed
                </button>
            </div>
        `;

        // ---- Page list ----
        if (STATE.discoveredPages.length === 0) {
            html += `
                <div style="text-align: center; padding: 40px 20px; color: #94a3b8;">
                    <div style="font-size: 32px; margin-bottom: 10px;">🔍</div>
                    <p>No chapter pages detected yet.</p>
                    <p style="font-size: 12px; color: #64748b;">Scroll the page or tap Rescan.</p>
                </div>
            `;
        } else {
            html += `<div id="stay-mt-page-list">`;
            STATE.discoveredPages.forEach((page, index) => {
                const isActive = (QUEUE.currentPageId === page.id);
                const badgeClass =
                    page.status === 'completed'       ? 'badge-completed' :
                    page.status === 'translating'     ? 'badge-translating' :
                    page.status === 'failed'           ? 'badge-failed' :
                    page.status === 'skipped'          ? 'badge-skipped' :
                    page.status === 'canvas_protected' ? 'badge-protected' : 'badge-waiting';

                const badgeText =
                    page.status === 'completed'       ? '✅ Done' :
                    page.status === 'translating'     ? '⏳ Translating…' :
                    page.status === 'failed'           ? '❌ Failed' :
                    page.status === 'skipped'          ? '⏭ Skipped' :
                    page.status === 'canvas_protected' ? '🔒 DRM Canvas' : '⏳ Waiting';

                // Single-page Translate button: blocked when queue or request is active
                const singleBtnDisabled = queueActive || QUEUE.requestActive;
                const singleBtnLabel =
                    isActive          ? '⏳…' :
                    page.status === 'completed' ? 'View' : 'Translate';

                const thumbSrc = (page.url && !page.url.startsWith('canvas://'))
                    ? page.url : '';

                html += `
                    <div class="stay-mt-page-card ${page.status}" data-page-id="${page.id}">
                        <input type="checkbox" class="stay-mt-page-check" ${page.selected ? 'checked' : ''} style="width:18px;height:18px;">
                        <img class="stay-mt-page-thumb" src="${escapeHtml(thumbSrc)}" onerror="this.style.display='none'">
                        <div class="stay-mt-page-info">
                            <div class="stay-mt-page-title">Page ${index + 1}</div>
                            <div class="stay-mt-page-meta">${page.naturalWidth || page.renderedWidth} × ${page.naturalHeight || page.renderedHeight} px</div>
                            <span class="stay-mt-page-badge ${badgeClass}">${badgeText}</span>
                        </div>
                        <button class="stay-mt-page-action-btn stay-mt-single-translate"
                            ${singleBtnDisabled ? 'disabled' : ''}>
                            ${singleBtnLabel}
                        </button>
                    </div>
                `;
            });
            html += `</div>`;
        }

        content.innerHTML = html;

        // ---- Wire up buttons ----
        content.querySelector('#stay-mt-rescan')?.addEventListener('click', () => {
            scanForMangaPages();
            updateUI();
        });

        content.querySelector('#stay-mt-sel-all')?.addEventListener('click', () => {
            STATE.discoveredPages.forEach(p => p.selected = true);
            updateUI();
        });

        content.querySelector('#stay-mt-desel-all')?.addEventListener('click', () => {
            STATE.discoveredPages.forEach(p => p.selected = false);
            updateUI();
        });

        content.querySelector('#stay-mt-translate-all')?.addEventListener('click', () => {
            if (!canStart) return;
            startQueue('all');
        });

        content.querySelector('#stay-mt-translate-sel')?.addEventListener('click', () => {
            if (!canStart) return;
            startQueue('selected');
        });

        content.querySelector('#stay-mt-pause')?.addEventListener('click', () => {
            if (canPause) pauseQueue();
        });

        content.querySelector('#stay-mt-resume')?.addEventListener('click', () => {
            if (canResume) resumeQueue();
        });

        content.querySelector('#stay-mt-stop')?.addEventListener('click', () => {
            if (canStop) stopQueue();
        });

        content.querySelector('#stay-mt-retry')?.addEventListener('click', () => {
            if (canRetry) retryFailed();
        });

        // ---- Per-page card wiring ----
        content.querySelectorAll('.stay-mt-page-card').forEach(card => {
            const pageId = card.getAttribute('data-page-id');
            const page = STATE.discoveredPages.find(p => p.id === pageId);
            if (!page) return;

            card.querySelector('.stay-mt-page-check')?.addEventListener('change', (e) => {
                page.selected = e.target.checked;
            });

            card.querySelector('.stay-mt-single-translate')?.addEventListener('click', () => {
                if (page.status === 'completed') {
                    // Show this page's result in the results tab
                    STATE.lastResult = page.result;
                    STATE.activeTab = 'results';
                    updateUI();
                } else {
                    translateSinglePage(page);
                }
            });
        });
    }

    function renderResultsTab(content) {
        if (!content) return;

        const hasAny = STATE.allResults.length > 0;

        if (!hasAny) {
            content.innerHTML = `
                <div style="text-align: center; padding: 40px 20px; color: #94a3b8;">
                    <div style="font-size: 32px; margin-bottom: 10px;">💬</div>
                    <p>No translated passages yet.</p>
                    <p style="font-size: 12px; color: #64748b;">Translate pages to view dialogue here.</p>
                </div>
            `;
            return;
        }

        const { completed } = getQueueProgress();
        let html = `
            <div style="margin-bottom: 12px; font-size: 12px; color: #94a3b8;">
                <strong style="color:#f1f5f9;">${STATE.allResults.length} page${STATE.allResults.length === 1 ? '' : 's'}</strong> translated
                ${completed > 0 ? ` · <strong style="color:#10b981;">${completed} complete</strong>` : ''}
            </div>
        `;

        // Render all accumulated results in page reading order
        STATE.allResults.forEach(entry => {
            const pageNum = entry.pageIndex + 1;
            const res = entry.result;
            if (!res) return;

            html += `
                <div class="stay-mt-results-page-header">
                    📄 Page ${pageNum}
                    <span style="font-size:11px;font-weight:400;color:#64748b;">
                        · ${res.source_language || 'auto'} → ${res.target_language || 'english'}
                        · ${res.passage_count || 0} passages
                    </span>
                </div>
            `;

            if (res.passages && res.passages.length > 0) {
                res.passages.forEach(p => {
                    html += `
                        <div class="stay-mt-passage">
                            <div class="stay-mt-orig">${escapeHtml(p.original_text)}</div>
                            <div class="stay-mt-trans">${escapeHtml(p.translated_text || '')}</div>
                            <div class="stay-mt-meta-id">Passage #${p.passage_id} · Region IDs: [${(p.region_ids || []).join(', ')}]</div>
                        </div>
                    `;
                });
            } else {
                html += `<p style="font-size:12px;color:#64748b;padding:0 0 8px 0;">No dialogue passages detected on this page.</p>`;
            }
        });

        // Raw JSON for debugging (collapsed)
        html += `
            <div style="margin-top: 16px;">
                <details style="font-size: 11px; color: #64748b;">
                    <summary style="cursor: pointer;">View Raw JSON (all pages)</summary>
                    <pre style="background: #0d1017; padding: 10px; border-radius: 8px; overflow-x: auto; max-height: 200px; color: #a5b4fc; font-size: 10px;">${escapeHtml(JSON.stringify(STATE.allResults, null, 2))}</pre>
                </details>
            </div>
        `;

        content.innerHTML = html;
    }

    function renderSettingsTab(content) {
        if (!content) return;
        content.innerHTML = `
            <div class="stay-mt-form-group">
                <label>Server Address (iPhone Local Network URL)</label>
                <input type="text" id="stay-mt-cfg-server" class="stay-mt-input" value="${escapeHtml(CONFIG.serverUrl)}">
                <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Must match your Linux laptop IP, e.g. http://192.168.1.110:8765</div>
            </div>
            <div class="stay-mt-form-group">
                <label>Private Server API Key (from .server_key)</label>
                <input type="password" id="stay-mt-cfg-key" class="stay-mt-input" value="${escapeHtml(CONFIG.apiKey)}" placeholder="Enter token from .server_key">
                <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Stored privately in browser extension storage.</div>
            </div>
            <div class="stay-mt-form-group">
                <label>Server Connectivity</label>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="indicator ${STATE.serverOnline ? 'online' : ''}"></span>
                    <span style="font-size: 13px; font-weight: 600; color: ${STATE.serverOnline ? '#10b981' : '#f43f5e'};">
                        ${STATE.serverOnline ? 'Connected (Online)' : 'Offline / Unreachable'}
                    </span>
                    <button class="stay-mt-btn stay-mt-btn-secondary" id="stay-mt-test-conn" style="flex:0; padding:6px 12px; margin-left:auto;">
                        Test
                    </button>
                </div>
            </div>
            <button class="stay-mt-btn stay-mt-btn-primary" id="stay-mt-save-cfg" style="width: 100%; margin-top: 10px;">
                💾 Save Settings
            </button>
        `;

        content.querySelector('#stay-mt-test-conn')?.addEventListener('click', () => {
            const serverInput = content.querySelector('#stay-mt-cfg-server');
            if (serverInput) CONFIG.serverUrl = serverInput.value.trim();
            checkServerHealth((online) => {
                alert(online ? 'Server is online and responding!' : 'Could not connect to server.');
            });
        });

        content.querySelector('#stay-mt-save-cfg')?.addEventListener('click', () => {
            const server = content.querySelector('#stay-mt-cfg-server').value.trim();
            const key = content.querySelector('#stay-mt-cfg-key').value.trim();

            CONFIG.serverUrl = server;
            CONFIG.apiKey = key;

            setStorage('SERVER_URL', server);
            setStorage('API_KEY', key);

            checkServerHealth();
            alert('Settings saved.');
            STATE.activeTab = 'pages';
            updateUI();
        });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // -------------------------------------------------------------
    // INITIALIZATION
    // -------------------------------------------------------------
    function init() {
        createUI();
        setupObservers();

        // Initial scan & health check
        setTimeout(() => {
            checkServerHealth();
            scanForMangaPages();
        }, 800);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
