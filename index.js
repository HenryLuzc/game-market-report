const app = require('./server');
const { startScheduler } = require('./scheduler');
const { getDb, cleanupPendingRecords } = require('./db');
const config = require('./config');

async function main() {
  await getDb();
  console.log('[DB] 数据库已初始化');

  const cleaned = await cleanupPendingRecords();
  if (cleaned > 0) console.log(`[DB] 已清理 ${cleaned} 条残留 pending 记录`);

  startScheduler();

  app.listen(config.PORT, () => {
    console.log(`[Server] Dashboard 已启动: http://localhost:${config.PORT}`);
    console.log(`[Server] API 基地址: http://localhost:${config.PORT}/api`);
  });
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
