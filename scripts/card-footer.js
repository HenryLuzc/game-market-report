/**
 * 卡片底部「数据来源」备注元素。
 * 若 data_source_url 可用，则把数据源文档名渲染为可点击链接（lark_md），
 * 否则退回纯文本，保证老数据/缺配置时不会出现空链接。
 */

// 只允许 http/https，避免把 javascript: 之类的内容拼进卡片
function safeUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return '';
  // lark_md 链接语法里的括号会截断 URL，需转义
  return trimmed.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// 转义 lark_md 里会被当作语法的字符
function escapeMd(text) {
  return String(text).replace(/([\\`*_[\]()~])/g, '\\$1');
}

/**
 * 把数据源文本中的文档名替换成 markdown 链接。
 * 例：'飞书文档《2026媒体广告消耗》' + name='2026媒体广告消耗'
 *  => '飞书文档《[2026媒体广告消耗](https://...)》'
 * 未提供 name 时，整段数据源文本作为链接文字。
 */
function linkifyDataSource(dataSource, url, name) {
  const text = dataSource == null ? '' : String(dataSource);
  const href = safeUrl(url);
  if (!text) return '';
  if (!href) return escapeMd(text);

  const link = (label) => `[${escapeMd(label)}](${href})`;

  if (name) {
    const idx = text.indexOf(name);
    if (idx !== -1) {
      return escapeMd(text.slice(0, idx)) + link(name) + escapeMd(text.slice(idx + name.length));
    }
  }

  // 没给 name 或没匹配上：尝试取《》中的内容作为链接文字
  const bracket = text.match(/《([^》]+)》/);
  if (bracket) {
    const inner = bracket[1];
    const idx = text.indexOf(bracket[0]);
    return escapeMd(text.slice(0, idx)) + '《' + link(inner) + '》'
      + escapeMd(text.slice(idx + bracket[0].length));
  }

  return link(text);
}

/**
 * 构造卡片底部「数据来源」区块。
 *
 * 有链接时用 markdown 元素：note 元素是小号灰字，会把链接色压得很淡、看不出可点击；
 * markdown 元素走飞书原生蓝色链接样式，再配 🔗 图标，一眼能看出是链接。
 * 「链接来源 / 分析时间」这类附属信息仍留在 note 里保持脚注观感。
 *
 * @param {object} data 卡片输入数据（含 data_source / data_source_url / data_source_name / analysis_date）
 * @param {string} linkSource 「链接来源」展示文字
 * @returns {object[]} 卡片元素数组（可用展开运算符塞进 elements）
 */
function buildFooterNote(data, linkSource) {
  const analysisDate = data.analysis_date || '';
  const dataSource = data.data_source || '';
  const sourceText = linkifyDataSource(dataSource, data.data_source_url, data.data_source_name);
  const hasLink = sourceText !== escapeMd(dataSource);

  const meta = `链接来源：${linkSource} | 分析时间：${analysisDate}`;

  if (!hasLink) {
    // 没配链接时保持原样：单个 note，纯文本
    return [{
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `数据来源：${dataSource} | ${meta}` }],
    }];
  }

  return [
    { tag: 'markdown', content: `🔗 数据来源：${sourceText}` },
    { tag: 'note', elements: [{ tag: 'plain_text', content: meta }] },
  ];
}

module.exports = { buildFooterNote, linkifyDataSource };
