const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const Anthropic = require('@anthropic-ai/sdk').default;
const puppeteer = require('puppeteer-core');

const llmClient = new Anthropic();

let tagDict = null;
let tagDictPromise = null;

async function loadTagDictionary() {
  if (tagDict) return tagDict;
  if (tagDictPromise) return tagDictPromise;
  tagDictPromise = (async () => {
    try {
      const mappings = await db.getTagMappings();
      tagDict = new Map();
      for (const { raw_type, norm_type } of mappings) {
        if (!tagDict.has(raw_type)) tagDict.set(raw_type, norm_type);
      }
      console.log(`[GameCache] 标签字典已加载: ${tagDict.size} 条映射`);
    } catch {
      return new Map();
    }
    return tagDict;
  })().finally(() => { tagDictPromise = null; });
  return tagDictPromise;
}

function buildFewShotExamples(dict, maxExamples = 10) {
  const examples = [];
  for (const [raw, norm] of dict) {
    if (examples.length >= maxExamples) break;
    examples.push(`原始标签：${raw} → 归一化：${norm}`);
  }
  return examples.length ? `\n\n以下是历史归一化示例：\n${examples.join('\n')}` : '';
}

function loadCache() {
  try {
    const raw = fs.readFileSync(config.GAME_CACHE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveCache(cache) {
  const tmpPath = config.GAME_CACHE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf-8');
  fs.renameSync(tmpPath, config.GAME_CACHE_PATH);
}

const stripPunct = s => s.replace(/[：:\-—–·・･、,.\s]+/g, '');

const GAME_NAME_ALIASES = {
  '代号：超自然': '超自然行动组',
  '代号:超自然': '超自然行动组',
  '消的有点菜': '玩的有点菜',
  '消得有点菜': '玩的有点菜',
};

function cacheKey(name, category) {
  return category ? `${name}_${category}` : name;
}

function cacheLookup(cache, name, category) {
  // When category is specified, only use composite key — no fallback to bare name
  // (bare name may hold a different platform's link, e.g. wx link for a minigame)
  if (category) return cache[cacheKey(name, category)] || null;
  return cache[name] || null;
}

async function searchGameFromYYB(gameName) {
  try {
    const searchName = gameName.replace(/小游戏$/, '');
    const searchUrl = 'https://sj.qq.com/search?q=' + encodeURIComponent(searchName);
    const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
    if (!searchResp.ok) return null;
    const searchHtml = await searchResp.text();

    const blockRe = /<a[^>]+href="(\/appdetail\/(wx[^"]+))"[^>]*>[\s\S]*?<\/a>/gi;
    const nameNorm = stripPunct(searchName);
    if (!nameNorm) return null;
    let detailPath = null;
    let officialName = null;
    let match;
    while ((match = blockRe.exec(searchHtml)) !== null) {
      const textOnly = stripPunct(match[0].replace(/<[^>]+>/g, ''));
      if (textOnly.includes(nameNorm)) {
        detailPath = match[1];
        const nameMatch = match[0].match(/<[^>]+class="[^"]*name[^"]*"[^>]*>([^<]+)/i);
        if (nameMatch) officialName = nameMatch[1].trim();
        break;
      }
    }
    if (!detailPath) return null;

    const link = 'https://sj.qq.com' + detailPath;
    let type = '-';
    try {
      const detailResp = await fetch(link, { signal: AbortSignal.timeout(10000) });
      if (detailResp.ok) {
        const detailHtml = await detailResp.text();
        const tags = [...detailHtml.matchAll(/TagList_tagItem[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/g)];
        const first2 = tags.slice(0, 2).map(m => m[1].trim()).filter(Boolean);
        if (first2.length) type = first2.join('、');
      }
    } catch {}

    db.insertGameTag({ game_name: gameName, category: 'minigame', source: 'yyb', link, raw_type: type, norm_type: null }).catch(() => {});
    return { link, type, officialName };
  } catch {
    return null;
  }
}

async function extractTagsFromHtml(html) {
  // Only extract tags before the recommendation section to avoid mixing in other games' tags
  const cutoff = html.search(/你可能还喜欢|相关推荐|厂商其[它他]应用|RelatedApp|RecommendList/i);
  const scope = cutoff > 0 ? html.slice(0, cutoff) : html;
  const tags = [...scope.matchAll(/TagList_tagItem[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/g)];
  const extracted = [...new Set(tags.map(m => m[1].trim()).filter(Boolean))];
  if (extracted.length) return extracted.join('、');
  return null;
}

const NORMALIZE_PROMPT = `你是一个资深游戏运营专家。请将以下游戏的原始类型标签归一化为标准分类。

标准分类列表：角色扮演、策略、休闲、动作冒险、模拟经营、卡牌、射击、MMORPG、SLG、塔防、竞技、捕鱼、益智、养成、二次元、其他

规则：
1. 从标准分类中选择最匹配的 1-2 个，用"、"分隔
2. 优先选择最能体现游戏核心玩法的分类
3. 只返回分类文字，不要解释`;

async function normalizeGameType(gameName, rawType) {
  if (!rawType || rawType === '-') return '-';
  const dict = await loadTagDictionary();
  const cached = dict.get(rawType);
  if (cached) return cached;
  try {
    const fewShot = buildFewShotExamples(dict);
    const resp = await llmClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: `${NORMALIZE_PROMPT}${fewShot}\n\n<data>\n游戏名：${gameName}\n原始标签：${rawType}\n</data>` }],
    });
    const text = resp.content.find(b => b.type === 'text')?.text?.trim() || '';
    if (text && text !== '-' && text.length < 30) {
      dict.set(rawType, text);
      return text;
    }
  } catch {}
  return rawType;
}

async function classifyGameType(gameName, pageText) {
  try {
    const resp = await llmClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: `根据以下游戏页面信息，提取游戏"${gameName}"的类型标签，最多4个，用"、"分隔。只返回标签文字，不要解释。如果无法判断返回"-"。\n\n<data>\n${pageText.slice(0, 2000)}\n</data>` }],
    });
    const text = resp.content.find(b => b.type === 'text')?.text?.trim() || '';
    if (text && text !== '-' && text.length < 50) return text;
  } catch {}
  return '-';
}

async function searchAppFromYYB(gameName) {
  try {
    const searchUrl = 'https://sj.qq.com/search?q=' + encodeURIComponent(gameName);
    const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
    if (!searchResp.ok) return null;
    const searchHtml = await searchResp.text();

    // APP games use com.xxx package names
    const blockRe = /<a[^>]+href="(\/appdetail\/(com\.[^"]+))"[^>]*>[\s\S]*?<\/a>/gi;
    const nameNorm = stripPunct(gameName);
    let detailPath = null;
    let officialName = null;
    let match;
    while ((match = blockRe.exec(searchHtml)) !== null) {
      const textOnly = stripPunct(match[0].replace(/<[^>]+>/g, ''));
      if (textOnly.includes(nameNorm)) {
        detailPath = match[1];
        const nameMatch = match[0].match(/<[^>]+class="[^"]*name[^"]*"[^>]*>([^<]+)/i);
        if (nameMatch) officialName = nameMatch[1].trim();
        break;
      }
    }
    if (!detailPath) return null;

    const link = 'https://sj.qq.com' + detailPath;
    let type = '-';
    try {
      const detailResp = await fetch(link, { signal: AbortSignal.timeout(10000) });
      if (detailResp.ok) {
        const detailHtml = await detailResp.text();
        // Verify the detail page app name matches the game name
        const titleMatch = detailHtml.match(/<title[^>]*>([^<]+)/i);
        const rawTitle = titleMatch ? titleMatch[1] : '';
        // Extract app name from title like "无尽冬日世界app-官方正版..." → "无尽冬日世界"
        const appNameMatch = rawTitle.match(/^(.+?)(?:app|APP|-|_|–|—|\s*官方)/);
        const appName = stripPunct(appNameMatch ? appNameMatch[1] : rawTitle);
        if (!appName) return null;
        if (appName !== nameNorm && !appName.includes(nameNorm) && !nameNorm.includes(appName)) return null;

        type = await extractTagsFromHtml(detailHtml) || '-';
        if (type === '-') {
          const pageText = detailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          type = await classifyGameType(gameName, pageText);
        }
      }
    } catch {}

    const rawType = type;
    type = await normalizeGameType(gameName, type);
    db.insertGameTag({ game_name: gameName, category: 'app', source: 'yyb', link, raw_type: rawType, norm_type: type }).catch(() => {});
    return { link, type, raw_type: rawType, officialName };
  } catch {
    return null;
  }
}

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let _browser = null;
let _browserPromise = null;
// Refcount of active holders. The browser is shared across concurrent report
// lanes (report-pipeline runs 4 of them via Promise.allSettled), so it must only
// close once the LAST holder is done — otherwise an in-flight navigation dies
// with "Navigating frame was detached" / "Requesting main frame too early!".
let _browserRefs = 0;

// Acquire the shared browser. Every acquireBrowser() must be paired with a
// releaseBrowser() in a finally block.
async function acquireBrowser() {
  _browserRefs++;
  try {
    if (_browser && _browser.connected) return _browser;
    // Dedupe concurrent launches: without this, parallel first-callers each spawn
    // their own Chrome and clobber _browser, leaking orphaned processes.
    if (!_browserPromise) {
      _browserPromise = puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      }).finally(() => { _browserPromise = null; });
    }
    _browser = await _browserPromise;
    return _browser;
  } catch (err) {
    _browserRefs--;
    throw err;
  }
}

async function releaseBrowser() {
  if (_browserRefs === 0) return; // stray release, nothing to do
  _browserRefs--;
  if (_browserRefs > 0) return;
  const browser = _browser;
  _browser = null;
  if (browser) await browser.close().catch(() => {});
}

// Force-close for process shutdown, regardless of outstanding holders.
async function closeBrowser() {
  _browserRefs = 0;
  const browser = _browser;
  _browser = null;
  if (browser) await browser.close().catch(() => {});
}

async function searchAppFromTapTap(gameName) {
  let page;
  let acquired = false;
  try {
    const browser = await acquireBrowser();
    acquired = true;
    page = await browser.newPage();

    let apiData = null;
    const apiPromise = new Promise((resolve) => {
      page.on('response', async (resp) => {
        if (apiData) return;
        const url = resp.url();
        if (url.includes('webapiv2/search') && url.includes('agg-search') && resp.status() === 200) {
          try { apiData = await resp.json(); resolve(apiData); } catch {}
        }
      });
      setTimeout(() => resolve(null), 20000);
    });

    await page.goto(
      `https://www.taptap.cn/search/${encodeURIComponent(gameName)}?type=app`,
      { waitUntil: 'networkidle0', timeout: 20000 },
    );
    await apiPromise;
    await page.close();

    if (!apiData?.data?.list) return null;

    const nameNorm = stripPunct(gameName);
    const apps = [];
    for (const group of apiData.data.list) {
      if (group.app) apps.push(group.app);
      if (Array.isArray(group.list)) {
        for (const item of group.list) {
          if (item.app) apps.push(item.app);
        }
      }
    }

    for (const app of apps) {
      const titleNorm = stripPunct(app.title || '');
      if (!titleNorm.includes(nameNorm) && !nameNorm.includes(titleNorm)) continue;

      const link = `https://www.taptap.cn/app/${app.id}`;
      const officialName = app.title || null;

      // Fetch detail page for full tags (search API only returns 3)
      let rawType = (app.tags || []).map(t => t.value || t.name || t).filter(Boolean).join('、') || '-';
      try {
        const detailPage = await browser.newPage();
        await detailPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const detailHtml = await detailPage.content();
        await detailPage.close();
        const tagRe = /,"([^"]+)","taptap:\/\/taptap\.com\/library\?tag=/g;
        const fullTags = [];
        let tm;
        while ((tm = tagRe.exec(detailHtml)) !== null) fullTags.push(tm[1]);
        if (fullTags.length > 0) rawType = fullTags.join('、');
      } catch {}

      const type = await normalizeGameType(gameName, rawType);
      db.insertGameTag({ game_name: gameName, category: 'app', source: 'taptap', link, raw_type: rawType, norm_type: type }).catch(() => {});
      return { link, type, raw_type: rawType, officialName };
    }
    return null;
  } catch (err) {
    console.warn('[GameCache] TapTap Puppeteer 搜索失败:', err.message);
    if (page && !page.isClosed()) await page.close().catch(() => {});
    return null;
  } finally {
    if (acquired) await releaseBrowser();
  }
}

async function searchAppFromAppStore(gameName) {
  try {
    const url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(gameName) + '&country=cn&entity=software&limit=5';
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.results || data.results.length === 0) return null;

    const nameNorm = stripPunct(gameName);
    // Find exact name match first
    let found = data.results.find(r => {
      const rName = stripPunct(r.trackName);
      return rName.includes(nameNorm) || nameNorm.includes(rName);
    });
    if (!found) return null;

    const link = found.trackViewUrl.replace(/\?uo=\d+$/, '');
    const officialName = found.trackName || null;
    // Use app description + genres for LLM classification (AppStore genres are too coarse)
    const descText = [
      found.trackName,
      (found.genres || []).join(', '),
      found.description || '',
    ].join('\n').slice(0, 2000);
    const rawType = await classifyGameType(gameName, descText);
    const type = await normalizeGameType(gameName, rawType);
    db.insertGameTag({ game_name: gameName, category: 'app', source: 'appstore', link, raw_type: rawType, norm_type: type }).catch(() => {});

    return { link, type, raw_type: rawType, officialName };
  } catch {
    return null;
  }
}

async function searchAppGameLink(gameName) {
  // 1. Try TapTap (preferred — richer tags, better game coverage)
  const taptap = await searchAppFromTapTap(gameName);
  if (taptap) return taptap;

  // 2. Try YYB (com.xxx pattern)
  const yyb = await searchAppFromYYB(gameName);
  if (yyb) return yyb;

  // 3. Try AppStore
  const appstore = await searchAppFromAppStore(gameName);
  if (appstore) return appstore;

  return null;
}

// A cache entry is only fully usable when it carries BOTH a link and a real
// type. Tag extraction fails occasionally (~3% of searches historically) while
// the link still resolves, which used to persist `{ link, type: '-' }` and be
// treated as a permanent hit — the card then showed 类型 "-" forever.
function hasUsableType(entry) {
  return !!(entry && entry.type && entry.type !== '-');
}

// `opts.searchFn` is a test seam; production always uses the real search layer.
async function enrichGames(games, cache, category = 'minigame', opts = {}) {
  if (!cache) cache = loadCache();

  // Apply static name aliases (codenames → official names)
  for (const g of games) {
    // Normalize variant middle-dot characters (katakana ・ U+30FB, halfwidth ･ U+FF65)
    // to the standard interpunct · (U+00B7) so cache keys match regardless of input source
    g.name = g.name.replace(/[・･]/g, '·');
    if (GAME_NAME_ALIASES[g.name]) {
      g.name = GAME_NAME_ALIASES[g.name];
    }
  }

  const result = [];
  const toSearch = [];

  for (const g of games) {
    const cached = cacheLookup(cache, g.name, category);
    const name = (cached?.officialName && cached.officialName !== g.name) ? cached.officialName : g.name;
    if (cached?.link && hasUsableType(cached)) {
      result.push({ ...g, name, link: cached.link, type: cached.type });
    } else if (cached?.link) {
      // Partial hit: keep the known-good link as a fallback and re-search to
      // fill in the missing type. If the retry fails the link still stands, so
      // the game name stays clickable instead of regressing to no link at all.
      // _searchKey preserves the pre-rename name: the cache key and the found[]
      // lookup below are both keyed on it, not on the displayed officialName.
      result.push({ ...g, name, link: cached.link, type: '-', _searchKey: g.name });
      toSearch.push(g.name);
    } else {
      result.push({ ...g, link: '', type: '-', _searchKey: g.name });
      toSearch.push(g.name);
    }
  }

  if (toSearch.length === 0) return result;

  const searchFn = opts.searchFn || (category === 'app' ? searchAppGameLink : searchGameFromYYB);
  const CONCURRENCY = 3;
  const found = {};
  for (let i = 0; i < toSearch.length; i += CONCURRENCY) {
    const batch = toSearch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(name => searchFn(name)));
    batch.forEach((name, j) => {
      if (results[j]) found[name] = results[j];
    });
  }

  // _searchKey is internal bookkeeping and must never reach the card payload,
  // so strip it on every exit path — including this early return.
  if (Object.keys(found).length === 0) {
    for (const g of result) delete g._searchKey;
    return result;
  }

  for (const g of result) {
    const searchKey = g._searchKey;
    delete g._searchKey;
    if (!searchKey) continue; // complete cache hit, never searched
    const f = found[searchKey];
    if (f) {
      g.name = (f.officialName && f.officialName !== searchKey) ? f.officialName : searchKey;
      g.link = f.link;
      g.type = f.type;
      const entry = { link: g.link, type: g.type, category };
      if (f.raw_type) entry.raw_type = f.raw_type;
      if (f.officialName) entry.officialName = f.officialName;
      cache[cacheKey(searchKey, category)] = entry;
    }
  }
  saveCache(cache);
  const source = category === 'app' ? 'APP' : 'YYB';
  console.log(`[GameCache] ${source} 搜索完成: ${Object.keys(found).length}/${toSearch.length} 命中`);

  // NOTE: do not close the browser here. It is shared across concurrent report
  // lanes; searchAppFromTapTap acquires/releases it and the last release closes
  // it. The pipeline calls closeBrowser() once when all lanes have settled.
  return result;
}

function updateCacheEntry(name, link, type, category) {
  const cache = loadCache();
  const key = category ? cacheKey(name, category) : name;
  cache[key] = { link: link || '', type: type || '-' };
  if (category) cache[key].category = category;
  saveCache(cache);
}

function initCacheFromExistingData() {
  const cache = loadCache();
  const dir = config.EXISTING_REPORT_DIR;
  let added = 0;

  try {
    const files = fs.readdirSync(dir).filter(f => f.match(/report_data.*\.json$/i));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        const allGames = [
          ...(data.games || []),
          ...(data.wx_games || []),
          ...(data.dy_games || []),
        ];
        for (const g of allGames) {
          if (g.name && g.link) {
            const cat = g.link.includes('/appdetail/wx') ? 'minigame' : 'app';
            const key = cacheKey(g.name, cat);
            if (!cache[key]) {
              cache[key] = { link: g.link, type: g.type || '-', category: cat };
              added++;
            }
          }
        }
      } catch {}
    }
  } catch {}

  saveCache(cache);
  return { total: Object.keys(cache).length, added };
}

module.exports = { loadCache, saveCache, enrichGames, updateCacheEntry, initCacheFromExistingData, searchGameFromYYB, searchAppGameLink, acquireBrowser, releaseBrowser, closeBrowser };
