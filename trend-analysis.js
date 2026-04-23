const Anthropic = require('@anthropic-ai/sdk').default;
const db = require('./db');

const llmClient = new Anthropic();

function extractGames(inputData, reportType) {
  if (!inputData) return [];
  if (reportType === 'bytedance') {
    const wx = (inputData.wx_games || []).map(g => ({ ...g, _platform: '微信' }));
    const dy = (inputData.dy_games || []).map(g => ({ ...g, _platform: '抖音' }));
    return [...wx, ...dy];
  }
  return inputData.games || [];
}

function buildGameKey(g) {
  return g._platform ? `${g._platform}_${g.name}` : g.name;
}

function buildGameMap(games) {
  return new Map(games.map(g => [buildGameKey(g), g]));
}

function extractTotal(inputData, reportType) {
  if (!inputData) return 0;
  if (reportType === 'bytedance') {
    return (inputData.wx_total_daily_cost || 0) + (inputData.dy_total_daily_cost || 0);
  }
  return inputData.total_daily_cost || 0;
}

function getCategoryDistribution(games) {
  const dist = {};
  const totalCost = games.reduce((s, g) => s + (g.daily_cost || 0), 0);
  for (const g of games) {
    const t = g.type || '-';
    for (const tag of t.split('、')) {
      const trimmed = tag.trim();
      if (trimmed && trimmed !== '-') {
        dist[trimmed] = (dist[trimmed] || 0) + (g.daily_cost || 0);
      }
    }
  }
  const result = {};
  for (const [k, v] of Object.entries(dist)) {
    result[k] = totalCost > 0 ? +((v / totalCost) * 100).toFixed(1) : 0;
  }
  return result;
}

function computeTrends(currentData, previousData, reportType) {
  const curGames = extractGames(currentData, reportType);
  const prevGames = extractGames(previousData, reportType);
  const curTotal = extractTotal(currentData, reportType);
  const prevTotal = extractTotal(previousData, reportType);

  const totalCostChange = {
    current: curTotal,
    previous: prevTotal,
    pctChange: prevTotal > 0 ? +(((curTotal - prevTotal) / prevTotal) * 100).toFixed(1) : null,
  };

  const prevMap = buildGameMap(prevGames);
  const curMap = buildGameMap(curGames);

  const newEntrants = curGames
    .filter(g => !prevMap.has(buildGameKey(g)))
    .map(g => ({ name: g.name, rank: g.rank, daily_cost: g.daily_cost }));

  const droppedOff = prevGames
    .filter(g => !curMap.has(buildGameKey(g)))
    .map(g => ({ name: g.name, rank: g.rank, daily_cost: g.daily_cost }));

  const biggestMovers = [];
  for (const g of curGames) {
    const prev = prevMap.get(buildGameKey(g));
    if (prev && prev.rank && g.rank) {
      const change = prev.rank - g.rank;
      if (change !== 0) biggestMovers.push({ name: g.name, oldRank: prev.rank, newRank: g.rank, change });
    }
  }
  biggestMovers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const curDist = getCategoryDistribution(curGames);
  const prevDist = getCategoryDistribution(prevGames);
  const allCategories = new Set([...Object.keys(curDist), ...Object.keys(prevDist)]);
  const categoryShift = [];
  for (const cat of allCategories) {
    const oldPct = prevDist[cat] || 0;
    const newPct = curDist[cat] || 0;
    const delta = +(newPct - oldPct).toFixed(1);
    if (Math.abs(delta) >= 1) categoryShift.push({ category: cat, oldPct, newPct, delta });
  }
  categoryShift.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return { totalCostChange, newEntrants, droppedOff, biggestMovers: biggestMovers.slice(0, 5), categoryShift: categoryShift.slice(0, 5) };
}

function formatTrendsForPrompt(trends, reportType) {
  const lines = [];
  const tc = trends.totalCostChange;
  if (tc.pctChange !== null) {
    const dir = tc.pctChange > 0 ? '增长' : '下降';
    lines.push(`总消耗：${tc.previous}万 → ${tc.current}万，环比${dir} ${Math.abs(tc.pctChange)}%`);
  }
  if (trends.newEntrants.length) {
    lines.push(`新上榜(${trends.newEntrants.length}款)：${trends.newEntrants.slice(0, 5).map(g => `${g.name}(#${g.rank},${g.daily_cost}万)`).join('、')}`);
  }
  if (trends.droppedOff.length) {
    lines.push(`跌出榜单(${trends.droppedOff.length}款)：${trends.droppedOff.slice(0, 5).map(g => `${g.name}(上周#${g.rank})`).join('、')}`);
  }
  if (trends.biggestMovers.length) {
    lines.push(`排名变动最大：${trends.biggestMovers.map(g => `${g.name}(${g.oldRank}→${g.newRank})`).join('、')}`);
  }
  if (trends.categoryShift.length) {
    lines.push(`品类变化：${trends.categoryShift.map(c => `${c.category}${c.delta > 0 ? '+' : ''}${c.delta}%`).join('、')}`);
  }
  return lines.join('\n');
}

function formatTrendsMarkdown(trends) {
  const lines = [];
  const tc = trends.totalCostChange;
  if (tc.pctChange !== null) {
    const arrow = tc.pctChange > 0 ? '↑' : '↓';
    lines.push(`**总消耗环比**：${tc.previous}万 → ${tc.current}万（${arrow} ${Math.abs(tc.pctChange)}%）`);
  }
  if (trends.newEntrants.length) {
    const names = trends.newEntrants.slice(0, 5).map(g => `${g.name}(#${g.rank})`).join('、');
    lines.push(`**新上榜**：${names}`);
  }
  if (trends.droppedOff.length) {
    const names = trends.droppedOff.slice(0, 5).map(g => g.name).join('、');
    lines.push(`**跌出榜单**：${names}`);
  }
  if (trends.biggestMovers.length) {
    const movers = trends.biggestMovers.slice(0, 3).map(g => {
      const arrow = g.change > 0 ? `↑${g.change}位` : `↓${Math.abs(g.change)}位`;
      return `${g.name}(${arrow})`;
    }).join('、');
    lines.push(`**排名变动**：${movers}`);
  }
  return lines.map(l => `- ${l}`).join('\n');
}

const REPORT_TYPE_NAMES = {
  tencent: '腾讯小游戏',
  bytedance: '字节小游戏',
  tencent_app: '腾讯手游',
  bytedance_app: '字节手游',
};

async function generateTrendInsight(trends, reportType) {
  const promptText = formatTrendsForPrompt(trends, reportType);
  if (!promptText) return '';
  const typeName = REPORT_TYPE_NAMES[reportType] || reportType;
  try {
    const resp = await llmClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: `你是游戏广告投放市场分析师。以下是${typeName}市场的周环比变化数据，请生成一段简洁的趋势洞察（3-5句话），重点关注值得关注的变化和可能的原因。不要重复罗列数据，聚焦洞察。不要使用标题或markdown格式，直接输出纯文本段落。\n\n${promptText}` }],
    });
    return resp.content?.[0]?.text?.trim() || '';
  } catch {
    return '';
  }
}

async function getTrendsForReport(currentData, reportType, dateRange) {
  try {
    const lastRecord = await db.getLastSuccessRecord(reportType, dateRange);
    if (!lastRecord || !lastRecord.input_json) return null;
    const previousData = JSON.parse(lastRecord.input_json);
    const trends = computeTrends(currentData, previousData, reportType);
    const insight = await generateTrendInsight(trends, reportType);
    const markdown = formatTrendsMarkdown(trends);
    return { ...trends, insight, markdown, previous_date_range: lastRecord.date_range };
  } catch (err) {
    console.error(`[TrendAnalysis] ${reportType} 趋势计算失败:`, err.message);
    return null;
  }
}

function buildCurrentStats(inputData, reportType) {
  const games = extractGames(inputData, reportType);
  const total = extractTotal(inputData, reportType);
  const gameCount = games.length;
  const top5 = games.slice(0, 5).map(g => `${g.name}(${g.daily_cost}万)`).join('、');
  const top10Cost = games.slice(0, 10).reduce((s, g) => s + g.daily_cost, 0);
  const top10Pct = total > 0 ? +((top10Cost / total) * 100).toFixed(1) : 0;

  const tagCost = {};
  const tagCount = {};
  for (const g of games) {
    const t = g.type || '-';
    for (const tag of t.split('、')) {
      const trimmed = tag.trim();
      if (trimmed && trimmed !== '-') {
        tagCost[trimmed] = (tagCost[trimmed] || 0) + g.daily_cost;
        tagCount[trimmed] = (tagCount[trimmed] || 0) + 1;
      }
    }
  }
  const sortedTags = Object.entries(tagCost).sort((a, b) => b[1] - a[1]);
  const topCategories = sortedTags.slice(0, 5).map(([name, cost]) => {
    const pct = total > 0 ? +((cost / total) * 100).toFixed(1) : 0;
    return `${name}(${pct}%,${tagCount[name]}款)`;
  }).join('、');

  const headTailRatio = (games.length >= 2 && games[0].daily_cost && games[games.length - 1].daily_cost)
    ? Math.floor(games[0].daily_cost / games[games.length - 1].daily_cost)
    : 1;

  const lines = [
    `共${gameCount}款游戏，日均总消耗${Math.round(total)}万`,
    `TOP5：${top5}`,
    `TOP10集中度：${top10Pct}%（${Math.round(top10Cost)}万），头尾差距${headTailRatio}倍`,
    `品类分布：${topCategories}`,
  ];

  if (reportType === 'bytedance' && inputData.wx_games && inputData.dy_games) {
    const wxCost = inputData.wx_total_daily_cost || 0;
    const dyCost = inputData.dy_total_daily_cost || 0;
    lines.push(`微信系${inputData.wx_games.length}款(${Math.round(wxCost)}万) / 抖音${inputData.dy_games.length}款(${Math.round(dyCost)}万)`);
  }

  return lines.join('\n');
}

async function generateSmartAnalysis(inputData, reportType, trends, anomalies, historyInsights) {
  const typeName = REPORT_TYPE_NAMES[reportType] || reportType;
  const currentStats = buildCurrentStats(inputData, reportType);

  let prompt = `你是资深游戏广告投放市场分析师。请根据以下数据生成${typeName}市场的总结分析（5-8句话）。要求：聚焦洞察和判断，不要简单罗列数据。纯文本段落，不要标题、列表、markdown格式。\n\n`;
  prompt += `【本周数据概览】\n${currentStats}\n`;

  if (trends) {
    const trendText = formatTrendsForPrompt(trends, reportType);
    if (trendText) prompt += `\n【周环比变化】\n${trendText}\n`;
  }

  if (anomalies && anomalies.length) {
    const anomalyText = anomalies.slice(0, 5).map(a => {
      if (a.type === 'cost_spike') return `${a.game}消耗激增：${a.previous}万→${a.current}万(+${a.pctChange}%)`;
      if (a.type === 'cost_drop') return `${a.game}消耗骤降：${a.previous}万→${a.current}万(${a.pctChange}%)`;
      if (a.type === 'new_top_rank') return `${a.game}首次进入TOP5(#${a.rank})`;
      if (a.type === 'disappeared') return `${a.game}(上周#${a.lastRank})跌出榜单`;
      if (a.type === 'total_anomaly') return `大盘总消耗偏离均值${a.pctChange}%`;
      return '';
    }).filter(Boolean).join('；');
    if (anomalyText) prompt += `\n【异常信号】\n${anomalyText}\n`;
  }

  if (historyInsights && historyInsights.length) {
    prompt += `\n【你之前几周的分析（供参考，可追踪趋势延续或反转）】\n`;
    for (const h of historyInsights.slice(0, 3).reverse()) {
      prompt += `[${h.date_range}] ${h.content.slice(0, 300)}\n`;
    }
  }

  try {
    const resp = await llmClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content?.[0]?.text?.trim() || '';
    if (text && text.length > 20) return text;
  } catch {}
  return '';
}

async function generateLongTermInsight(reportType) {
  const typeName = REPORT_TYPE_NAMES[reportType] || reportType;
  const summaries = await db.getInsights(reportType, 'summary', 8);
  if (summaries.length < 4) return '';

  const records = await db.getRecentRecords(reportType, 8);
  const weeklyData = [];
  for (const rec of records) {
    try {
      const d = JSON.parse(rec.input_json);
      const total = extractTotal(d, reportType);
      const dist = getCategoryDistribution(extractGames(d, reportType));
      weeklyData.push({ dateRange: rec.date_range, total, topCategories: Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 5) });
    } catch {}
  }

  let prompt = `你是资深游戏广告投放市场分析师。以下是${typeName}市场最近${summaries.length}周的分析总结和数据，请进行长周期趋势分析（5-8句话）。要求：\n1. 识别持续性趋势（哪些品类持续增长/下滑）\n2. 发现周期性规律（是否有节假日效应或季节性特征）\n3. 标注值得长期关注的游戏或品类\n纯文本段落，不要标题、列表、markdown格式。\n\n`;

  prompt += `【各周总消耗趋势】\n`;
  for (const w of weeklyData.slice().reverse()) {
    const cats = w.topCategories.map(([n, p]) => `${n}${p}%`).join('、');
    prompt += `${w.dateRange}: 总消耗${Math.round(w.total)}万 | ${cats}\n`;
  }

  prompt += `\n【各周分析摘要】\n`;
  for (const s of summaries.slice().reverse()) {
    prompt += `[${s.date_range}] ${s.content.slice(0, 200)}\n`;
  }

  try {
    const resp = await llmClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content?.[0]?.text?.trim() || '';
    if (text && text.length > 20) return text;
  } catch {}
  return '';
}

module.exports = { computeTrends, formatTrendsMarkdown, generateTrendInsight, getTrendsForReport, generateSmartAnalysis, generateLongTermInsight };
