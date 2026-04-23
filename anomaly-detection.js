const db = require('./db');

const THRESHOLDS = {
  COST_SPIKE_PCT: 80,
  COST_DROP_PCT: -50,
  TOTAL_ANOMALY_PCT: 30,
  NEW_TOP_RANK: 5,
  DISAPPEARED_RANK: 10,
  HISTORY_WEEKS: 4,
};

function extractGamesGrouped(inputData, reportType) {
  if (!inputData) return [{ key: 'all', games: [] }];
  if (reportType === 'bytedance') {
    return [
      { key: 'wx', games: inputData.wx_games || [] },
      { key: 'dy', games: inputData.dy_games || [] },
    ];
  }
  return [{ key: 'all', games: inputData.games || [] }];
}

function extractGames(inputData, reportType) {
  if (!inputData) return [];
  if (reportType === 'bytedance') {
    return [...(inputData.wx_games || []), ...(inputData.dy_games || [])];
  }
  return inputData.games || [];
}

function extractTotal(inputData, reportType) {
  if (!inputData) return 0;
  if (reportType === 'bytedance') {
    return (inputData.wx_total_daily_cost || 0) + (inputData.dy_total_daily_cost || 0);
  }
  return inputData.total_daily_cost || 0;
}

async function detectAnomalies(currentData, reportType) {
  const anomalies = [];
  const records = await db.getRecentRecords(reportType, THRESHOLDS.HISTORY_WEEKS);
  if (!records.length) return anomalies;

  const lastRecord = records[0];
  let lastData;
  try { lastData = JSON.parse(lastRecord.input_json); } catch { return anomalies; }

  const currentGroups = extractGamesGrouped(currentData, reportType);
  const lastGroups = extractGamesGrouped(lastData, reportType);
  const lastGroupMap = new Map(lastGroups.map(g => [g.key, g.games]));

  for (const { key, games: currentGames } of currentGroups) {
    const lastGames = lastGroupMap.get(key) || [];
    const lastMap = new Map(lastGames.map(g => [g.name, g]));
    const currentMap = new Map(currentGames.map(g => [g.name, g]));
    const platform = reportType === 'bytedance' ? (key === 'wx' ? '微信' : '抖音') : '';
    const prefix = platform ? `[${platform}] ` : '';

    for (const g of currentGames) {
      const prev = lastMap.get(g.name);
      if (prev && prev.daily_cost > 0) {
        const pctChange = ((g.daily_cost - prev.daily_cost) / prev.daily_cost) * 100;
        if (pctChange > THRESHOLDS.COST_SPIKE_PCT) {
          anomalies.push({
            type: 'cost_spike', game: prefix + g.name,
            current: g.daily_cost, previous: prev.daily_cost,
            pctChange: +pctChange.toFixed(1), severity: 'high',
          });
        } else if (pctChange < THRESHOLDS.COST_DROP_PCT) {
          anomalies.push({
            type: 'cost_drop', game: prefix + g.name,
            current: g.daily_cost, previous: prev.daily_cost,
            pctChange: +pctChange.toFixed(1), severity: 'medium',
          });
        }
      }
    }

    for (const g of lastGames) {
      if (g.rank <= THRESHOLDS.DISAPPEARED_RANK && !currentMap.has(g.name)) {
        anomalies.push({ type: 'disappeared', game: prefix + g.name, lastRank: g.rank, severity: 'low' });
      }
    }
  }

  const allHistoryNames = new Set();
  for (const rec of records) {
    try {
      const d = JSON.parse(rec.input_json);
      for (const g of extractGames(d, reportType)) allHistoryNames.add(g.name);
    } catch {}
  }
  const currentAllGames = extractGames(currentData, reportType);
  for (const g of currentAllGames) {
    if (g.rank <= THRESHOLDS.NEW_TOP_RANK && !allHistoryNames.has(g.name)) {
      anomalies.push({ type: 'new_top_rank', game: g.name, rank: g.rank, severity: 'medium' });
    }
  }

  const currentTotal = extractTotal(currentData, reportType);
  const historicTotals = [];
  for (const rec of records) {
    try {
      const d = JSON.parse(rec.input_json);
      historicTotals.push(extractTotal(d, reportType));
    } catch {}
  }
  if (historicTotals.length >= 2) {
    const avg = historicTotals.reduce((s, v) => s + v, 0) / historicTotals.length;
    if (avg > 0) {
      const pctChange = ((currentTotal - avg) / avg) * 100;
      if (Math.abs(pctChange) > THRESHOLDS.TOTAL_ANOMALY_PCT) {
        anomalies.push({
          type: 'total_anomaly',
          current: currentTotal, baseline: +avg.toFixed(1),
          pctChange: +pctChange.toFixed(1),
          severity: 'high',
        });
      }
    }
  }

  anomalies.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.severity] || 9) - (order[b.severity] || 9);
  });

  return anomalies;
}

function formatAnomaliesMarkdown(anomalies) {
  if (!anomalies || !anomalies.length) return '';
  const icons = { high: '🔴', medium: '🟡', low: '🔵' };
  const lines = anomalies.slice(0, 8).map(a => {
    const icon = icons[a.severity] || '⚪';
    switch (a.type) {
      case 'cost_spike':
        return `${icon} **消耗激增**：${a.game} 日耗从 ${a.previous}万 → ${a.current}万（+${a.pctChange}%）`;
      case 'cost_drop':
        return `${icon} **消耗骤降**：${a.game} 日耗从 ${a.previous}万 → ${a.current}万（${a.pctChange}%）`;
      case 'total_anomaly':
        const dir = a.pctChange > 0 ? '高于' : '低于';
        return `${icon} **大盘异动**：总消耗 ${a.current}万，${dir}近期均值 ${a.baseline}万（${a.pctChange > 0 ? '+' : ''}${a.pctChange}%）`;
      case 'new_top_rank':
        return `${icon} **新晋头部**：${a.game} 首次进入 TOP${THRESHOLDS.NEW_TOP_RANK}（#${a.rank}）`;
      case 'disappeared':
        return `${icon} **跌出榜单**：${a.game}（上周 #${a.lastRank}）本周未上榜`;
      default:
        return `${icon} ${a.type}: ${a.game || ''}`;
    }
  });
  return lines.map(l => `- ${l}`).join('\n');
}

module.exports = { detectAnomalies, formatAnomaliesMarkdown, THRESHOLDS };
