require('dotenv').config();
const path = require('path');

module.exports = Object.freeze({
  WIKI_TOKEN: 'UYBewkucaiGG5gk6O0Qccx3Snmh',
  SEND_TARGETS_PATH: path.join(__dirname, 'data', 'send-targets.json'),
  NOTIFY_USER_ID: 'ou_9f0277291f9b1f432e67f2d28240d662',

  FEISHU_APP_ID: process.env.FEISHU_APP_ID || 'cli_a03a400e83f95013',
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',
  FEISHU_BASE_URL: process.env.FEISHU_BASE_URL || 'https://open.feishu.cn',

  BYTEDANCE_CARD_SCRIPT: 'C:/Users/luzc/.claude/skills/ads-bytedance-smallgame-market-report/scripts/generate_card.js',
  TENCENT_CARD_SCRIPT: 'C:/Users/luzc/.claude/skills/ads-tencent-wx-market-report/scripts/generate_card.js',
  TENCENT_APP_CARD_SCRIPT: path.join(__dirname, 'scripts', 'generate_tencent_app_card.js'),
  BYTEDANCE_APP_CARD_SCRIPT: path.join(__dirname, 'scripts', 'generate_bytedance_app_card.js'),

  DB_PATH: path.join(__dirname, 'data', 'reports.db'),
  GAME_CACHE_PATH: path.join(__dirname, 'game-cache.json'),
  TEMP_DIR: path.join(__dirname, 'tmp'),
  DATA_DIR: path.join(__dirname, 'data'),

  PORT: parseInt(process.env.PORT, 10) || 3456,
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '0 10 * * 0',
  TIMEZONE: 'Asia/Shanghai',

  DATA_SOURCE: '飞书文档《2026媒体广告消耗》',

  EXISTING_REPORT_DIR: 'F:/Claude',
});
