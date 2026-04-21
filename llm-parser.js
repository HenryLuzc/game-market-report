const Anthropic = require('@anthropic-ai/sdk').default;

const client = new Anthropic();

function cleanGameName(name) {
  if (!name) return '';
  let s = String(name).trim();
  s = s.replace(/\s+(wx|WX)\s*$/i, '');
  s = s.replace(/\s+\d\s*$/, '');
  s = s.replace(/小游戏$/, '');
  s = s.replace(/\s+/g, '');
  return s;
}

function rowsToText(rows, maxRows = 200) {
  const slice = rows.slice(0, maxRows);
  return slice.map((row, i) => {
    const cells = (row || []).map((c, j) => `[${j}]${c == null ? '' : c}`);
    return `Row${i}: ${cells.join(' | ')}`;
  }).join('\n');
}

const TENCENT_PROMPT = `你是一个数据提取助手。下面是飞书电子表格的原始行数据。
请找到"腾讯小游戏"或"腾讯微小"区域的数据，提取每款游戏的信息，以及该区域的日均总消耗。

提取规则：
1. 找到包含"腾讯小游戏"或"腾讯微小"的行作为区域起点
2. 该行通常还包含日均总消耗信息，如"日均6100W"表示6100万，提取为total_cost
3. 下一行通常是表头（包含"客户简称"、"游戏名称"、"日均消耗"等列名）
4. 从表头下方开始提取数据行，直到遇到下一个平台区域（如"字节"、"快手"等）或连续空行
5. 提取字段：客户简称(client)、游戏马甲包名称(name)、日均消耗万元(daily_cost)
6. 跳过空行和无效数据（名称为空或消耗为0的行）
7. 日均消耗如果是字符串需转为数字，去掉逗号等

返回JSON对象，格式：
{
  "total_cost": 数字（万元，如6100），
  "games": [{"name": "游戏名", "client": "客户简称", "daily_cost": 数字}]
}
games按daily_cost降序排列。只返回JSON，不要其他文字。`;

const BYTEDANCE_PROMPT = `你是一个数据提取助手。下面是飞书电子表格的原始行数据。
请找到"字节"区域的数据，分别提取微信系小游戏和抖音小游戏的信息，以及它们各自的日均总消耗。

提取规则：
1. 找到包含"字节"的行作为区域起点
2. 下一行是表头，第一列通常是"互娱二级赛道"
3. 在数据行中，找到"微小"（或"微信小游戏"）对应的行，其第二列的数字就是微信系的日均总消耗(wx_total_cost)，单位万
4. 找到"抖小"（或"抖音小游戏"）对应的行，其第二列的数字就是抖音的日均总消耗(dy_total_cost)，单位万
5. 微信系小游戏列表：找到表头中"微信系小游戏"列及其对应的"日均消耗"列，逐行提取
6. 抖音小游戏列表：找到表头中"抖音小游戏名称"列及其对应的"日均消耗"列，逐行提取
7. 跳过名称为空的条目，日均消耗转为数字

返回JSON对象，格式：
{
  "wx_total_cost": 数字（万元），
  "dy_total_cost": 数字（万元），
  "wx_games": [{"name": "游戏名", "daily_cost": 数字}, ...],
  "dy_games": [{"name": "游戏名", "daily_cost": 数字}, ...]
}
各列表按daily_cost降序排列。只返回JSON，不要其他文字。`;

async function callClaude(prompt, rowsText) {
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: `${prompt}\n\n--- 表格数据 ---\n${rowsText}` }],
  });
  const text = resp.content[0].text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  const raw = jsonMatch[1];
  if (!raw) throw new Error('LLM 返回内容无法提取 JSON: ' + text.slice(0, 200));
  try {
    return JSON.parse(raw.trim());
  } catch {
    throw new Error('LLM 返回的 JSON 解析失败: ' + raw.slice(0, 200));
  }
}

function deduplicateAndRank(games) {
  const seen = new Set();
  const unique = [];
  for (const g of games) {
    const name = cleanGameName(g.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    unique.push({ ...g, name });
  }
  unique.sort((a, b) => b.daily_cost - a.daily_cost);
  return unique.map((g, i) => ({ ...g, rank: i + 1 }));
}

async function parseTencentData(rows) {
  const text = rowsToText(rows);
  const raw = await callClaude(TENCENT_PROMPT, text);
  const gamesList = raw.games || (Array.isArray(raw) ? raw : []);
  if (!gamesList.length) throw new Error('LLM 未提取到腾讯游戏数据');
  const games = gamesList.map(g => ({
    name: g.name,
    client: (g.client || '').replace(/\s+/g, '').trim(),
    daily_cost: parseFloat(g.daily_cost) || 0,
  })).filter(g => g.name && g.daily_cost > 0);
  if (!games.length) throw new Error('LLM 提取的腾讯游戏数据全部无效（名称为空或消耗为0）');
  return {
    games: deduplicateAndRank(games),
    total_cost: parseFloat(raw.total_cost) || 0,
  };
}

async function parseByteDanceData(rows) {
  const text = rowsToText(rows);
  const raw = await callClaude(BYTEDANCE_PROMPT, text);
  if (!raw.wx_games && !raw.dy_games) throw new Error('LLM 未提取到字节游戏数据');
  const wxRaw = (raw.wx_games || []).map(g => ({
    name: g.name,
    daily_cost: parseFloat(g.daily_cost) || 0,
  })).filter(g => g.name && g.daily_cost > 0);
  const dyRaw = (raw.dy_games || []).map(g => ({
    name: g.name,
    daily_cost: parseFloat(g.daily_cost) || 0,
  })).filter(g => g.name && g.daily_cost > 0);
  if (!wxRaw.length && !dyRaw.length) throw new Error('LLM 提取的字节游戏数据全部无效');
  return {
    wx_games: deduplicateAndRank(wxRaw),
    dy_games: deduplicateAndRank(dyRaw),
    wx_total_cost: parseFloat(raw.wx_total_cost) || 0,
    dy_total_cost: parseFloat(raw.dy_total_cost) || 0,
  };
}

const FIND_LATEST_SHEET_PROMPT = `你是一个数据分析助手。下面是飞书电子表格的所有标签页列表（sheet_id 和 title）。
请找出数据日期范围最新的那个标签页。

标签页标题通常包含日期范围，如"3.30-4.5"、"4.6-4.12"等（月.日-月.日格式）。
请选择结束日期最新的标签页，并提取其日期范围。
如果有跨年情况（结束月份小于起始月份），说明跨年了。
如果没有任何标签页匹配日期格式，选第一个标签页。

返回JSON对象，格式：
{
  "sheet_id": "选中的sheet_id",
  "title": "选中的标题",
  "dateRange": "日期范围部分，如4.6-4.12"
}
只返回JSON，不要其他文字。`;

async function findLatestSheet(sheets) {
  const sheetsText = sheets.map((s, i) => `${i}: sheet_id="${s.sheet_id}", title="${s.title}"`).join('\n');
  const raw = await callClaude(FIND_LATEST_SHEET_PROMPT, sheetsText);
  if (!raw.sheet_id) throw new Error('LLM 未能识别最新标签页');
  const valid = sheets.find(s => s.sheet_id === raw.sheet_id);
  if (!valid) throw new Error(`LLM 返回的 sheet_id "${raw.sheet_id}" 不在标签页列表中`);
  return { sheet_id: raw.sheet_id, title: raw.title || valid.title, dateRange: raw.dateRange || raw.title };
}

const TENCENT_APP_PROMPT = `你是一个数据提取助手。下面是飞书电子表格的原始行数据。
请找到"腾讯app"或"腾讯APP"区域的数据，提取每款APP游戏的信息，以及该区域的日均总消耗。

提取规则：
1. 找到包含"腾讯app"或"腾讯APP"（不区分大小写）的行作为区域起点
2. 该行通常还包含日均总消耗信息，如"日均6100W"表示6100万，提取为total_cost
3. 下一行通常是表头（包含"游戏名称"、"日均消耗"等列名）
4. 从表头下方开始提取数据行，直到遇到下一个平台区域或连续空行
5. 提取字段：游戏名称(name)、日均消耗万元(daily_cost)
6. 跳过空行和无效数据（名称为空或消耗为0的行）
7. 过滤非游戏项目（如工具类、电商类、社交类等明显不是游戏的项目）
8. 日均消耗如果是字符串需转为数字，去掉逗号等

返回JSON对象，格式：
{
  "total_cost": 数字（万元，如6100），
  "games": [{"name": "游戏名", "daily_cost": 数字}]
}
games按daily_cost降序排列。只返回JSON，不要其他文字。`;

const BYTEDANCE_APP_PROMPT = `你是一个数据提取助手。下面是飞书电子表格的原始行数据。
请找到"字节"区域的数据，提取APP手游的信息。

提取规则：
1. 找到包含"字节"的行作为区域起点
2. 下一行是表头，第一列通常是"互娱二级赛道"
3. 日均总消耗：在数据行中找到"互娱二级赛道"列对应的日均消耗数字，这是字节手游的日均总消耗(total_cost)，单位万
4. APP游戏列表：找到表头中"全局appname"列及其对应的"日均消耗"列，逐行提取游戏名称和日均消耗
5. 过滤非游戏项目（如工具类、应用商店类如TapTap、电商类、社交类、短剧类等明显不是游戏的项目）
6. 跳过名称为空的条目，日均消耗转为数字
7. 按游戏名称去重，保留消耗较高的记录

返回JSON对象，格式：
{
  "total_cost": 数字（万元），
  "games": [{"name": "游戏名", "daily_cost": 数字}, ...]
}
games按daily_cost降序排列。只返回JSON，不要其他文字。`;

async function parseTencentAppData(rows) {
  const text = rowsToText(rows);
  const raw = await callClaude(TENCENT_APP_PROMPT, text);
  const gamesList = raw.games || (Array.isArray(raw) ? raw : []);
  if (!gamesList.length) throw new Error('LLM 未提取到腾讯APP游戏数据');
  const games = gamesList.map(g => ({
    name: g.name,
    daily_cost: parseFloat(g.daily_cost) || 0,
  })).filter(g => g.name && g.daily_cost > 0);
  if (!games.length) throw new Error('LLM 提取的腾讯APP游戏数据全部无效');
  return {
    games: deduplicateAndRank(games),
    total_cost: parseFloat(raw.total_cost) || 0,
  };
}

async function parseByteDanceAppData(rows) {
  const text = rowsToText(rows);
  const raw = await callClaude(BYTEDANCE_APP_PROMPT, text);
  const gamesList = raw.games || (Array.isArray(raw) ? raw : []);
  if (!gamesList.length) throw new Error('LLM 未提取到字节APP游戏数据');
  const games = gamesList.map(g => ({
    name: g.name,
    daily_cost: parseFloat(g.daily_cost) || 0,
  })).filter(g => g.name && g.daily_cost > 0);
  if (!games.length) throw new Error('LLM 提取的字节APP游戏数据全部无效');
  return {
    games: deduplicateAndRank(games),
    total_cost: parseFloat(raw.total_cost) || 0,
  };
}

module.exports = { findLatestSheet, parseTencentData, parseByteDanceData, parseTencentAppData, parseByteDanceAppData, cleanGameName };
