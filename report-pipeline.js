const config = require('./config');
const feishuReader = require('./feishu-reader');
const llmParser = require('./llm-parser');
const gameCache = require('./game-cache');
const cardGenerator = require('./card-generator');
const cardSender = require('./card-sender');
const sendTargets = require('./send-targets');
const db = require('./db');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function runSingleReport(type, rows, dateRange, cache, targets) {
  let inputData, cardJson, cardJsonStr;

  try {
    if (type === 'tencent') {
      const { games, total_cost } = await llmParser.parseTencentData(rows);
      const enriched = await gameCache.enrichGames(games, cache);
      inputData = {
        title: `${dateRange} 腾讯小游戏消耗排名分析`,
        date_range: dateRange,
        analysis_date: today(),
        data_source: config.DATA_SOURCE,
        games: enriched,
        total_daily_cost: total_cost,
      };
      cardJson = cardGenerator.generateTencentCard(inputData);
    } else if (type === 'bytedance') {
      const { wx_games, dy_games, wx_total_cost, dy_total_cost } = await llmParser.parseByteDanceData(rows);
      const wxEnriched = await gameCache.enrichGames(wx_games, cache);
      const dyEnriched = await gameCache.enrichGames(dy_games, cache);
      inputData = {
        title: `${dateRange} 字节小游戏消耗排名分析`,
        date_range: dateRange,
        analysis_date: today(),
        data_source: config.DATA_SOURCE,
        wx_games: wxEnriched,
        dy_games: dyEnriched,
        wx_total_daily_cost: wx_total_cost,
        dy_total_daily_cost: dy_total_cost,
      };
      cardJson = cardGenerator.generateByteDanceCard(inputData);
    } else if (type === 'tencent_app') {
      const { games, total_cost } = await llmParser.parseTencentAppData(rows);
      const enriched = await gameCache.enrichGames(games, cache, 'app');
      inputData = {
        title: `${dateRange} 腾讯手游消耗排名分析`,
        date_range: dateRange,
        analysis_date: today(),
        data_source: config.DATA_SOURCE,
        games: enriched,
        total_daily_cost: total_cost,
      };
      cardJson = cardGenerator.generateTencentAppCard(inputData);
    } else if (type === 'bytedance_app') {
      const { games, total_cost } = await llmParser.parseByteDanceAppData(rows);
      const enriched = await gameCache.enrichGames(games, cache, 'app');
      inputData = {
        title: `${dateRange} 字节手游消耗排名分析`,
        date_range: dateRange,
        analysis_date: today(),
        data_source: config.DATA_SOURCE,
        games: enriched,
        total_daily_cost: total_cost,
      };
      cardJson = cardGenerator.generateByteDanceAppCard(inputData);
    }

    cardJsonStr = JSON.stringify(cardJson);
    const inputJsonStr = JSON.stringify(inputData);
    const sendResults = await cardSender.sendCardToAll(cardJson, targets);

    const records = [];
    for (const sr of sendResults) {
      const targetStr = JSON.stringify(sr.target);
      try {
        const id = await db.insertRecord({
          date_range: dateRange,
          report_type: type,
          status: sr.success ? 'success' : 'failure',
          error_msg: sr.error || null,
          card_json: cardJsonStr,
          input_json: inputJsonStr,
          message_id: sr.message_id || null,
          send_target: targetStr,
        });
        records.push({ report_type: type, status: sr.success ? 'success' : 'failure', record_id: id, target: sr.target, message_id: sr.message_id, error: sr.error });
      } catch (dbErr) {
        console.error(`[Pipeline] ${type} DB 写入失败:`, dbErr.message);
        records.push({ report_type: type, status: 'failure', record_id: null, target: sr.target, error: sr.error || dbErr.message });
      }
    }
    return records;
  } catch (err) {
    try {
      const id = await db.insertRecord({
        date_range: dateRange,
        report_type: type,
        status: 'failure',
        error_msg: err.message,
        card_json: cardJsonStr || null,
        input_json: inputData ? JSON.stringify(inputData) : null,
      });
      return [{ report_type: type, status: 'failure', record_id: id, error: err.message }];
    } catch (dbErr) {
      console.error(`[Pipeline] ${type} DB 写入也失败:`, dbErr.message);
      return [{ report_type: type, status: 'failure', record_id: null, error: err.message }];
    }
  }
}

async function runPipeline({ types = ['tencent', 'bytedance', 'tencent_app', 'bytedance_app'], userId, chatId, sheetName } = {}) {
  console.log(`[Pipeline] 开始执行 (${types.join(', ')}) - ${new Date().toLocaleString('zh-CN')}`);

  let rows, dateRange;
  try {
    const objToken = await feishuReader.getSpreadsheetToken(config.WIKI_TOKEN);
    const sheets = await feishuReader.getSheetList(objToken);

    let target;
    if (sheetName) {
      target = sheets.find(s => s.title === sheetName);
      if (!target) throw new Error(`标签页 "${sheetName}" 不存在，可用: ${sheets.map(s => s.title).join(', ')}`);
      dateRange = sheetName;
    } else {
      target = await llmParser.findLatestSheet(sheets);
      dateRange = target.dateRange;
    }
    console.log(`[Pipeline] 标签页: ${target.title} (${dateRange})`);

    rows = await feishuReader.readSheet(objToken, target.sheet_id);
    console.log(`[Pipeline] 读取到 ${rows.length} 行数据`);
  } catch (err) {
    console.error(`[Pipeline] 数据读取失败: ${err.message}`);
    const results = [];
    for (const type of types) {
      try {
        const id = await db.insertRecord({
          date_range: '-',
          report_type: type,
          status: 'failure',
          error_msg: `数据读取失败: ${err.message}`,
        });
        results.push({ report_type: type, status: 'failure', record_id: id, error: err.message });
      } catch {
        results.push({ report_type: type, status: 'failure', record_id: null, error: err.message });
      }
    }
    return results;
  }

  const cache = gameCache.loadCache();

  // CLI override: single target
  let targets;
  if (userId) {
    targets = [{ type: 'user', target: userId, name: 'CLI 指定用户' }];
  } else if (chatId) {
    targets = [{ type: 'chat', target: chatId, name: 'CLI 指定群聊' }];
  } else {
    targets = sendTargets.loadTargets();
    if (targets.length === 0) {
      console.error('[Pipeline] 未配置发送目标，请在管理页面添加');
      return [{ report_type: types.join(','), status: 'failure', record_id: null, error: '未配置发送目标' }];
    }
  }
  console.log(`[Pipeline] 发送目标: ${targets.length} 个`);

  const allResults = [];
  for (const type of types) {
    const records = await runSingleReport(type, rows, dateRange, cache, targets);
    allResults.push(...records);
  }

  for (const r of allResults) {
    const targetName = r.target?.name || '';
    if (r.status === 'success') {
      console.log(`[Pipeline] ${r.report_type} → ${targetName} 发送成功 (record #${r.record_id})`);
    } else {
      console.error(`[Pipeline] ${r.report_type} → ${targetName} 发送失败 (record #${r.record_id}): ${r.error}`);
    }
  }

  return allResults;
}

module.exports = { runPipeline };
