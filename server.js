const express = require('express');
const path = require('path');
const config = require('./config');
const db = require('./db');
const cardSender = require('./card-sender');
const { runPipeline } = require('./report-pipeline');
const gameCache = require('./game-cache');
const sendTargets = require('./send-targets');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!config.API_KEY) return next();
  const key = req.headers['x-api-key'];
  if (key === config.API_KEY) return next();
  res.status(401).json({ error: '未授权：请提供有效的 API Key' });
}

// 获取记录列表
app.get('/api/records', requireAuth, async (req, res) => {
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
app.get('/api/records/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: '无效的 ID' });
    const record = await db.getRecordById(id);
    if (!record) return res.status(404).json({ error: '记录不存在' });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重发卡片
app.post('/api/records/:id/resend', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: '无效的 ID' });
    const record = await db.getRecordById(id);
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

// 手动触发 pipeline（先插 pending 记录，后台执行）
const pipelineLock = require('./pipeline-lock');
const PIPELINE_TIMEOUT_MS = 10 * 60 * 1000;

app.post('/api/trigger', requireAuth, async (req, res) => {
  const { types = ['tencent', 'bytedance'], userId, chatId } = req.body || {};
  if (!Array.isArray(types)) return res.status(400).json({ error: 'types 必须为数组' });
  const valid = types.every(t => ['tencent', 'bytedance', 'tencent_app', 'bytedance_app'].includes(t));
  if (!valid) return res.status(400).json({ error: '无效的报告类型' });
  if (!pipelineLock.acquire('trigger')) return res.status(409).json({ error: '已有 pipeline 正在执行' });

  let targets;
  if (userId) {
    targets = [{ type: 'user', target: userId, name: 'CLI 指定用户' }];
  } else if (chatId) {
    targets = [{ type: 'chat', target: chatId, name: 'CLI 指定群聊' }];
  } else {
    targets = sendTargets.loadTargets();
    if (targets.length === 0) {
      pipelineLock.release('trigger');
      return res.status(400).json({ error: '未配置发送目标' });
    }
  }

  const recordIds = [];
  try {
    for (const type of types) {
      for (const t of targets) {
        const id = await db.insertRecord({
          date_range: '-', report_type: type, status: 'pending',
          send_target: JSON.stringify(t),
        });
        recordIds.push({ id, type, target: t });
      }
    }
  } catch (err) {
    const insertedIds = recordIds.map(r => r.id);
    if (insertedIds.length) await db.markPendingAsFailed(insertedIds, '创建记录时部分失败: ' + err.message);
    pipelineLock.release('trigger');
    return res.status(500).json({ error: '创建记录失败: ' + err.message });
  }

  const allRecordIds = recordIds.map(r => r.id);
  const abortController = { aborted: false };
  const lockTag = 'trigger';
  const timer = setTimeout(async () => {
    console.error('[Trigger] Pipeline 超时，标记中止');
    abortController.aborted = true;
    try { await db.markPendingAsFailed(allRecordIds, 'Pipeline 执行超时'); } catch (e) {
      console.error('[Trigger] 超时标记失败:', e.message);
    }
    pipelineLock.release(lockTag);
  }, PIPELINE_TIMEOUT_MS);

  res.json({ status: 'started', types, recordIds: recordIds.map(r => r.id) });

  const recordMap = {};
  for (const r of recordIds) {
    if (!recordMap[r.type]) recordMap[r.type] = [];
    recordMap[r.type].push({ id: r.id, target: r.target });
  }

  runPipeline({ types, userId, chatId, recordMap, abortController })
    .then(results => {
      if (abortController.aborted) {
        console.warn('[Trigger] Pipeline 完成但已被标记超时，结果已丢弃');
        return;
      }
      console.log('[Trigger] Pipeline 完成:', results.map(r => `${r.report_type}:${r.status}`).join(', '));
    })
    .catch(err => {
      console.error('[Trigger] Pipeline 异常:', err.message);
    })
    .finally(() => {
      clearTimeout(timer);
      pipelineLock.release(lockTag);
    });
});

app.get('/api/pipeline-status', requireAuth, async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(Number).filter(n => n > 0);
    if (!ids.length) return res.json({ records: [] });
    const records = await db.getRecordsByIds(ids);
    res.json({ records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 游戏缓存 API
app.get('/api/cache', requireAuth, (req, res) => {
  const cache = gameCache.loadCache();
  const entries = Object.entries(cache).map(([name, info]) => ({ name, ...info }));
  res.json({ total: entries.length, entries });
});

app.put('/api/cache/:name', requireAuth, (req, res) => {
  const name = req.params.name;
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    return res.status(400).json({ error: '无效的缓存键名' });
  }
  const { link, type, category } = req.body;
  gameCache.updateCacheEntry(name, link, type, category);
  res.json({ success: true });
});

// 发送目标管理 API
app.get('/api/targets', requireAuth, (req, res) => {
  const targets = sendTargets.loadTargets();
  res.json(targets);
});

app.post('/api/targets', requireAuth, async (req, res) => {
  const { type, target, name } = req.body || {};
  if (!type || !target) return res.status(400).json({ error: '缺少 type 或 target' });
  if (!['chat', 'user'].includes(type)) return res.status(400).json({ error: 'type 必须为 chat 或 user' });
  const entry = await sendTargets.addTarget({ type, target, name });
  res.json(entry);
});

app.put('/api/targets/:id', requireAuth, async (req, res) => {
  const updated = await sendTargets.updateTarget(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: '目标不存在' });
  res.json(updated);
});

app.delete('/api/targets/:id', requireAuth, async (req, res) => {
  const removed = await sendTargets.removeTarget(req.params.id);
  if (!removed) return res.status(404).json({ error: '目标不存在' });
  res.json({ success: true });
});

// 分析洞察 API
app.get('/api/insights', requireAuth, async (req, res) => {
  try {
    const { type, insightType, dateRange, page = 1, pageSize = 20 } = req.query;
    const result = await db.getInsightsFiltered({
      report_type: type || undefined,
      insight_type: insightType || undefined,
      dateRange: dateRange || undefined,
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/insights/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: '无效的 ID' });
    const record = await db.getInsightById(id);
    if (!record) return res.status(404).json({ error: '洞察不存在' });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
