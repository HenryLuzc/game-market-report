#!/usr/bin/env node
// 把飞书标签页的原始行数据落成离线 fixture，供解析回归测试使用。
// 用法: node scripts/make-sheet-fixture.js "8.17-8.23"
const fs = require('fs');
const path = require('path');
const feishuReader = require('../feishu-reader');
const config = require('../config');

(async () => {
  const title = process.argv[2];
  if (!title) {
    console.error('用法: node scripts/make-sheet-fixture.js "<标签页标题>"');
    process.exit(1);
  }
  const objToken = await feishuReader.getSpreadsheetToken(config.WIKI_TOKEN);
  const sheets = await feishuReader.getSheetList(objToken);
  const target = sheets.find(s => s.title === title);
  if (!target) {
    console.error(`标签页 "${title}" 不存在，可用: ${sheets.map(s => s.title).join(', ')}`);
    process.exit(1);
  }
  const rows = await feishuReader.readSheet(objToken, target.sheet_id);
  const out = path.join(__dirname, '..', 'test', 'fixtures', `sheet-${title}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ title, rows }), 'utf8');
  console.log(`已写入 ${out} (${rows.length} 行, ${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
