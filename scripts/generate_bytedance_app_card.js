#!/usr/bin/env node
/**
 * Generate Feishu interactive card JSON for ByteDance APP game data.
 * Usage: node generate_bytedance_app_card.js <input.json> [output.json]
 */
const fs = require('fs');

function loadData(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function calcSummary(games, totalDailyCost) {
  const total = games.length;
  const totalCost = totalDailyCost != null ? totalDailyCost : games.reduce((s, g) => s + g.daily_cost, 0);
  return { total, totalCost: +totalCost.toFixed(2) };
}

function buildTypePie(games) {
  const tagCost = {};
  for (const g of games) {
    const t = g.type || '-';
    if (!t || t === '-') {
      tagCost['未分类'] = (tagCost['未分类'] || 0) + g.daily_cost;
    } else {
      for (const tag of t.split('、')) {
        const trimmed = tag.trim();
        if (trimmed) tagCost[trimmed] = (tagCost[trimmed] || 0) + g.daily_cost;
      }
    }
  }
  const totalTagCost = Object.values(tagCost).reduce((s, v) => s + v, 0);
  return Object.entries(tagCost)
    .sort((a, b) => b[1] - a[1])
    .map(([type, value]) => ({ type, value: +(value / totalTagCost * 100).toFixed(2) }));
}

function buildTableRows(games) {
  return games.map(g => {
    const gameField = g.link ? `[${g.name}](${g.link})` : g.name;
    return {
      rank: g.rank,
      game: gameField,
      type: g.type || '-',
      cost: g.daily_cost
    };
  });
}

function buildAnalysis(games, summary) {
  const { totalCost } = summary;
  const top10Cost = games.slice(0, 10).reduce((s, g) => s + g.daily_cost, 0);
  const top10Pct = +(top10Cost / totalCost * 100).toFixed(1);

  const tagCost = {};
  const tagCount = {};
  for (const g of games) {
    const t = g.type || '-';
    if (!t || t === '-') {
      tagCost['未分类'] = (tagCost['未分类'] || 0) + g.daily_cost;
      tagCount['未分类'] = (tagCount['未分类'] || 0) + 1;
    } else {
      for (const tag of t.split('、')) {
        const trimmed = tag.trim();
        if (trimmed) {
          tagCost[trimmed] = (tagCost[trimmed] || 0) + g.daily_cost;
          tagCount[trimmed] = (tagCount[trimmed] || 0) + 1;
        }
      }
    }
  }

  const sortedTags = Object.entries(tagCost).sort((a, b) => b[1] - a[1]);
  if (!sortedTags.length) return '- 暂无分类数据';
  const totalTagCost = Object.values(tagCost).reduce((s, v) => s + v, 0) || 1;
  const [topTagName, topTagVal] = sortedTags[0];
  const topTagPct = +(topTagVal / totalTagCost * 100).toFixed(1);
  const topTagCnt = tagCount[topTagName];

  const lastCost = games[games.length - 1]?.daily_cost || 1;
  const headTailRatio = games.length > 1 ? Math.floor(games[0].daily_cost / lastCost) : 1;

  const lines = [];
  lines.push(`**字节手游整体**：共 ${games.length} 款手游上榜，日均总消耗 ${Math.round(totalCost).toLocaleString()} 万`);
  lines.push(`**${topTagName}类主导市场**：占总消耗 ${topTagPct}%（日均 ${Math.round(topTagVal).toLocaleString()} 万），共 ${topTagCnt} 款`);
  lines.push(`**头部集中效应**：TOP10 日均消耗 ${Math.round(top10Cost).toLocaleString()} 万，占总量 ${top10Pct}%，头尾差距达 ${headTailRatio} 倍`);

  if (sortedTags.length >= 2) {
    const [t2Name, t2Val] = sortedTags[1];
    const t2Pct = +(t2Val / totalTagCost * 100).toFixed(1);
    const t2Cnt = tagCount[t2Name];
    lines.push(`**${t2Name}品类投放强劲**：占比 ${t2Pct}%（日均 ${Math.round(t2Val)} 万），共 ${t2Cnt} 款`);
  }

  if (sortedTags.length >= 3) {
    const [t3Name, t3Val] = sortedTags[2];
    const t3Pct = +(t3Val / totalTagCost * 100).toFixed(1);
    const t3Cnt = tagCount[t3Name];
    lines.push(`**${t3Name}紧随其后**：占比 ${t3Pct}%（日均 ${Math.round(t3Val)} 万），共 ${t3Cnt} 款`);
  }

  return lines.slice(0, 5).map(l => `- ${l}`).join('\n');
}

function buildCard(data) {
  const games = data.games;
  const { total, totalCost } = calcSummary(games, data.total_daily_cost);
  const typePie = buildTypePie(games);
  const tableRows = buildTableRows(games);
  const analysis = buildAnalysis(games, { totalCost });

  const title = data.title || `${data.date_range || ''} 字节手游消耗排名分析`;
  const analysisDate = data.analysis_date || '';
  const dataSource = data.data_source || '';

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'turquoise'
    },
    elements: [
      { tag: 'markdown', content: `共 **${total}** 款手游  |  日均总消耗 **${totalCost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} 万元**` },
      { tag: 'hr' },
      { tag: 'markdown', content: '**一、消耗分布**' },
      {
        tag: 'chart',
        chart_spec: {
          type: 'pie',
          title: { visible: true, text: '游戏类型消耗占比分布' },
          data: [{ id: 'type', values: typePie }],
          categoryField: 'type',
          valueField: 'value',
          outerRadius: 0.8,
          innerRadius: 0.5,
          label: { visible: true, formatter: '{type}: {value}%' },
          legends: { visible: true, orient: 'bottom' },
          tooltip: { visible: true }
        }
      },
      { tag: 'hr' },
      { tag: 'markdown', content: '**二、完整游戏列表**' },
      {
        tag: 'table',
        page_size: 10,
        row_height: 'low',
        header_style: {
          text_align: 'center',
          text_size: 'normal',
          background_style: 'grey',
          bold: true,
          lines: 1
        },
        columns: [
          { name: 'rank', display_name: '排名', data_type: 'number', horizontal_align: 'center', width: '80px' },
          { name: 'game', display_name: '游戏名称', data_type: 'lark_md', width: '200px' },
          { name: 'type', display_name: '游戏类型', data_type: 'text', width: '180px' },
          { name: 'cost', display_name: '日均消耗(万)', data_type: 'number', horizontal_align: 'right', width: '120px' }
        ],
        rows: tableRows
      },
      { tag: 'hr' },
      { tag: 'markdown', content: `**三、总结分析**\n\n${analysis}` },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `数据来源：${dataSource} | 链接来源：应用宝 / TapTap / AppStore | 分析时间：${analysisDate}` }]
      }
    ]
  };
}

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node generate_bytedance_app_card.js <input.json> [output.json]');
  process.exit(1);
}

const data = loadData(args[0]);
const card = buildCard(data);
const output = JSON.stringify(card, null, 2);

if (args.length >= 2) {
  fs.writeFileSync(args[1], output, 'utf-8');
  console.error(`Card JSON written to ${args[1]}`);
} else {
  console.log(output);
}
