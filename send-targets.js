const fs = require('fs');
const config = require('./config');

let nextId = 1;

function loadTargets() {
  try {
    const raw = fs.readFileSync(config.SEND_TARGETS_PATH, 'utf-8');
    const targets = JSON.parse(raw);
    const maxId = targets.reduce((max, t) => Math.max(max, parseInt(t.id, 10) || 0), 0);
    nextId = maxId + 1;
    return targets;
  } catch {
    return [];
  }
}

function saveTargets(targets) {
  fs.mkdirSync(require('path').dirname(config.SEND_TARGETS_PATH), { recursive: true });
  const tmp = config.SEND_TARGETS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(targets, null, 2), 'utf-8');
  fs.renameSync(tmp, config.SEND_TARGETS_PATH);
}

function addTarget({ type, target, name }) {
  const targets = loadTargets();
  const entry = { id: String(nextId++), type, target, name: name || '' };
  targets.push(entry);
  saveTargets(targets);
  return entry;
}

function removeTarget(id) {
  const targets = loadTargets();
  const filtered = targets.filter(t => t.id !== id);
  if (filtered.length === targets.length) return false;
  saveTargets(filtered);
  return true;
}

function updateTarget(id, fields) {
  const targets = loadTargets();
  const t = targets.find(t => t.id === id);
  if (!t) return null;
  if (fields.type !== undefined) t.type = fields.type;
  if (fields.target !== undefined) t.target = fields.target;
  if (fields.name !== undefined) t.name = fields.name;
  saveTargets(targets);
  return t;
}

module.exports = { loadTargets, saveTargets, addTarget, removeTarget, updateTarget };
