const cron = require('node-cron');
const config = require('./config');
const { runPipeline } = require('./report-pipeline');

let running = false;

function startScheduler() {
  const job = cron.schedule(config.CRON_SCHEDULE, async () => {
    if (running) {
      console.log('[Scheduler] 上一次任务仍在执行，跳过本次');
      return;
    }
    running = true;
    console.log(`[Scheduler] 定时任务触发 - ${new Date().toLocaleString('zh-CN')}`);
    try {
      const results = await runPipeline();
      console.log('[Scheduler] 定时任务完成:', JSON.stringify(results.map(r => ({ type: r.report_type, status: r.status }))));
    } catch (err) {
      console.error('[Scheduler] 定时任务异常:', err.message);
    } finally {
      running = false;
    }
  }, {
    timezone: config.TIMEZONE,
    scheduled: true,
  });

  console.log(`[Scheduler] 已启动定时任务: ${config.CRON_SCHEDULE} (${config.TIMEZONE})`);
  console.log('[Scheduler] 下次执行: 每周三 10:00');
  return job;
}

module.exports = { startScheduler };
