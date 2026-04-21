const { runPipeline } = require('./report-pipeline');
const { initCacheFromExistingData } = require('./game-cache');

const args = process.argv.slice(2);

if (args.includes('--init-cache')) {
  console.log('初始化游戏缓存...');
  const result = initCacheFromExistingData();
  console.log(`完成: 共 ${result.total} 条缓存, 本次新增 ${result.added} 条`);
  process.exit(0);
}

let types = ['tencent', 'bytedance'];
const typeIdx = args.indexOf('--type');
if (typeIdx !== -1 && args[typeIdx + 1]) {
  const val = args[typeIdx + 1];
  const validTypes = ['tencent', 'bytedance', 'tencent_app', 'bytedance_app'];
  if (val === 'all') {
    types = validTypes;
  } else if (validTypes.includes(val)) {
    types = [val];
  } else {
    console.error(`无效的类型: ${val} (可选: ${validTypes.join(', ')}, all)`);
    process.exit(1);
  }
}

let userId, chatId, sheetName;
const userIdx = args.indexOf('--user-id');
if (userIdx !== -1 && args[userIdx + 1]) userId = args[userIdx + 1];
const chatIdx = args.indexOf('--chat-id');
if (chatIdx !== -1 && args[chatIdx + 1]) chatId = args[chatIdx + 1];
const sheetIdx = args.indexOf('--sheet');
if (sheetIdx !== -1 && args[sheetIdx + 1]) sheetName = args[sheetIdx + 1];

console.log(`手动触发报告: ${types.join(', ')}${sheetName ? ` (标签页: ${sheetName})` : ''}`);

runPipeline({ types, userId, chatId, sheetName })
  .then(results => {
    console.log('\n执行结果:');
    for (const r of results) {
      const icon = r.status === 'success' ? '[OK]' : '[FAIL]';
      console.log(`  ${icon} ${r.report_type} - record #${r.record_id}${r.error ? ' - ' + r.error : ''}`);
    }
    process.exit(results.every(r => r.status === 'success') ? 0 : 1);
  })
  .catch(err => {
    console.error('执行失败:', err.message);
    process.exit(1);
  });
