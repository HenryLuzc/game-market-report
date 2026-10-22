// 回归测试：腾讯区域锚定不得被字节"微小 日均XXXXW"抢走
//
// 复现 8.17-8.23 线上故障：该周区域标题写成"腾讯小游戏 5800W"（无"日均"前缀），
// 而字节区 Row53 写着"微小 日均2500W"。TENCENT_PROMPT 规则2 用"日均6100W"举例，
// 使"日均"成了事实上的锚点特征，LLM 转而锚定字节微信系区域，
// 导致腾讯小游戏卡片整体展示了字节微信小游戏的数据（total 2500、客户简称全空）。
//
// fixture 为该周真实表格行数据（test/fixtures/sheet-8.17-8.23.json）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const llmParser = require('../llm-parser');

const FIXTURE = path.join(__dirname, 'fixtures', 'sheet-8.17-8.23.json');

// 仅出现在腾讯区的游戏
const TENCENT_ONLY = ['寻道大千', '腾讯欢乐斗地主'];
// 两区同名但消耗不同的游戏——用消耗值判断数据到底来自哪个区域。
// 同一款游戏在腾讯和字节都投放属正常，故不能用名单排他，只能比数值。
const COST_DISCRIMINATORS = [
  { name: '向末日开炮', tencent: 81.87, bytedanceWx: 241 },
  { name: '去有梦的小岛', tencent: 74.19, bytedanceWx: 96 },
  { name: '工匠小能手', tencent: 68.36, bytedanceWx: 82 },
];

const EXPECTED_TOTAL = 5800;   // Row0: "腾讯小游戏 5800W"
const WRONG_TOTAL = 2500;      // Row53: "微小 日均2500W"

function loadRows() {
  if (!fs.existsSync(FIXTURE)) {
    throw new Error(`缺少 fixture: ${FIXTURE}\n重新生成: node scripts/make-sheet-fixture.js "8.17-8.23"`);
  }
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).rows;
}

function assertTencentRegion(r, label) {
  const names = r.games.map(g => g.name);
  const clientFilled = r.games.filter(g => g.client).length;
  const byName = new Map(r.games.map(g => [g.name, g.daily_cost]));

  console.log(`\n[${label}]`);
  console.log(`  total_cost = ${r.total_cost} (期望 ${EXPECTED_TOTAL})`);
  console.log(`  games = ${r.games.length} 款, client非空 = ${clientFilled}`);
  console.log(`  Top5: ${r.games.slice(0, 5).map(g => `${g.name}(${g.daily_cost})`).join(', ')}`);

  assert.notStrictEqual(r.total_cost, WRONG_TOTAL,
    `total_cost=${WRONG_TOTAL} 说明锚定到了字节"微小 日均2500W"`);
  assert.strictEqual(r.total_cost, EXPECTED_TOTAL,
    `总消耗应为 ${EXPECTED_TOTAL}(Row0 "腾讯小游戏 5800W")，实际 ${r.total_cost}`);
  assert.ok(TENCENT_ONLY.every(n => names.includes(n)),
    `应包含仅腾讯区存在的游戏，缺: ${TENCENT_ONLY.filter(n => !names.includes(n)).join('、')}`);

  // 同名游戏的消耗必须等于腾讯区数值，命中字节数值即说明数据来自字节区
  for (const d of COST_DISCRIMINATORS) {
    const got = byName.get(d.name);
    if (got === undefined) continue;
    assert.notStrictEqual(got, d.bytedanceWx,
      `"${d.name}" 消耗=${got} 等于字节微信系数值，数据来自字节区`);
    assert.ok(Math.abs(got - d.tencent) < 0.01,
      `"${d.name}" 消耗应为腾讯区 ${d.tencent}，实际 ${got}`);
  }
  assert.ok(clientFilled > r.games.length * 0.8,
    `腾讯区有"客户简称"列，非空应超8成，实际 ${clientFilled}/${r.games.length}`);
  console.log('  [PASS]');
}

// 历史周(8.10-8.16)：标题写作"腾讯 小游戏 日均5900w"，旧格式不得回退。
// 期望值取自该周 DB 成功记录 #359。
async function assertHistoricalWeek() {
  const f = path.join(__dirname, 'fixtures', 'sheet-8.10-8.16.json');
  if (!fs.existsSync(f)) {
    console.log('\n[历史周 8.10-8.16] 跳过：缺少 fixture');
    return;
  }
  const rows = JSON.parse(fs.readFileSync(f, 'utf8')).rows;
  const r = await llmParser.parseTencentData(rows);
  const cf = r.games.filter(g => g.client).length;
  console.log(`\n[历史周 8.10-8.16]`);
  console.log(`  total_cost = ${r.total_cost} (期望 5900)`);
  console.log(`  games = ${r.games.length} 款, client非空 = ${cf}`);
  assert.strictEqual(r.total_cost, 5900, `历史格式回退，总消耗应为 5900，实际 ${r.total_cost}`);
  assert.notStrictEqual(r.total_cost, 2342, 'total_cost=2342 说明锚到了该周字节"微小 日均2342W"');
  assert.ok(cf > r.games.length * 0.8, `client 非空应超8成，实际 ${cf}/${r.games.length}`);
  console.log('  [PASS]');
}

(async () => {
  const rows = loadRows();

  // 用例1：真实故障数据，标题无"日均"前缀
  assertTencentRegion(await llmParser.parseTencentData(rows), '真实数据(无日均前缀)');

  // 用例2：补上"日均"前缀，历史格式不得回退
  const withPrefix = rows.map(r => (r ? [...r] : r));
  withPrefix[0][0] = '腾讯小游戏 日均5800W';
  assertTencentRegion(await llmParser.parseTencentData(withPrefix), '带日均前缀');

  // 用例3：历史周真实数据
  await assertHistoricalWeek();

  console.log('\n全部通过');
})().catch(e => {
  console.error('\n[FAIL]', e.message);
  process.exit(1);
});
