// Regression test: shared Puppeteer browser must survive concurrent users.
//
// Bug: report-pipeline runs 4 report lanes via Promise.allSettled. The minigame
// lanes finish in seconds and each called closeBrowser() unconditionally, killing
// the module-level shared browser while an app lane was still navigating TapTap.
// Symptoms seen: "Navigating frame was detached", "Requesting main frame too
// early!", "net::ERR_ABORTED", plus a silent fallback to YYB writing wrong links
// into game-cache.json.
//
// Stubs puppeteer-core so this runs offline and deterministically.

const assert = require('assert');

let launchCount = 0;
let closeCount = 0;
const stubBrowser = () => {
  const b = {
    connected: true,
    async close() { closeCount++; b.connected = false; },
    async newPage() { return { async close() {}, isClosed: () => false, on() {}, async goto() {}, async content() { return ''; } }; },
  };
  return b;
};

// Inject the stub before game-cache.js requires puppeteer-core.
const pptrId = require.resolve('puppeteer-core');
require.cache[pptrId] = {
  id: pptrId, filename: pptrId, loaded: true, children: [], paths: [],
  exports: {
    async launch() {
      launchCount++;
      await new Promise(r => setTimeout(r, 30)); // launch is not instant
      return stubBrowser();
    },
  },
};

const gc = require('../game-cache');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('concurrent acquire launches exactly one browser', async () => {
  launchCount = 0; closeCount = 0;
  const [a, b, c] = await Promise.all([gc.acquireBrowser(), gc.acquireBrowser(), gc.acquireBrowser()]);
  assert.strictEqual(launchCount, 1, `expected 1 launch, got ${launchCount}`);
  assert.ok(a === b && b === c, 'all callers must share one browser instance');
  await gc.releaseBrowser(); await gc.releaseBrowser(); await gc.releaseBrowser();
});

test('release by one holder does not close while others still hold it', async () => {
  launchCount = 0; closeCount = 0;
  const browser = await gc.acquireBrowser(); // holder A
  await gc.acquireBrowser();                 // holder B
  await gc.releaseBrowser();                 // A done
  assert.strictEqual(closeCount, 0, 'browser closed while another holder was active');
  assert.ok(browser.connected, 'browser must stay connected for remaining holder');
  await gc.releaseBrowser();                 // B done
  assert.strictEqual(closeCount, 1, 'browser must close once the last holder releases');
});

test('release past zero does not double-close or throw', async () => {
  launchCount = 0; closeCount = 0;
  await gc.acquireBrowser();
  await gc.releaseBrowser();
  await gc.releaseBrowser(); // stray extra release
  await gc.releaseBrowser();
  assert.strictEqual(closeCount, 1, `expected exactly 1 close, got ${closeCount}`);
});

test('acquire after a full close relaunches a working browser', async () => {
  launchCount = 0; closeCount = 0;
  await gc.acquireBrowser();
  await gc.releaseBrowser();
  const b = await gc.acquireBrowser();
  assert.strictEqual(launchCount, 2, 'second acquire must relaunch');
  assert.ok(b.connected, 'relaunched browser must be connected');
  await gc.releaseBrowser();
});

test('closeBrowser force-closes and resets state for shutdown', async () => {
  launchCount = 0; closeCount = 0;
  await gc.acquireBrowser();
  await gc.acquireBrowser();
  await gc.closeBrowser(); // shutdown path ignores outstanding holders
  assert.strictEqual(closeCount, 1, 'closeBrowser must close the browser');
  const b = await gc.acquireBrowser(); // state must not be left poisoned
  assert.ok(b.connected, 'acquire after force close must yield a live browser');
  await gc.releaseBrowser();
  assert.strictEqual(closeCount, 2, 'refcount must have been reset by force close');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
