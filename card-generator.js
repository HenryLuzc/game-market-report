const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(config.TEMP_DIR, { recursive: true });

let tempCounter = 0;

function tempFile(prefix, ext) {
  tempCounter++;
  return path.join(config.TEMP_DIR, `${prefix}_${Date.now()}_${tempCounter}${ext}`);
}

function generateCard(scriptPath, inputData) {
  const inputFile = tempFile('input', '.json');
  const outputFile = tempFile('output', '.json');

  try {
    fs.writeFileSync(inputFile, JSON.stringify(inputData, null, 2), 'utf-8');
    execFileSync('node', [scriptPath, inputFile, outputFile], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    const cardJson = fs.readFileSync(outputFile, 'utf-8');
    return JSON.parse(cardJson);
  } finally {
    try { fs.unlinkSync(inputFile); } catch {}
    try { fs.unlinkSync(outputFile); } catch {}
  }
}

function generateTencentCard(inputData) {
  return generateCard(config.TENCENT_CARD_SCRIPT, inputData);
}

function generateByteDanceCard(inputData) {
  return generateCard(config.BYTEDANCE_CARD_SCRIPT, inputData);
}

function generateTencentAppCard(inputData) {
  return generateCard(config.TENCENT_APP_CARD_SCRIPT, inputData);
}

function generateByteDanceAppCard(inputData) {
  return generateCard(config.BYTEDANCE_APP_CARD_SCRIPT, inputData);
}

module.exports = { generateTencentCard, generateByteDanceCard, generateTencentAppCard, generateByteDanceAppCard };
