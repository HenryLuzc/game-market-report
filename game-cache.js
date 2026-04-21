const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const Anthropic = require('@anthropic-ai/sdk').default;

const llmClient = new Anthropic();

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
  try {
    const resp = await llmClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: `${NORMALIZE_PROMPT}\n\n游戏名：${gameName}\n原始标签：${rawType}` }],
    });
    const text = resp.content[0].text.trim();
    if (text && text !== '-' && text.length < 30) return text;
  } catch {}
  return rawType;
}

async function classifyGameType(gameName, pageText) {
  try {
    const resp = await llmClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: `根据以下游戏页面信息，提取游戏"${gameName}"的类型标签，最多4个，用"、"分隔。只返回标签文字，不要解释。如果无法判断返回"-"。\n\n${pageText.slice(0, 2000)}` }],
    });
    const text = resp.content[0].text.trim();
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
        // Require the app name to closely match — not just substring
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

async function searchAppFromTapTap(gameName) {
  try {
    // TapTap is CSR, use DuckDuckGo HTML search to find TapTap app pages
    const ddgUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent('taptap.cn ' + gameName);
    const searchResp = await fetch(ddgUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!searchResp.ok) return null;
    const searchHtml = await searchResp.text();

    // Extract taptap.cn/app/DIGITS links from search results
    const tapRe = /taptap\.cn\/app\/(\d+)/g;
    const ids = new Set();
    let match;
    while ((match = tapRe.exec(searchHtml)) !== null) ids.add(match[1]);
    if (ids.size === 0) return null;

    // Check each candidate page for name match
    const nameNorm = stripPunct(gameName);
    for (const id of ids) {
      const link = `https://www.taptap.cn/app/${id}`;
      try {
        const detailResp = await fetch(link, {
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        if (!detailResp.ok) continue;
        const detailHtml = await detailResp.text();
        const titleMatch = detailHtml.match(/<title[^>]*>([^<]+)/i);
        const pageTitle = (titleMatch ? titleMatch[1] : '');
        if (!stripPunct(pageTitle).includes(nameNorm)) continue;

        // Extract official name from title (e.g. "时尚百货城 - TapTap" → "时尚百货城")
        const officialName = pageTitle.replace(/\s*[-–—|].*$/, '').trim() || null;

        // Extract tags from RSC payload: ,"tagName","taptap://taptap.com/library?tag=
        const tagRe2 = /,"([^"]+)","taptap:\/\/taptap\.com\/library\?tag=/g;
        const tags = [];
        let tm;
        while ((tm = tagRe2.exec(detailHtml)) !== null) tags.push(tm[1]);
        const rawType = tags.length ? tags.join('、') : '-';
        const type = await normalizeGameType(gameName, rawType);
        db.insertGameTag({ game_name: gameName, category: 'app', source: 'taptap', link, raw_type: rawType, norm_type: type }).catch(() => {});
        return { link, type, raw_type: rawType, officialName };
      } catch {}
    }
    return null;
  } catch {
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
  const result = [];
  const toSearch = [];

  for (const g of games) {
    const cached = cacheLookup(cache, g.name, category);
    if (cached?.link) {
      if (cached.officialName && cached.officialName !== g.name) g.name = cached.officialName;
      result.push({ ...g, link: cached.link, type: cached.type || '-' });
    } else {
      result.push({ ...g, link: '', type: '-' });
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
      if (f.officialName && f.officialName !== origName) g.name = f.officialName;
      g.link = f.link;
      g.type = f.type;
      const entry = { link: g.link, type: g.type, category };
      if (f.raw_type) entry.raw_type = f.raw_type;
      if (f.officialName) entry.officialName = f.officialName;
      // Cache under original name so future lookups match
      cache[cacheKey(origName, category)] = entry;
    }
  }
  saveCache(cache);
  const source = category === 'app' ? 'APP' : 'YYB';
  console.log(`[GameCache] ${source} 搜索完成: ${Object.keys(found).length}/${toSearch.length} 命中`);

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
          if (g.name && g.link && !cache[g.name]) {
            cache[g.name] = { link: g.link, type: g.type || '-' };
            added++;
          }
        }
      } catch {}
    }
  } catch {}

  saveCache(cache);
  return { total: Object.keys(cache).length, added };
}

module.exports = { loadCache, saveCache, enrichGames, updateCacheEntry, initCacheFromExistingData, searchGameFromYYB, searchAppGameLink };
