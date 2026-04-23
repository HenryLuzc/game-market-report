const config = require('./config');

const BASE_URL = config.FEISHU_BASE_URL;

let tokenCache = { token: null, expiresAt: 0 };
let tokenPromise = null;

async function getTenantToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    if (!config.FEISHU_APP_SECRET) {
      throw new Error('FEISHU_APP_SECRET 未设置');
    }
    const resp = await fetch(`${BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.FEISHU_APP_ID,
        app_secret: config.FEISHU_APP_SECRET,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    if (data.code !== 0) {
      throw new Error(`获取 tenant_access_token 失败: ${data.msg} (code: ${data.code})`);
    }
    tokenCache = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + data.expire * 1000,
    };
    return tokenCache.token;
  })().finally(() => { tokenPromise = null; });

  return tokenPromise;
}

async function feishuRequest(method, path, { body, params, retries = 2 } = {}) {
  let url = `${BASE_URL}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = await getTenantToken();
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    };
    if (body) options.body = JSON.stringify(body);

    const resp = await fetch(url, options);
    let data;
    try {
      data = await resp.json();
    } catch {
      throw new Error(`飞书 API 返回非 JSON [${method} ${path}]: HTTP ${resp.status}`);
    }

    // Token expired — clear cache and retry
    if (data.code === 99991663 || data.code === 99991664) {
      tokenCache = { token: null, expiresAt: 0 };
      if (attempt < retries) continue;
    }

    if (data.code !== 0) {
      throw new Error(`飞书 API 错误 [${method} ${path}]: ${data.msg} (code: ${data.code})`);
    }
    return data;
  }
  throw new Error(`飞书 API 重试耗尽 [${method} ${path}]: token 持续过期`);
}

async function getWikiNode(wikiToken) {
  const data = await feishuRequest('GET', '/open-apis/wiki/v2/spaces/get_node', {
    params: { token: wikiToken },
  });
  const node = data?.data?.node;
  if (!node || node.obj_type !== 'sheet') {
    throw new Error(`Wiki 节点不是电子表格: ${JSON.stringify(node)}`);
  }
  return node.obj_token;
}

async function getSheetList(spreadsheetToken) {
  const data = await feishuRequest('GET', `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`);
  const sheets = data?.data?.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('未获取到标签页列表');
  }
  return sheets.map(s => ({ sheet_id: s.sheet_id, title: s.title }));
}

async function readSheet(spreadsheetToken, range) {
  const data = await feishuRequest('GET', `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`, {
    params: { valueRenderOption: 'ToString' },
  });
  const rows = data?.data?.valueRange?.values;
  if (!Array.isArray(rows)) {
    throw new Error('未读取到表格数据');
  }
  return rows;
}

async function sendMessage(content, { chatId, userId } = {}) {
  const receiveIdType = userId ? 'open_id' : 'chat_id';
  const receiveId = userId || chatId;
  if (!receiveId) throw new Error('sendMessage: 未指定发送目标 (chatId 或 userId)');
  const data = await feishuRequest('POST', '/open-apis/im/v1/messages', {
    params: { receive_id_type: receiveIdType },
    body: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: typeof content === 'string' ? content : JSON.stringify(content),
    },
  });
  return data?.data?.message_id || null;
}

async function urgentMessage(messageId, userIds) {
  await feishuRequest('PATCH', `/open-apis/im/v1/messages/${messageId}/urgent_app`, {
    params: { user_id_type: 'open_id' },
    body: { user_id_list: userIds },
  });
}

module.exports = { getTenantToken, getWikiNode, getSheetList, readSheet, sendMessage, urgentMessage };
