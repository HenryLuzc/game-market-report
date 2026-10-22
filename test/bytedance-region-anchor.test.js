// 回归测试：字节区域定位不得依赖"字节"字面，也不得混入腾讯区数据
//
// 8.17-8.23 表格中**没有任何一行含"字节"二字**，而 BYTEDANCE_PROMPT 原规则1
// 要求"找到包含'字节'的行作为区域起点"。该周靠 LLM 上下文推断侥幸正确，
// 属同类隐患，故改为按"微小/抖小并列"结构定位，并用本测试锁定。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const llmParser = require('../llm-parser');

// 期望值取自各周 DB 成功记录
const CASES = [
  {
    title: '8.17-8.23',
    wxTotal: 2500, dyTotal: 5000,
    wxFirst: { name: '向末日开炮', cost: 241 },
    dyFirst: { name: '疯狂水世界', cost: 309 },
    // 腾讯区同名游戏的消耗，出现即说明串区
    tencentCosts: [81.87, 74.19, 68.36],
  },
  {
    title: '8.10-8.16',
    wxTotal: 2342, dyTotal: 5042,
  },
];

async function runCase(c) {
  const f = path.join(__dirname, 'fixtures', `sheet-${c.title}.json`);
  if (!fs.existsSync(f)) {
    console.log(`\n[${c.title}] 跳过：缺少 fixture (node scripts/make-sheet-fixture.js "${c.title}")`);
    return;
  }
  const rows = JSON.parse(fs.readFileSync(f, 'utf8')).rows;
  const hasByteWord = rows.some(r => (r || []).some(x => x && String(x).includes('字节')));
  const r = await llmParser.parseByteDanceData(rows);
  const w = r.wx_games[0], d = r.dy_games[0];

  console.log(`\n[${c.title}] 表中含"字节"字样: ${hasByteWord}`);
  console.log(`  wx_total=${r.wx_total_cost} (期望 ${c.wxTotal}), dy_total=${r.dy_total_cost} (期望 ${c.dyTotal})`);
  console.log(`  wx=${r.wx_games.length}款 首位=${w?.name}(${w?.daily_cost}) | dy=${r.dy_games.length}款 首位=${d?.name}(${d?.daily_cost})`);

  assert.strictEqual(r.wx_total_cost, c.wxTotal,
    `微信系总消耗应为 ${c.wxTotal}，实际 ${r.wx_total_cost}`);
  assert.strictEqual(r.dy_total_cost, c.dyTotal,
    `抖音总消耗应为 ${c.dyTotal}，实际 ${r.dy_total_cost}`);

  if (c.wxFirst) {
    assert.strictEqual(w.name, c.wxFirst.name, `微信系首位应为 ${c.wxFirst.name}，实际 ${w.name}`);
    assert.strictEqual(w.daily_cost, c.wxFirst.cost,
      `"${w.name}" 消耗应为字节区 ${c.wxFirst.cost}，实际 ${w.daily_cost}`);
  }
  if (c.dyFirst) {
    assert.strictEqual(d.name, c.dyFirst.name, `抖音首位应为 ${c.dyFirst.name}，实际 ${d.name}`);
    assert.strictEqual(d.daily_cost, c.dyFirst.cost,
      `"${d.name}" 消耗应为字节区 ${c.dyFirst.cost}，实际 ${d.daily_cost}`);
  }
  // 腾讯区数值不得出现在字节结果中
  if (c.tencentCosts) {
    const all = [...r.wx_games, ...r.dy_games];
    for (const tc of c.tencentCosts) {
      const hit = all.find(g => Math.abs(g.daily_cost - tc) < 0.01);
      assert.ok(!hit, `字节结果出现腾讯区消耗值 ${tc}（${hit?.name}），说明串区`);
    }
  }
  console.log('  [PASS]');
}

(async () => {
  for (const c of CASES) await runCase(c);
  console.log('\n全部通过');
})().catch(e => {
  console.error('\n[FAIL]', e.message);
  process.exit(1);
});
