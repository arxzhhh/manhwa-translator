/**
 * Phase 2 Test Suite — Chapter Translation Queue
 * Tests QUEUE state machine, concurrency lock, pause/resume/stop semantics,
 * retry logic, reading order, result accumulation, and single-page blocking.
 *
 * Run: node test_queue_behaviour.js
 */

'use strict';

// ================================================================
// HARNESS HELPERS
// ================================================================
let passed = 0;
let failed = 0;

function assert(condition, testName, detail) {
    if (condition) {
        console.log(`  [PASS] ${testName}`);
        passed++;
    } else {
        console.error(`  [FAIL] ${testName}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

function section(name) {
    console.log(`\n--- ${name} ---`);
}

// ================================================================
// STUB OUT BROWSER GLOBALS REQUIRED BY THE USERSCRIPT
// ================================================================
global.window = {
    location: { href: 'https://test.manhwasite.com/chapter/1/' },
    scrollY: 0,
    addEventListener: () => {}
};

global.document = {
    body: { appendChild: () => {}, addEventListener: () => {} },
    documentElement: {},
    readyState: 'complete',
    createElement: (tag) => ({
        tagName: tag.toUpperCase(),
        id: '',
        className: '',
        style: {},
        children: [],
        appendChild() {},
        addEventListener() {},
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => 'data:image/jpeg;base64,mock',
        querySelector: () => null,
        querySelectorAll: () => []
    }),
    querySelectorAll: () => [],
    addEventListener: () => {}
};

global.localStorage = { getItem: () => null, setItem: () => {} };
global.GM_getValue = undefined;
global.GM_setValue = undefined;
global.GM_xmlhttpRequest = undefined; // will be replaced per-test
global.FileReader = undefined;
global.MutationObserver = class { observe() {} };

// ================================================================
// QUEUE MODULE (extracted & adapted from stay_manhwa_translator.user.js)
//
// We rebuild the queue logic in isolation to test it without a live browser.
// This mirrors the actual implementation semantics exactly.
// ================================================================

function buildQueueModule(opts) {
    // opts.onDispatch(page, cb) — simulates dispatchTranslateRequest
    // opts.pages — initial page list

    const STATE = {
        discoveredPages: (opts.pages || []).map((p, i) => Object.assign({
            id: 'p' + (i + 1),
            top: (i + 1) * 1000,
            selected: true,
            status: 'waiting',
            result: null,
            fetchUrl: `https://cdn.test.com/page${i + 1}.jpg`,
            url: `https://cdn.test.com/page${i + 1}.jpg`
        }, p)),
        allResults: [],
        serverOnline: false,
        panelOpen: false,
        activeTab: 'pages',
        lastResult: null
    };

    const CONFIG = {
        serverUrl: 'http://192.168.1.110:8765',
        apiKey: 'test-secret-key'
    };

    const QUEUE = {
        isRunning: false,
        isPaused: false,
        isStopped: false,
        requestActive: false,
        currentPageId: null,
        mode: 'all'
    };

    const dispatchLog = []; // record of dispatched page IDs in order

    // Simulated dispatchTranslateRequest — calls opts.onDispatch then
    // handles lock acquisition/release exactly as the real function does.
    function dispatchTranslateRequest(page, onDone) {
        QUEUE.requestActive = true;
        QUEUE.currentPageId = page.id;
        page.status = 'translating';
        dispatchLog.push(page.id);

        opts.onDispatch(page, (success, reason) => {
            QUEUE.requestActive = false;
            QUEUE.currentPageId = null;
            page.status = success ? 'completed' : 'failed';
            if (success && page.resultData) {
                page.result = page.resultData;
                STATE.allResults.push({
                    pageIndex: STATE.discoveredPages.indexOf(page),
                    pageId: page.id,
                    result: page.resultData
                });
                STATE.allResults.sort((a, b) => a.pageIndex - b.pageIndex);
            }
            if (onDone) onDone(success, reason);
        });
    }

    function findNextEligiblePage() {
        for (let i = 0; i < STATE.discoveredPages.length; i++) {
            const page = STATE.discoveredPages[i];
            if (page.status === 'completed' || page.status === 'canvas_protected') continue;
            if (QUEUE.mode === 'selected' && !page.selected) continue;
            if (page.status === 'waiting') return page;
        }
        return null;
    }

    async function runQueueLoop() {
        if (QUEUE.isRunning) return;
        QUEUE.isRunning = true;
        QUEUE.isStopped = false;

        while (true) {
            if (QUEUE.isStopped) break;

            if (QUEUE.isPaused) {
                await new Promise(resolve => {
                    const id = setInterval(() => {
                        if (!QUEUE.isPaused || QUEUE.isStopped) {
                            clearInterval(id);
                            resolve();
                        }
                    }, 20); // fast poll for tests
                });
                if (QUEUE.isStopped) break;
            }

            if (QUEUE.requestActive) {
                await new Promise(resolve => setTimeout(resolve, 10));
                continue;
            }

            const page = findNextEligiblePage();
            if (!page) break;

            if (!CONFIG.apiKey) {
                QUEUE.isRunning = false;
                QUEUE.isStopped = true;
                return;
            }

            await new Promise(resolve => {
                dispatchTranslateRequest(page, () => resolve());
            });
        }

        QUEUE.isRunning = false;
    }

    function startQueue(mode) {
        if (QUEUE.requestActive || QUEUE.isRunning) return;
        QUEUE.isPaused = false;
        QUEUE.isStopped = false;
        QUEUE.mode = mode || 'all';

        STATE.discoveredPages.forEach(page => {
            if (page.status === 'canvas_protected') return;
            if (QUEUE.mode === 'selected' && !page.selected && page.status === 'waiting') {
                page.status = 'skipped';
            }
        });

        return runQueueLoop();
    }

    function pauseQueue() { if (QUEUE.isRunning) QUEUE.isPaused = true; }
    function resumeQueue() { if (QUEUE.isRunning) QUEUE.isPaused = false; }
    function stopQueue() { QUEUE.isStopped = true; QUEUE.isPaused = false; }

    function retryFailed() {
        let count = 0;
        STATE.discoveredPages.forEach(p => {
            if (p.status === 'failed') { p.status = 'waiting'; count++; }
        });
        if (count === 0) return;
        STATE.discoveredPages.forEach(p => {
            if (p.status === 'skipped') p.status = 'waiting';
        });
        return startQueue('all');
    }

    function translateSinglePage(page) {
        if (QUEUE.requestActive || QUEUE.isRunning) return 'blocked';
        QUEUE.requestActive = true;
        QUEUE.currentPageId = page.id;
        page.status = 'translating';
        dispatchLog.push(page.id + '_single');
        opts.onDispatch(page, (success) => {
            QUEUE.requestActive = false;
            QUEUE.currentPageId = null;
            page.status = success ? 'completed' : 'failed';
        });
        return 'started';
    }

    return {
        STATE, CONFIG, QUEUE, dispatchLog,
        startQueue, pauseQueue, resumeQueue, stopQueue, retryFailed,
        translateSinglePage, findNextEligiblePage
    };
}

// Wait helper (ms)
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ================================================================
// TESTS
// ================================================================
async function runTests() {
    console.log('=================================================');
    console.log(' STAY MANHWA TRANSLATOR — PHASE 2 QUEUE TESTS  ');
    console.log('=================================================');

    // ----------------------------------------------------------------
    // TEST 1: Sequential processing — only one at a time
    // ----------------------------------------------------------------
    section('Test 1: Sequential processing (max concurrency = 1)');
    {
        let maxConcurrent = 0;
        let currentConcurrent = 0;
        const orderLog = [];

        const m = buildQueueModule({
            pages: [
                { id: 'p1' }, { id: 'p2' }, { id: 'p3' }
            ],
            onDispatch(page, cb) {
                currentConcurrent++;
                if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
                orderLog.push(page.id);
                setTimeout(() => {
                    currentConcurrent--;
                    cb(true);
                }, 20);
            }
        });

        await m.startQueue('all');
        await wait(200);

        assert(maxConcurrent === 1, 'Never more than 1 concurrent request', `max was ${maxConcurrent}`);
        assert(orderLog.length === 3, 'All 3 pages processed');
    }

    // ----------------------------------------------------------------
    // TEST 2: Reading order — pages processed by ascending top offset
    // ----------------------------------------------------------------
    section('Test 2: Reading order (ascending top offset)');
    {
        const orderLog = [];
        const m = buildQueueModule({
            pages: [
                { id: 'pA', top: 3000 },
                { id: 'pB', top: 500 },
                { id: 'pC', top: 1500 }
            ],
            onDispatch(page, cb) { orderLog.push(page.id); setTimeout(() => cb(true), 10); }
        });
        // Sort pages by top (mirrors scanForMangaPages sort)
        m.STATE.discoveredPages.sort((a, b) => a.top - b.top);

        await m.startQueue('all');
        await wait(200);

        assert(orderLog.join(',') === 'pB,pC,pA',
            'Pages dispatched in ascending top order', `got: ${orderLog.join(',')}`);
    }

    // ----------------------------------------------------------------
    // TEST 3: Pause — current page finishes, next does not start
    // ----------------------------------------------------------------
    section('Test 3: Pause mid-queue');
    {
        const orderLog = [];
        let resolveP1;

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
            onDispatch(page, cb) {
                orderLog.push(page.id);
                if (page.id === 'p1') {
                    // Hold p1 so we can pause before p2 starts
                    resolveP1 = () => cb(true);
                } else {
                    setTimeout(() => cb(true), 10);
                }
            }
        });

        m.startQueue('all');
        await wait(30); // p1 is in flight

        // Pause before p1 finishes
        m.pauseQueue();
        assert(m.QUEUE.isPaused === true, 'isPaused set to true');

        // Complete p1 — queue should not start p2
        resolveP1();
        await wait(60);

        assert(orderLog.includes('p1'), 'p1 ran to completion after pause was set');
        assert(!orderLog.includes('p2'), 'p2 did NOT start while paused');
        assert(m.QUEUE.isRunning === true, 'isRunning still true (loop is waiting)');
        assert(m.QUEUE.requestActive === false, 'requestActive cleared after p1 completed');

        // Resume
        m.resumeQueue();
        await wait(100);

        assert(orderLog.includes('p2'), 'p2 starts after resume');
        assert(orderLog.includes('p3'), 'p3 starts after p2');

        await wait(50);
        assert(m.QUEUE.isRunning === false, 'Queue exits cleanly after all pages done');
    }

    // ----------------------------------------------------------------
    // TEST 4: Resume picks up at next waiting page (skips completed)
    // ----------------------------------------------------------------
    section('Test 4: Resume skips already-completed pages');
    {
        const orderLog = [];
        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
            onDispatch(page, cb) {
                orderLog.push(page.id);
                setTimeout(() => cb(true), 10);
            }
        });

        // Pre-mark p1 as already completed
        m.STATE.discoveredPages[0].status = 'completed';

        await m.startQueue('all');
        await wait(150);

        assert(!orderLog.includes('p1'), 'p1 (already completed) is not re-processed');
        assert(orderLog.includes('p2'), 'p2 is processed');
        assert(orderLog.includes('p3'), 'p3 is processed');
    }

    // ----------------------------------------------------------------
    // TEST 5: Stop — no more pages start after current
    // ----------------------------------------------------------------
    section('Test 5: Stop queue between pages');
    {
        const orderLog = [];
        let resolveP1;

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
            onDispatch(page, cb) {
                orderLog.push(page.id);
                if (page.id === 'p1') {
                    resolveP1 = () => cb(true);
                } else {
                    setTimeout(() => cb(true), 10);
                }
            }
        });

        m.startQueue('all');
        await wait(20); // p1 in flight

        m.stopQueue();
        assert(m.QUEUE.isStopped === true, 'isStopped set to true');
        assert(m.QUEUE.requestActive === true, 'requestActive still true (p1 still in flight)');

        resolveP1();  // complete p1
        await wait(80);

        assert(orderLog.includes('p1'), 'p1 ran to completion');
        assert(!orderLog.includes('p2'), 'p2 did NOT start after stop');
        assert(!orderLog.includes('p3'), 'p3 did NOT start after stop');
        assert(m.QUEUE.isRunning === false, 'isRunning false after stop');
        assert(m.QUEUE.requestActive === false, 'requestActive false after p1 completion');
    }

    // ----------------------------------------------------------------
    // TEST 6: Failed page — queue continues to next page
    // ----------------------------------------------------------------
    section('Test 6: Failed page — queue continues');
    {
        const orderLog = [];
        const statusLog = [];

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
            onDispatch(page, cb) {
                orderLog.push(page.id);
                // p2 fails
                setTimeout(() => cb(page.id !== 'p2'), page.id === 'p2' ? 'Server error' : undefined);
            }
        });

        await m.startQueue('all');
        await wait(200);

        assert(orderLog.includes('p1'), 'p1 processed');
        assert(orderLog.includes('p2'), 'p2 attempted');
        assert(orderLog.includes('p3'), 'p3 processed despite p2 failure');
        assert(m.STATE.discoveredPages[1].status === 'failed', 'p2 status is failed');
        assert(m.STATE.discoveredPages[2].status === 'completed', 'p3 status is completed');
    }

    // ----------------------------------------------------------------
    // TEST 7: Retry Failed — only failed pages reset, completed untouched
    // ----------------------------------------------------------------
    section('Test 7: Retry Failed — only failed pages, never completed');
    {
        const dispatchCount = { p1: 0, p2: 0, p3: 0 };

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
            onDispatch(page, cb) {
                dispatchCount[page.id] = (dispatchCount[page.id] || 0) + 1;
                // p2 always fails
                setTimeout(() => cb(page.id !== 'p2'), 10);
            }
        });

        // First run
        await m.startQueue('all');
        await wait(200);

        assert(m.STATE.discoveredPages[1].status === 'failed', 'p2 failed after first run');
        assert(m.STATE.discoveredPages[0].status === 'completed', 'p1 completed after first run');
        assert(m.STATE.discoveredPages[2].status === 'completed', 'p3 completed after first run');

        // Retry
        await m.retryFailed();
        await wait(200);

        assert(dispatchCount['p1'] === 1, 'p1 dispatched exactly once (not retried)');
        assert(dispatchCount['p2'] === 2, 'p2 dispatched twice (retried)');
        assert(dispatchCount['p3'] === 1, 'p3 dispatched exactly once (not retried)');
    }

    // ----------------------------------------------------------------
    // TEST 8: Duplicate start prevention
    // ----------------------------------------------------------------
    section('Test 8: Duplicate start prevention');
    {
        let startCount = 0;

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }],
            onDispatch(page, cb) {
                startCount++;
                setTimeout(() => cb(true), 50);
            }
        });

        // Call startQueue twice in the same tick
        const r1 = m.startQueue('all');
        const r2 = m.startQueue('all');  // should be silently ignored

        await wait(300);

        assert(m.QUEUE.isRunning === false, 'Queue finishes normally');
        assert(startCount === 2, 'Only 2 dispatches (p1+p2), not 4', `dispatches: ${startCount}`);
    }

    // ----------------------------------------------------------------
    // TEST 9: Results accumulated for all completed pages in order
    // ----------------------------------------------------------------
    section('Test 9: Results accumulated in reading order');
    {
        const mockResult = (n) => ({ passages: [{ passage_id: n, original_text: 'Text', translated_text: 'Translation' }] });

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
            onDispatch(page, cb) {
                page.resultData = mockResult(parseInt(page.id.slice(1)));
                setTimeout(() => cb(true), 10);
            }
        });

        await m.startQueue('all');
        await wait(200);

        const results = m.STATE.allResults;
        assert(results.length === 3, '3 results accumulated');
        assert(results[0].pageIndex === 0, 'First result is page index 0');
        assert(results[1].pageIndex === 1, 'Second result is page index 1');
        assert(results[2].pageIndex === 2, 'Third result is page index 2');
        assert(results[0].result.passages[0].passage_id === 1, 'Page 1 result preserved correctly');
    }

    // ----------------------------------------------------------------
    // TEST 10: Single-page translate blocked while queue running
    // ----------------------------------------------------------------
    section('Test 10: Single-page translate blocked during queue');
    {
        let resolveP1;

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }],
            onDispatch(page, cb) {
                if (page.id === 'p1') { resolveP1 = () => cb(true); }
                else { setTimeout(() => cb(true), 10); }
            }
        });

        m.startQueue('all');
        await wait(20); // p1 in flight

        // Attempt single-page translate while queue is running
        const result = m.translateSinglePage(m.STATE.discoveredPages[1]);
        assert(result === 'blocked', 'Single-page translate blocked while queue is running');
        assert(m.QUEUE.requestActive === true, 'requestActive remains true during queue');

        resolveP1();
        await wait(100);
    }

    // ----------------------------------------------------------------
    // TEST 11: Single-page translate blocked while request in flight
    // ----------------------------------------------------------------
    section('Test 11: Single-page translate blocked while request active (non-queue)');
    {
        let resolveFirst;

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }],
            onDispatch(page, cb) {
                if (page.id === 'p1_single') {
                    resolveFirst = () => cb(true);
                } else {
                    setTimeout(() => cb(true), 10);
                }
            }
        });

        // Start a manual single-page translate for p1
        m.STATE.discoveredPages[0].id = 'p1_single';
        m.translateSinglePage(m.STATE.discoveredPages[0]);
        await wait(10);

        assert(m.QUEUE.requestActive === true, 'requestActive true during single-page request');
        assert(m.QUEUE.isRunning === false, 'isRunning false (queue not started)');

        // Attempt a second single-page translate while first is in flight
        const result2 = m.translateSinglePage(m.STATE.discoveredPages[1]);
        assert(result2 === 'blocked', 'Second single-page translate blocked (request lock active)');

        resolveFirst();
        await wait(50);

        assert(m.QUEUE.requestActive === false, 'requestActive cleared after request completes');
    }

    // ----------------------------------------------------------------
    // TEST 12: Translate Selected — only selected pages processed
    // ----------------------------------------------------------------
    section('Test 12: Translate Selected — respects selection');
    {
        const orderLog = [];

        const m = buildQueueModule({
            pages: [
                { id: 'p1', selected: true },
                { id: 'p2', selected: false },   // not selected
                { id: 'p3', selected: true }
            ],
            onDispatch(page, cb) {
                orderLog.push(page.id);
                setTimeout(() => cb(true), 10);
            }
        });

        await m.startQueue('selected');
        await wait(200);

        assert(orderLog.includes('p1'), 'p1 (selected) processed');
        assert(!orderLog.includes('p2'), 'p2 (not selected) skipped');
        assert(orderLog.includes('p3'), 'p3 (selected) processed');
        assert(m.STATE.discoveredPages[1].status === 'skipped', 'p2 status is skipped');
    }

    // ----------------------------------------------------------------
    // TEST 13: Stop cannot start new request while one is in flight
    // ----------------------------------------------------------------
    section('Test 13: Stop cannot prematurely release request lock');
    {
        let resolveP1;

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }],
            onDispatch(page, cb) {
                if (page.id === 'p1') { resolveP1 = () => cb(true); }
                else { setTimeout(() => cb(true), 10); }
            }
        });

        m.startQueue('all');
        await wait(20);

        m.stopQueue();
        // Even after stop, p1 should still be in flight
        assert(m.QUEUE.requestActive === true, 'requestActive true despite stop — p1 still in flight');
        assert(m.QUEUE.isStopped === true, 'isStopped set');

        resolveP1();
        await wait(80);

        assert(m.QUEUE.requestActive === false, 'requestActive cleared after p1 finishes');
        assert(m.QUEUE.isRunning === false, 'isRunning false after stop+complete');
        assert(m.STATE.discoveredPages[1].status === 'waiting', 'p2 never started (still waiting)');
    }

    // ----------------------------------------------------------------
    // TEST 14: Pause sets lock correctly — requestActive cleared after page
    // ----------------------------------------------------------------
    section('Test 14: Pause — requestActive cleared between pages');
    {
        let resolveP1;

        const m = buildQueueModule({
            pages: [{ id: 'p1' }, { id: 'p2' }],
            onDispatch(page, cb) {
                if (page.id === 'p1') { resolveP1 = () => cb(true); }
                else { setTimeout(() => cb(true), 10); }
            }
        });

        m.startQueue('all');
        await wait(20);

        m.pauseQueue();
        resolveP1();
        await wait(80);

        // After p1 finishes, queue is paused. requestActive must be false.
        assert(m.QUEUE.requestActive === false, 'requestActive false when paused between pages');
        assert(m.QUEUE.isPaused === true, 'isPaused true');
        assert(m.STATE.discoveredPages[1].status === 'waiting', 'p2 not started while paused');

        // Now resume and let it finish
        m.resumeQueue();
        await wait(100);
        assert(m.STATE.discoveredPages[1].status === 'completed', 'p2 completes after resume');
    }

    // ----------------------------------------------------------------
    // PRINT RESULTS
    // ----------------------------------------------------------------
    console.log('\n=================================================');
    console.log(` RESULTS: ${passed} passed, ${failed} failed`);
    console.log('=================================================\n');

    process.exit(failed === 0 ? 0 : 1);
}

runTests().catch(err => {
    console.error('Unexpected test error:', err);
    process.exit(1);
});
