#!/usr/bin/env node
/**
 * Generate Feishu interactive card JSON for ByteDance small game data.
 * Input: JSON with wx_games[] and dy_games[] arrays.
 * Usage: node generate_card.js <input.json> [output.json]
 */
const fs = require('fs');

function loadData(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function calcSummary(wxGames, dyGames, wxTotalDailyCost, dyTotalDailyCost) {
  const wxTotal = wxGames.length;
  const dyTotal = dyGames.length;
  // Use platform totals from spreadsheet if available (represents the real platform total),
  // otherwise fall back to summing the listed games
  const wxCost = wxTotalDailyCost != null ? wxTotalDailyCost : wxGames.reduce((s, g) => s + g.daily_cost, 0);
  const dyCost = dyTotalDailyCost != null ? dyTotalDailyCost : dyGames.reduce((s, g) => s + g.daily_cost, 0);
  return {
    wxTotal, dyTotal,
    total: wxTotal + dyTotal,
    wxCost: +wxCost.toFixed(2),
    dyCost: +dyCost.toFixed(2),
    totalCost: +(wxCost + dyCost).toFixed(2)
  };
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
        if (trimmed) {
          tagCost[trimmed] = (tagCost[trimmed] || 0) + g.daily_cost;
        }
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

function buildAnalysis(wxGames, dyGames, summary) {
  const lines = [];
  const { wxCost, dyCost, totalCost } = summary;
  const wxPct = +(wxCost / totalCost * 100).toFixed(1);
  const dyPct = +(dyCost / totalCost * 100).toFixed(1);

  // 1. Overall
  lines.push(`**字节整体**：共 ${summary.total} 款小游戏上榜，日均总消耗 ${Math.round(totalCost).toLocaleString()} 万。其中微信系 ${Math.round(wxCost)} 万（${wxPct}%）、抖音 ${Math.round(dyCost)} 万（${dyPct}%）`);

  // 2. WX top games
  if (wxGames.length) {
    const top = wxGames.slice(0, 2);
    const names = top.map(g => `${g.name}（${g.daily_cost}万）`).join('、');
    lines.push(`**微信系头部**：${names} 领跑`);
  }

  // 3. DY top games
  if (dyGames.length) {
    const top = dyGames.slice(0, 2);
    const names = top.map(g => `${g.name}（${g.daily_cost}万）`).join('、');
    lines.push(`**抖音头部**：${names} 领跑`);
  }

  // 4. WX top type
  const wxTagInfo = getTopTag(wxGames);
  if (wxTagInfo) {
    lines.push(`**微信系主力品类**：${wxTagInfo.name}占比 ${wxTagInfo.pct}%（日均 ${wxTagInfo.cost} 万），共 ${wxTagInfo.count} 款`);
  }

  // 5. DY top type
  const dyTagInfo = getTopTag(dyGames);
  if (dyTagInfo) {
    lines.push(`**抖音主力品类**：${dyTagInfo.name}占比 ${dyTagInfo.pct}%（日均 ${dyTagInfo.cost} 万），共 ${dyTagInfo.count} 款`);
  }

  // 6. Cross-platform overlap
  const wxNames = new Set(wxGames.map(g => g.name));
  const dyNames = new Set(dyGames.map(g => g.name));
  const overlap = [...wxNames].filter(n => dyNames.has(n));
  if (overlap.length) {
    lines.push(`**跨平台重合**：${overlap.length} 款游戏同时出现在两个平台（${overlap.slice(0, 4).join('、')}${overlap.length > 4 ? '等' : ''}）`);
  }

  return lines.slice(0, 6).map(l => `- ${l}`).join('\n');
}

function getTopTag(games) {
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
  const sorted = Object.entries(tagCost).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return null;
  const totalTagCost = Object.values(tagCost).reduce((s, v) => s + v, 0);
  const [name, val] = sorted[0];
  return {
    name,
    pct: +(val / totalTagCost * 100).toFixed(1),
    cost: Math.round(val),
    count: tagCount[name]
  };
}

function buildCard(data) {
  const wxGames = data.wx_games;
  const dyGames = data.dy_games;
  const summary = calcSummary(wxGames, dyGames, data.wx_total_daily_cost, data.dy_total_daily_cost);
  const wxTypePie = buildTypePie(wxGames);
  const dyTypePie = buildTypePie(dyGames);
  const wxRows = buildTableRows(wxGames);
  const dyRows = buildTableRows(dyGames);
  const analysis = buildAnalysis(wxGames, dyGames, summary);

  const title = data.title || `${data.date_range || ''} 字节小游戏消耗排名分析`;
  const analysisDate = data.analysis_date || '';
  const dataSource = data.data_source || '';

  const fmtCost = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const tableColumns = [
    { name: 'rank', display_name: '排名', data_type: 'number', horizontal_align: 'center', width: '80px' },
    { name: 'game', display_name: '游戏名称', data_type: 'lark_md', width: '200px' },
    { name: 'type', display_name: '游戏类型', data_type: 'text', width: '180px' },
    { name: 'cost', display_name: '日均消耗(万)', data_type: 'number', horizontal_align: 'right', width: '120px' }
  ];

  const tableHeaderStyle = {
    text_align: 'center',
    text_size: 'normal',
    background_style: 'grey',
    bold: true,
    lines: 1
  };

  function makePieChart(titleText, pieData) {
    return {
      tag: 'chart',
      chart_spec: {
        type: 'pie',
        title: { visible: true, text: titleText },
        data: [{ id: 'type', values: pieData }],
        categoryField: 'type',
        valueField: 'value',
        outerRadius: 0.8,
        innerRadius: 0.5,
        label: { visible: true, formatter: '{type}: {value}%' },
        legends: { visible: true, orient: 'bottom' },
        tooltip: { visible: true }
      }
    };
  }

  function makeTable(rows) {
    return {
      tag: 'table',
      page_size: 10,
      row_height: 'low',
      header_style: tableHeaderStyle,
      columns: tableColumns,
      rows: rows
    };
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'indigo'
    },
    elements: [
      { tag: 'markdown', content: `微信系 **${summary.wxTotal}** 款 / 抖音系 **${summary.dyTotal}** 款  |  日均总消耗 **${fmtCost(summary.totalCost)} 万元**（微信 ${fmtCost(summary.wxCost)} + 抖音 ${fmtCost(summary.dyCost)}）` },
      { tag: 'hr' },
      { tag: 'markdown', content: '**一、微信系小游戏消耗分布**' },
      makePieChart('微信系小游戏类型消耗占比', wxTypePie),
      { tag: 'hr' },
      { tag: 'markdown', content: '**二、抖音小游戏消耗分布**' },
      makePieChart('抖音小游戏类型消耗占比', dyTypePie),
      { tag: 'hr' },
      { tag: 'markdown', content: '**三、微信系小游戏列表**' },
      makeTable(wxRows),
      { tag: 'hr' },
      { tag: 'markdown', content: '**四、抖音小游戏列表**' },
      makeTable(dyRows),
      { tag: 'hr' },
      { tag: 'markdown', content: `**五、总结分析**\n\n${analysis}` },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `数据来源：${dataSource} | 链接来源：腾讯应用宝 | 分析时间：${analysisDate}` }]
      }
    ]
  };
}

// Main
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node generate_card.js <input.json> [output.json]');
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
