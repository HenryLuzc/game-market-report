const feishu = require('./feishu-api');

async function sendCard(cardJson, { chatId, userId } = {}) {
  try {
    const messageId = await feishu.sendMessage(cardJson, { chatId, userId });
    return { success: true, message_id: messageId };
  } catch (err) {
    return { success: false, error: (err.message || String(err)).slice(0, 500) };
  }
}

async function sendCardToAll(cardJson, targets) {
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const opts = t.type === 'user' ? { userId: t.target } : { chatId: t.target };
    const result = await sendCard(cardJson, opts);
    results.push({ ...result, target: t });
    // 主动节流，避免触发飞书发消息接口限流(9499)。最后一个不用等
    if (i < targets.length - 1) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

module.exports = { sendCard, sendCardToAll };
