const feishu = require('./feishu-api');

async function getSpreadsheetToken(wikiToken) {
  return feishu.getWikiNode(wikiToken);
}

async function getSheetList(spreadsheetToken) {
  return feishu.getSheetList(spreadsheetToken);
}

async function readSheet(spreadsheetToken, sheetId) {
  return feishu.readSheet(spreadsheetToken, sheetId);
}

module.exports = { getSpreadsheetToken, getSheetList, readSheet };
