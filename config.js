require('dotenv').config();
const path = require('path');

const WIKI_TOKEN = process.env.WIKI_TOKEN || '';
// 数据源文档名称（卡片底部展示，会被渲染成指向 DATA_SOURCE_URL 的链接）
const DATA_SOURCE_NAME = process.env.DATA_SOURCE_NAME || '2026媒体广告消耗';
// 数据源文档链接。优先读 .env 里的完整链接（从浏览器地址栏复制最准确）；
// 未配置时用 WIKI_TOKEN 拼一个 wiki 链接兜底。
const FEISHU_DOC_DOMAIN = (process.env.FEISHU_DOC_DOMAIN || 'https://www.feishu.cn').replace(/\/+$/, '');
const DATA_SOURCE_URL = process.env.DATA_SOURCE_URL
  || (WIKI_TOKEN ? `${FEISHU_DOC_DOMAIN}/wiki/${encodeURIComponent(WIKI_TOKEN)}` : '');

module.exports = Object.freeze({
  WIKI_TOKEN,
  SEND_TARGETS_PATH: path.join(__dirname, 'data', 'send-targets.json'),
  NOTIFY_USER_ID: process.env.NOTIFY_USER_ID || '',
  API_KEY: process.env.API_KEY || '',

  FEISHU_APP_ID: process.env.FEISHU_APP_ID || '',
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',
  FEISHU_BASE_URL: process.env.FEISHU_BASE_URL || 'https://open.feishu.cn',

  BYTEDANCE_CARD_SCRIPT: path.join(__dirname, 'scripts', 'generate_bytedance_card.js'),
  TENCENT_CARD_SCRIPT: path.join(__dirname, 'scripts', 'generate_tencent_card.js'),
  TENCENT_APP_CARD_SCRIPT: path.join(__dirname, 'scripts', 'generate_tencent_app_card.js'),
  BYTEDANCE_APP_CARD_SCRIPT: path.join(__dirname, 'scripts', 'generate_bytedance_app_card.js'),

  DB_PATH: path.join(__dirname, 'data', 'reports.db'),
  GAME_CACHE_PATH: path.join(__dirname, 'game-cache.json'),
  TEMP_DIR: path.join(__dirname, 'tmp'),
  DATA_DIR: path.join(__dirname, 'data'),

  PORT: parseInt(process.env.PORT, 10) || 3456,
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '0 10 * * 5',
  TIMEZONE: 'Asia/Shanghai',

  DATA_SOURCE: `飞书文档《${DATA_SOURCE_NAME}》`,
  DATA_SOURCE_NAME,
  DATA_SOURCE_URL,

  EXISTING_REPORT_DIR: 'F:/Claude',
});
