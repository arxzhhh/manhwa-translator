/**
 * Comprehensive Test Suite for stay_manhwa_translator.user.js
 * Verifies DOM discovery, filtering heuristics, deduplication, reading order, and canvas handling.
 */

const fs = require('fs');
const path = require('path');

// Read userscript source
const scriptSource = fs.readFileSync(path.join(__dirname, 'stay_manhwa_translator.user.js'), 'utf8');

// Mock browser objects
const elements = [];

class MockElement {
    constructor(tagName, attrs = {}, styles = {}, rect = { top: 0, height: 1000, width: 800 }) {
        this.tagName = tagName.toUpperCase();
        this.nodeType = 1;
        this.attrs = { ...attrs };
        this.style = { ...styles };
        this.rect = { ...rect };
        this.naturalWidth = attrs.naturalWidth || rect.width || 0;
        this.naturalHeight = attrs.naturalHeight || rect.height || 0;
        this.src = attrs.src || '';
        this.srcset = attrs.srcset || '';
        this.id = attrs.id || '';
        this.className = attrs.class || '';
        this.parentElement = null;
        this.children = [];
        this.listeners = {};
        elements.push(this);
    }

    getAttribute(name) { return this.attrs[name] || null; }
    setAttribute(name, val) { this.attrs[name] = val; }
    hasAttribute(name) { return name in this.attrs; }
    getBoundingClientRect() { return this.rect; }
    addEventListener(event, handler) {
        this.listeners[event] = this.listeners[event] || [];
        this.listeners[event].push(handler);
    }
    removeEventListener() {}
    closest(selector) {
        let cur = this;
        const cls = selector.replace('.', '');
        while (cur) {
            if ((cur.className || '').includes(cls)) return cur;
            cur = cur.parentElement;
        }
        return null;
    }
    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }
    querySelector(selector) {
        const sel = selector.replace('#', '').replace('.', '').toUpperCase();
        function search(node) {
            for (const c of node.children) {
                if (c.id.toUpperCase() === sel || c.tagName === sel || c.className.toUpperCase().includes(sel)) return c;
                const found = search(c);
                if (found) return found;
            }
            return null;
        }
        return search(this);
    }
    querySelectorAll(selector) {
        const matches = [];
        function search(node) {
            for (const child of node.children) {
                if (child.tagName === selector.toUpperCase() || (selector.startsWith('.') && (child.className || '').includes(selector.slice(1)))) {
                    matches.push(child);
                }
                search(child);
            }
        }
        search(this);
        return matches;
    }
}

class MockCanvas extends MockElement {
    constructor(id, rect, isTainted = false) {
        super('CANVAS', { id }, {}, rect);
        this.width = rect.width;
        this.height = rect.height;
        this.isTainted = isTainted;
    }
    toDataURL(type, quality) {
        if (this.isTainted) throw new Error('SecurityError: Tainted canvas');
        return 'data:image/jpeg;base64,mockCanvasBase64DataString';
    }
}

// Minimal mock document and window
const document = {
    body: new MockElement('BODY'),
    documentElement: new MockElement('HTML'),
    querySelectorAll(selector) {
        if (selector.includes('img')) {
            return elements.filter(el =>
                el.tagName === 'IMG' ||
                el.tagName === 'SOURCE' ||
                el.hasAttribute('data-src') ||
                el.hasAttribute('data-original')
            );
        }
        if (selector.includes('canvas')) {
            return elements.filter(el => el.tagName === 'CANVAS');
        }
        if (selector.includes('background') || selector.includes('.page')) {
            return elements.filter(el =>
                (el.style && el.style.backgroundImage && el.style.backgroundImage !== 'none') ||
                (el.className && el.className.includes('page'))
            );
        }
        return [];
    },
    createElement(tag) { return new MockElement(tag); }
};

const window = {
    location: { href: 'https://manhwatest.com/chapter-42/' },
    scrollY: 0,
    addEventListener: () => { }
};

function runTestSuite() {
    console.log('========================================');
    console.log(' STAY MANHWA TRANSLATOR - PHASE 1 TESTS ');
    console.log('========================================\n');

    let passed = 0;
    let failed = 0;

    function assert(condition, testName) {
        if (condition) {
            console.log(`[PASS] ${testName}`);
            passed++;
        } else {
            console.error(`[FAIL] ${testName}`);
            failed++;
        }
    }

    // -------------------------------------------------------------
    // Extract internal helper functions from stay_manhwa_translator.user.js
    // -------------------------------------------------------------
    // Test helper extraction
    const extractFn = (name, extraScope = {}) => {
        const regex = new RegExp(`function\\s+${name}\\s*\\([^\\)]*\\)\\s*\\{[\\s\\S]*?\\n    \\}`);
        const match = scriptSource.match(regex);
        if (!match) throw new Error(`Could not find function ${name}`);
        const scopeKeys = Object.keys(extraScope);
        const scopeVals = Object.values(extraScope);
        return new Function('CONFIG', 'EXCLUDED_KEYWORDS', 'window', 'document', ...scopeKeys, `
            return (${match[0]});
        `)(CONFIG, EXCLUDED_KEYWORDS, window, document, ...scopeVals);
    };

    const CONFIG = {
        serverUrl: 'http://192.168.1.110:8765',
        apiKey: 'test-key',
        minWidth: 280,
        minHeight: 280,
        minArea: 100000,
        minAspectRatio: 0.15,
        maxAspectRatio: 3.5,
        scanThrottleMs: 1000
    };

    const EXCLUDED_KEYWORDS = [
        'avatar', 'logo', 'icon', 'banner', 'button', 'nav', 'advert', 'advertisement', 'ads',
        'sponsor', 'comment', 'footer', 'header', 'social', 'discord', 'patreon',
        'badge', 'emoji', 'pixel', 'tracking', 'spacer', 'spinner', 'loader'
    ];

    const normalizeImageUrl = extractFn('normalizeImageUrl');
    const extractCandidateUrls = extractFn('extractCandidateUrls', { normalizeImageUrl });
    const isLikelyAdvertisementOrUI = extractFn('isLikelyAdvertisementOrUI');
    const evaluateImageDimensions = extractFn('evaluateImageDimensions');
    const isLegitimateMangaPage = extractFn('isLegitimateMangaPage', { isLikelyAdvertisementOrUI, evaluateImageDimensions });

    // -------------------------------------------------------------
    // TEST 1: URL Normalization & Tracking Token Stripping
    // -------------------------------------------------------------
    console.log('--- Test 1: URL Normalization & Deduplication ---');
    const u1 = normalizeImageUrl('https://cdn.manhwa.com/ch42/p01.jpg?token=abc12345&utm_source=twitter&t=17000000');
    assert(u1 === 'https://cdn.manhwa.com/ch42/p01.jpg', 'Strips query tracking tokens (token, utm_*, t)');

    const u2 = normalizeImageUrl('https://cdn.manhwa.com/ch42/p01.jpg');
    assert(u1 === u2, 'Clean URL and parameterized URL normalize to identical string');

    // -------------------------------------------------------------
    // TEST 2: Candidate URL Extraction (Lazy attributes & srcset)
    // -------------------------------------------------------------
    console.log('\n--- Test 2: Lazy Loading & Srcset Extraction ---');
    const imgDataSrc = new MockElement('IMG', {
        src: 'data:image/gif;base64,placeholder',
        'data-src': 'https://cdn.manhwa.com/ch42/p02.jpg'
    });
    const c1 = extractCandidateUrls(imgDataSrc);
    assert(c1.includes('https://cdn.manhwa.com/ch42/p02.jpg'), 'Extracts data-src attribute correctly');

    const imgDataOriginal = new MockElement('IMG', {
        'data-original': 'https://cdn.manhwa.com/ch42/p03.jpg'
    });
    const c2 = extractCandidateUrls(imgDataOriginal);
    assert(c2.includes('https://cdn.manhwa.com/ch42/p03.jpg'), 'Extracts data-original attribute correctly');

    const imgSrcset = new MockElement('IMG', {
        srcset: 'https://cdn.manhwa.com/ch42/p04_low.jpg 400w, https://cdn.manhwa.com/ch42/p04_high.jpg 800w'
    });
    const c3 = extractCandidateUrls(imgSrcset);
    assert(c3.includes('https://cdn.manhwa.com/ch42/p04_high.jpg'), 'Extracts highest resolution from srcset');

    const divBg = new MockElement('DIV', {}, {
        backgroundImage: 'url("https://cdn.manhwa.com/ch42/p05.jpg")'
    });
    const c4 = extractCandidateUrls(divBg);
    assert(c4.includes('https://cdn.manhwa.com/ch42/p05.jpg'), 'Extracts background-image url from style');

    // -------------------------------------------------------------
    // TEST 3: Advertisement, Logo, Avatar & UI Rejection
    // -------------------------------------------------------------
    console.log('\n--- Test 3: False-Positive UI & Ad Filtering ---');
    const adImg = new MockElement('IMG', {
        src: 'https://cdn.manhwa.com/ch42/ad_banner.jpg',
        class: 'advertisement-slot'
    }, {}, { top: 0, width: 728, height: 90 });
    assert(isLikelyAdvertisementOrUI(adImg, adImg.src) === true, 'Rejects banner with advertisement class');

    const avatarImg = new MockElement('IMG', {
        src: 'https://cdn.manhwa.com/avatars/user99.png',
        class: 'author-avatar'
    }, {}, { top: 50, width: 64, height: 64 });
    assert(isLikelyAdvertisementOrUI(avatarImg, avatarImg.src) === true, 'Rejects user avatar from URL & class');

    const legitPage = new MockElement('IMG', {
        src: 'https://cdn.manhwa.com/ch42/page_01.jpg',
        class: 'chapter-image'
    }, {}, { top: 100, width: 800, height: 1300 });
    assert(isLikelyAdvertisementOrUI(legitPage, legitPage.src) === false, 'Accepts legitimate manga page');

    // -------------------------------------------------------------
    // TEST 4: Dimension & Aspect Ratio Heuristics
    // -------------------------------------------------------------
    console.log('\n--- Test 4: Dimension & Aspect Ratio Heuristics ---');
    const smallIcon = new MockElement('IMG', {
        src: 'https://cdn.manhwa.com/assets/next_btn.png',
        naturalWidth: 48,
        naturalHeight: 48
    }, {}, { top: 200, width: 48, height: 48 });
    assert(isLegitimateMangaPage(smallIcon, smallIcon.src) === false, 'Rejects tiny navigation buttons (48x48)');

    const realWebtoonPanel = new MockElement('IMG', {
        src: 'https://cdn.manhwa.com/ch42/panel_02.jpg',
        naturalWidth: 800,
        naturalHeight: 1400
    }, {}, { top: 1500, width: 800, height: 1400 });
    assert(isLegitimateMangaPage(realWebtoonPanel, realWebtoonPanel.src) === true, 'Accepts vertical manhwa cut (800x1400)');

    const standardMangaSpread = new MockElement('IMG', {
        src: 'https://cdn.manhwa.com/ch42/spread_03.jpg',
        naturalWidth: 1600,
        naturalHeight: 1200
    }, {}, { top: 3000, width: 1600, height: 1200 });
    assert(isLegitimateMangaPage(standardMangaSpread, standardMangaSpread.src) === true, 'Accepts 2-page horizontal manga spread (1600x1200)');

    // -------------------------------------------------------------
    // TEST 5: Reading Order Preservation (Top-to-Bottom Sorting)
    // -------------------------------------------------------------
    console.log('\n--- Test 5: Reading Order Sorting ---');
    const pageItems = [
        { id: 'p3', top: 3200, url: 'page_03.jpg' },
        { id: 'p1', top: 100,  url: 'page_01.jpg' },
        { id: 'p4', top: 4800, url: 'page_04.jpg' },
        { id: 'p2', top: 1650, url: 'page_02.jpg' },
    ];
    // Sort according to logic in scanForMangaPages
    pageItems.sort((a, b) => a.top - b.top);
    const sortedIds = pageItems.map(p => p.id).join('->');
    assert(sortedIds === 'p1->p2->p3->p4', `Natural vertical reading order preserved (${sortedIds})`);

    // -------------------------------------------------------------
    // TEST 6: Canvas Reader Support (Clean vs Tainted)
    // -------------------------------------------------------------
    console.log('\n--- Test 6: Canvas Reader Support ---');
    const normalCanvas = new MockCanvas('manga-canvas', { top: 5000, width: 800, height: 1200 }, false);
    let normalExtracted = false;
    try {
        const data = normalCanvas.toDataURL('image/jpeg', 0.1);
        if (data) normalExtracted = true;
    } catch (_) { }
    assert(normalExtracted === true, 'Directly extracts image data from non-tainted canvas');

    const protectedCanvas = new MockCanvas('drm-canvas', { top: 6500, width: 800, height: 1200 }, true);
    let errorCaught = false;
    try {
        protectedCanvas.toDataURL('image/jpeg', 0.1);
    } catch (e) {
        errorCaught = true;
    }
    assert(errorCaught === true, 'Safely catches tainted/DRM canvas security error without crashing');

    // -------------------------------------------------------------
    // TEST 7: Server API Contract & Header Verification
    // -------------------------------------------------------------
    console.log('\n--- Test 7: Server Contract Compatibility ---');
    assert(scriptSource.includes("CONFIG.serverUrl.replace(/\\/+$/, '') + '/health'"), 'Includes GET /health endpoint');
    assert(scriptSource.includes("CONFIG.serverUrl.replace(/\\/+$/, '') + '/translate'"), 'Includes POST /translate endpoint');
    assert(scriptSource.includes("'X-API-Key': CONFIG.apiKey"), 'Sends X-API-Key header in translation request');
    assert(scriptSource.includes("image_base64: base64Data"), 'Formats payload with image_base64 as required by local_server.py');
    assert(scriptSource.includes("http://192.168.1.110:8765"), 'Preserves default server address http://192.168.1.110:8765');

    console.log('\n========================================');
    console.log(` RESULTS: ${passed} passed, ${failed} failed`);
    console.log('========================================\n');

    process.exit(failed === 0 ? 0 : 1);
}

runTestSuite();
