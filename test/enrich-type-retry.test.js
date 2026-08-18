// Regression test: a cached entry whose type is '-' must be retried.
//
// Bug: enrichGames treated any entry with a link as a complete cache hit
// (`if (cached?.link)`), ignoring type. When a search found the link but tag
// extraction came back empty, `{ link, type: '-' }` was written to the cache and
// every later run hit it — so the card showed 类型 "-" forever and never retried.
// Seen on 梦幻西游：再续前缘 in the 2026-08-14 scheduled run.
//
// The retry must NOT drop the cached link: if the retry search also fails, a
// still-clickable game name with type '-' beats losing the link too.
//
// Runs offline: searchFn is injected and the cache path is redirected to tmp/.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Redirect the cache file BEFORE game-cache.js reads config, so saveCache()
// never touches the real game-cache.json. Real config is loaded first so that
// dotenv still runs (the Anthropic client is constructed at module load).
const realConfig = require('../config');
const TMP_CACHE = path.join(__dirname, '..', 'tmp', 'test-enrich-cache.json');
require.cache[require.resolve('../config')].exports = Object.freeze({
  ...realConfig,
  GAME_CACHE_PATH: TMP_CACHE,
});

const gc = require('../game-cache');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Records every name handed to the search layer so tests can assert on retries.
function spy(impl) {
  const calls = [];
  const fn = async (name) => { calls.push(name); return impl ? impl(name) : null; };
  fn.calls = calls;
  return fn;
}

const FULL = { link: 'https://www.taptap.cn/app/1', type: '角色扮演', category: 'app' };
const TYPELESS = { link: 'https://www.taptap.cn/app/2', type: '-', category: 'app' };

test('complete hit (link + type) does not trigger a search', async () => {
  const searchFn = spy();
  const cache = { 'A_app': { ...FULL } };
  const out = await gc.enrichGames([{ name: 'A' }], cache, 'app', { searchFn });
  assert.deepStrictEqual(searchFn.calls, [], 'must not search when cache is complete');
  assert.strictEqual(out[0].type, '角色扮演');
  assert.strictEqual(out[0].link, FULL.link);
});

test("cached link with type '-' is retried and the type gets filled in", async () => {
  const searchFn = spy(async () => ({
    link: 'https://www.taptap.cn/app/2',
    type: '策略',
    raw_type: '策略、战棋',
  }));
  const cache = { 'B_app': { ...TYPELESS } };
  const out = await gc.enrichGames([{ name: 'B' }], cache, 'app', { searchFn });
  assert.deepStrictEqual(searchFn.calls, ['B'], 'a type-less entry must be researched');
  assert.strictEqual(out[0].type, '策略', 'retry result must replace the "-" type');
  assert.strictEqual(cache['B_app'].type, '策略', 'cache must be updated with the new type');
});

test("failed retry keeps the cached link and leaves type as '-'", async () => {
  const searchFn = spy(async () => null); // search fails again
  const cache = { 'C_app': { ...TYPELESS } };
  const out = await gc.enrichGames([{ name: 'C' }], cache, 'app', { searchFn });
  assert.deepStrictEqual(searchFn.calls, ['C']);
  assert.strictEqual(out[0].link, TYPELESS.link, 'cached link must survive a failed retry');
  assert.strictEqual(out[0].type, '-');
  assert.strictEqual(cache['C_app'].link, TYPELESS.link, 'cache link must not be wiped');
});

test('total cache miss behaves as before', async () => {
  const searchFn = spy(async () => ({ link: 'https://www.taptap.cn/app/9', type: '射击' }));
  const cache = {};
  const out = await gc.enrichGames([{ name: 'D' }], cache, 'app', { searchFn });
  assert.deepStrictEqual(searchFn.calls, ['D']);
  assert.strictEqual(out[0].link, 'https://www.taptap.cn/app/9');
  assert.strictEqual(out[0].type, '射击');
  assert.strictEqual(cache['D_app'].type, '射击');
});

test('a miss and a type-less hit are searched in one pass', async () => {
  const searchFn = spy(async (name) => ({
    link: `https://www.taptap.cn/app/${name}`,
    type: name === 'E' ? '休闲' : '卡牌',
  }));
  const cache = { 'F_app': { ...TYPELESS } };
  const out = await gc.enrichGames([{ name: 'E' }, { name: 'F' }], cache, 'app', { searchFn });
  assert.deepStrictEqual(searchFn.calls.sort(), ['E', 'F'], 'both must be searched together');
  assert.strictEqual(out.find(g => g.name === 'E').type, '休闲');
  assert.strictEqual(out.find(g => g.name === 'F').type, '卡牌');
});

test("empty-string and missing type are treated like '-'", async () => {
  const searchFn = spy(async () => ({ link: 'https://www.taptap.cn/app/3', type: '益智' }));
  const cache = {
    'G_app': { link: 'https://www.taptap.cn/app/3', type: '', category: 'app' },
    'H_app': { link: 'https://www.taptap.cn/app/4', category: 'app' }, // type absent
  };
  const out = await gc.enrichGames([{ name: 'G' }, { name: 'H' }], cache, 'app', { searchFn });
  assert.deepStrictEqual(searchFn.calls.sort(), ['G', 'H'], 'blank/absent type must retry too');
  assert.ok(out.every(g => g.type === '益智'));
});

test('officialName from cache is still applied on a type-less retry', async () => {
  // The retry keys off the *incoming* name, but the displayed name should still
  // come from the cached officialName when the retry itself returns none.
  const searchFn = spy(async () => null);
  const cache = {
    'I_app': { link: 'https://www.taptap.cn/app/5', type: '-', category: 'app', officialName: 'I 正式名' },
  };
  const out = await gc.enrichGames([{ name: 'I' }], cache, 'app', { searchFn });
  assert.strictEqual(out[0].name, 'I 正式名', 'cached officialName must not be lost by the retry path');
  assert.strictEqual(out[0].link, 'https://www.taptap.cn/app/5');
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
  try { fs.unlinkSync(TMP_CACHE); } catch {}
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
