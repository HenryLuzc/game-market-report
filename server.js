const express = require('express');
const path = require('path');
const db = require('./db');
const cardSender = require('./card-sender');
const { runPipeline } = require('./report-pipeline');
const gameCache = require('./game-cache');
const sendTargets = require('./send-targets');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 获取记录列表
app.get('/api/records', async (req, res) => {
  try {
    const { type, status, dateFrom, dateTo, dateRange, targetType, target, page = 1, pageSize = 20 } = req.query;
    const result = await db.getRecords({
      report_type: type || undefined,
      status: status || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      dateRange: dateRange || undefined,
      targetType: targetType || undefined,
      target: target || undefined,
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单条记录详情
app.get('/api/records/:id', async (req, res) => {
  try {
    const record = await db.getRecordById(parseInt(req.params.id, 10));
    if (!record) return res.status(404).json({ error: '记录不存在' });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重发卡片
app.post('/api/records/:id/resend', async (req, res) => {
  try {
    const record = await db.getRecordById(parseInt(req.params.id, 10));
    if (!record) return res.status(404).json({ error: '记录不存在' });
    if (!record.card_json) return res.status(400).json({ error: '该记录没有卡片数据' });

    let cardJson;
    try { cardJson = JSON.parse(record.card_json); } catch {
      return res.status(400).json({ error: '卡片 JSON 解析失败' });
    }

    let sendOpts = {};
    if (record.send_target) {
      try {
        const t = JSON.parse(record.send_target);
        if (t.type === 'user') sendOpts = { userId: t.target };
        else if (t.type === 'chat') sendOpts = { chatId: t.target };
        else sendOpts = t; // legacy format
      } catch {}
    }
    const sendResult = await cardSender.sendCard(cardJson, sendOpts);

    const newId = await db.insertRecord({
      date_range: record.date_range,
      report_type: record.report_type,
      status: sendResult.success ? 'success' : 'failure',
      error_msg: sendResult.error || null,
      card_json: record.card_json,
      input_json: record.input_json,
      message_id: sendResult.message_id || null,
      send_target: record.send_target || null,
    });

    res.json({
      success: sendResult.success,
      record_id: newId,
      message_id: sendResult.message_id,
      error: sendResult.error,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动触发 pipeline（后台执行，立即返回）
let pipelineRunning = false;

app.post('/api/trigger', (req, res) => {
  const { types = ['tencent', 'bytedance'], userId, chatId } = req.body || {};
  const valid = types.every(t => ['tencent', 'bytedance', 'tencent_app', 'bytedance_app'].includes(t));
  if (!valid) return res.status(400).json({ error: '无效的报告类型' });
  if (pipelineRunning) return res.status(409).json({ error: '已有 pipeline 正在执行' });

  pipelineRunning = true;
  res.json({ status: 'started', types });

  runPipeline({ types, userId, chatId })
    .then(results => {
      console.log('[Trigger] Pipeline 完成:', results.map(r => `${r.report_type}:${r.status}`).join(', '));
    })
    .catch(err => {
      console.error('[Trigger] Pipeline 异常:', err.message);
    })
    .finally(() => {
      pipelineRunning = false;
    });
});

// 游戏缓存 API
app.get('/api/cache', (req, res) => {
  const cache = gameCache.loadCache();
  const entries = Object.entries(cache).map(([name, info]) => ({ name, ...info }));
  res.json({ total: entries.length, entries });
});

app.put('/api/cache/:name', (req, res) => {
  const { link, type, category } = req.body;
  gameCache.updateCacheEntry(req.params.name, link, type, category);
  res.json({ success: true });
});

// 发送目标管理 API
app.get('/api/targets', (req, res) => {
  const targets = sendTargets.loadTargets();
  res.json(targets);
});

app.post('/api/targets', (req, res) => {
  const { type, target, name } = req.body || {};
  if (!type || !target) return res.status(400).json({ error: '缺少 type 或 target' });
  if (!['chat', 'user'].includes(type)) return res.status(400).json({ error: 'type 必须为 chat 或 user' });
  const entry = sendTargets.addTarget({ type, target, name });
  res.json(entry);
});

app.put('/api/targets/:id', (req, res) => {
  const updated = sendTargets.updateTarget(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: '目标不存在' });
  res.json(updated);
});

app.delete('/api/targets/:id', (req, res) => {
  const removed = sendTargets.removeTarget(req.params.id);
  if (!removed) return res.status(404).json({ error: '目标不存在' });
  res.json({ success: true });
});

module.exports = app;
