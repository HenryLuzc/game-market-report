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

const stripPunct = s => s.replace(/[：:\-—–·、,.\s]+/g, '');

const TYPO_CORRECT_PROMPT = `你是一个游戏行业专家。请检查以下游戏名称列表，找出并修正其中的错别字（同音字、形近字等）。

规则：
1. 只修正你非常确定是错别字的情况，不确定的保持原样
2. 常见错误类型：同音字（像→向、生→声）、形近字、多字少字等
3. 返回JSON对象，key是原始名称，value是修正后的名称
4. 如果名称没有错别字，不要包含在返回结果中
5. 只返回JSON，不要其他文字

示例输入：["像僵尸开炮", "燕云十六生", "道友来挖宝", "寻道大千"]
示例输出：{"像僵尸开炮": "向僵尸开炮", "燕云十六生": "燕云十六声"}`;

async function correctGameNames(names) {
  if (!names.length) return new Map();
  try {
    const resp = await llmClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `${TYPO_CORRECT_PROMPT}\n\n${JSON.stringify(names)}` }],
    });
    const text = (resp.content.find(b => b.type === 'text')?.text || '').trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const corrections = JSON.parse((jsonMatch[1] || '{}').trim());
    const map = new Map();
    for (const [orig, fixed] of Object.entries(corrections)) {
      if (typeof fixed === 'string' && fixed && fixed !== orig) {
        map.set(orig, fixed);
        console.log(`[GameCache] 错别字修正: ${orig} → ${fixed}`);
      }
    }
    return map;
  } catch (err) {
    console.warn('[GameCache] 错别字检测失败(跳过):', err.message);
    return new Map();
  }
}

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
  const tags = [...html.matchAll(/TagList_tagItem[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/g)];
  const extracted = tags.map(m => m[1].trim()).filter(Boolean);
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
      model: 'claude-opus-4-6',
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
      model: 'claude-opus-4-6',
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

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

async function searchAppFromTapTap(gameName) {
  let page;
  try {
    const browser = await getBrowser();
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
      const rawType = (app.tags || []).map(t => t.value || t.name || t).filter(Boolean).join('、') || '-';
      const type = await normalizeGameType(gameName, rawType);
      db.insertGameTag({ game_name: gameName, category: 'app', source: 'taptap', link, raw_type: rawType, norm_type: type }).catch(() => {});
      return { link, type, raw_type: rawType, officialName };
    }
    return null;
  } catch (err) {
    console.warn('[GameCache] TapTap Puppeteer 搜索失败:', err.message);
    if (page && !page.isClosed()) await page.close().catch(() => {});
    return null;
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
  // 1. Try YYB (com.xxx pattern)
  const yyb = await searchAppFromYYB(gameName);
  if (yyb) return yyb;

  // 2. Try TapTap
  const taptap = await searchAppFromTapTap(gameName);
  if (taptap) return taptap;

  // 3. Try AppStore
  const appstore = await searchAppFromAppStore(gameName);
  if (appstore) return appstore;

  return null;
}

async function enrichGames(games, cache, category = 'minigame') {
  if (!cache) cache = loadCache();

  // Batch typo correction: only check names not already in cache
  const uncachedNames = games
    .filter(g => !cacheLookup(cache, g.name, category)?.link)
    .map(g => g.name);
  const typoMap = uncachedNames.length ? await correctGameNames(uncachedNames) : new Map();

  // Apply corrections: update game names and also check cache with corrected name
  for (const g of games) {
    const corrected = typoMap.get(g.name);
    if (corrected) {
      // Carry over cache entry if corrected name has one
      const correctedCached = cacheLookup(cache, corrected, category);
      if (correctedCached?.link) {
        cache[cacheKey(g.name, category)] = correctedCached;
      }
      g.name = corrected;
    }
  }

  const isAppStoreFallback = (link) => link && link.includes('apps.apple.com');

  const result = [];
  const toSearch = [];

  for (const g of games) {
    const cached = cacheLookup(cache, g.name, category);
    if (cached?.link && !isAppStoreFallback(cached.link)) {
      const name = (cached.officialName && cached.officialName !== g.name) ? cached.officialName : g.name;
      result.push({ ...g, name, link: cached.link, type: cached.type || '-' });
    } else {
      result.push({ ...g, link: cached?.link || '', type: cached?.type || '-' });
      toSearch.push(g.name);
    }
  }

  if (toSearch.length === 0) return result;

  const searchFn = category === 'app' ? searchAppGameLink : searchGameFromYYB;
  const CONCURRENCY = 3;
  const found = {};
  for (let i = 0; i < toSearch.length; i += CONCURRENCY) {
    const batch = toSearch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(name => searchFn(name)));
    batch.forEach((name, j) => {
      if (results[j]) found[name] = results[j];
    });
  }

  if (Object.keys(found).length === 0) return result;

  for (const g of result) {
    const origName = g.name;
    const f = found[origName];
    if (f) {
      const newName = (f.officialName && f.officialName !== origName) ? f.officialName : origName;
      g.name = newName;
      g.link = f.link;
      g.type = f.type;
      const entry = { link: g.link, type: g.type, category };
      if (f.raw_type) entry.raw_type = f.raw_type;
      if (f.officialName) entry.officialName = f.officialName;
      cache[cacheKey(origName, category)] = entry;
    }
  }
  saveCache(cache);
  const source = category === 'app' ? 'APP' : 'YYB';
  console.log(`[GameCache] ${source} 搜索完成: ${Object.keys(found).length}/${toSearch.length} 命中`);

  await closeBrowser();
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

module.exports = { loadCache, saveCache, enrichGames, updateCacheEntry, initCacheFromExistingData, searchGameFromYYB, searchAppGameLink, closeBrowser };
