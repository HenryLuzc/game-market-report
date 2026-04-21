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
  for (const t of targets) {
    const opts = t.type === 'user' ? { userId: t.target } : { chatId: t.target };
    const result = await sendCard(cardJson, opts);
    results.push({ ...result, target: t });
  }
  return results;
}

module.exports = { sendCard, sendCardToAll };
