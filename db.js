const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

let db = null;
let dbPromise = null;
let dbMtime = 0;

function getFileMtime() {
  try { return fs.statSync(config.DB_PATH).mtimeMs; } catch { return 0; }
}

async function getDb() {
  const fileMtime = getFileMtime();
  if (db && fileMtime > dbMtime) {
    // 磁盘文件被外部进程更新，重新加载
    db = null;
    dbPromise = null;
  }
  if (db) return db;
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const SQL = await initSqlJs();
    try {
      const buffer = fs.readFileSync(config.DB_PATH);
      db = new SQL.Database(buffer);
    } catch {
      db = new SQL.Database();
    }
    db.run(`
      CREATE TABLE IF NOT EXISTS send_records (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  TEXT NOT NULL,
        date_range  TEXT NOT NULL,
        report_type TEXT NOT NULL,
        status      TEXT NOT NULL,
        error_msg   TEXT,
        card_json   TEXT,
        input_json  TEXT,
        message_id  TEXT,
        send_target TEXT
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_records_type ON send_records(report_type)');
    db.run('CREATE INDEX IF NOT EXISTS idx_records_status ON send_records(status)');
    // Game tags table for raw tag history
    db.run(`
      CREATE TABLE IF NOT EXISTS game_tags (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  TEXT NOT NULL,
        game_name   TEXT NOT NULL,
        category    TEXT NOT NULL,
        source      TEXT NOT NULL,
        link        TEXT,
        raw_type    TEXT,
        norm_type   TEXT
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_game_tags_name ON game_tags(game_name)');
    db.run('CREATE INDEX IF NOT EXISTS idx_game_tags_category ON game_tags(category)');
    // Migrate: add send_target column if missing (for existing DBs)
    try { db.run('ALTER TABLE send_records ADD COLUMN send_target TEXT'); } catch {}
    dbMtime = getFileMtime();
    return db;
  })();
  return dbPromise;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(config.DB_PATH, Buffer.from(data));
  dbMtime = getFileMtime();
}

function localNow() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function rowToObj(columns, values) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[i]; });
  return obj;
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(rowToObj(stmt.getColumnNames(), stmt.get()));
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

async function insertRecord({ date_range, report_type, status, error_msg = null, card_json = null, input_json = null, message_id = null, send_target = null }) {
  await getDb();
  db.run(
    `INSERT INTO send_records (created_at, date_range, report_type, status, error_msg, card_json, input_json, message_id, send_target)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [localNow(), date_range, report_type, status, error_msg, card_json, input_json, message_id, send_target]
  );
  const row = queryOne('SELECT last_insert_rowid() as id');
  saveDb();
  return row ? row.id : null;
}

async function getRecordById(id) {
  await getDb();
  return queryOne('SELECT * FROM send_records WHERE id = ?', [id]);
}

async function getRecords({ report_type, status, page = 1, pageSize = 20 } = {}) {
  await getDb();
  let where = [];
  let params = [];
  if (report_type) { where.push('report_type = ?'); params.push(report_type); }
  if (status) { where.push('status = ?'); params.push(status); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const offset = (page - 1) * pageSize;

  const countRow = queryOne(`SELECT COUNT(*) as total FROM send_records ${whereClause}`, params);
  const rows = queryAll(
    `SELECT id, created_at, date_range, report_type, status, error_msg, message_id, send_target
     FROM send_records ${whereClause}
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return { total: countRow.total, page, pageSize, records: rows };
}

async function insertGameTag({ game_name, category, source, link = null, raw_type = null, norm_type = null }) {
  await getDb();
  db.run(
    `INSERT INTO game_tags (created_at, game_name, category, source, link, raw_type, norm_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [localNow(), game_name, category, source, link, raw_type, norm_type]
  );
  saveDb();
}

async function getGameTags({ game_name, category, page = 1, pageSize = 50 } = {}) {
  await getDb();
  let where = [];
  let params = [];
  if (game_name) { where.push('game_name = ?'); params.push(game_name); }
  if (category) { where.push('category = ?'); params.push(category); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const offset = (page - 1) * pageSize;
  const countRow = queryOne(`SELECT COUNT(*) as total FROM game_tags ${whereClause}`, params);
  const rows = queryAll(
    `SELECT * FROM game_tags ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { total: countRow.total, page, pageSize, records: rows };
}

module.exports = { getDb, insertRecord, getRecordById, getRecords, insertGameTag, getGameTags };
