const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");
const { buildCashFlowReportFromDb } = require("./cashFlowEngine");

const legacyDataDir = path.join(__dirname, "data");
const dataDir = process.env.VISIONBOOKS_DATA_DIR
  ? path.resolve(process.env.VISIONBOOKS_DATA_DIR)
  : legacyDataDir;
const dbPath = path.join(dataDir, "visionbooks.db");
const PERSIST_DEBOUNCE_MS = 400;

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Older versions stored the database beside the application. Move a copy to
// Windows' persistent per-user app-data folder the first time the new version runs.
if (dataDir !== legacyDataDir && !fs.existsSync(dbPath)) {
  const legacyDbPath = path.join(legacyDataDir, "visionbooks.db");
  if (fs.existsSync(legacyDbPath)) {
    fs.copyFileSync(legacyDbPath, dbPath);
    const legacyBackupPath = legacyDbPath + ".bak";
    if (fs.existsSync(legacyBackupPath)) {
      fs.copyFileSync(legacyBackupPath, dbPath + ".bak");
    }
  }
}

if (dataDir !== legacyDataDir) {
  ["backups", "VisionBooks Reports"].forEach((folderName) => {
    const legacyFolder = path.join(legacyDataDir, folderName);
    const persistentFolder = path.join(dataDir, folderName);
    if (fs.existsSync(legacyFolder) && !fs.existsSync(persistentFolder)) {
      fs.cpSync(legacyFolder, persistentFolder, { recursive: true, force: false });
    }
  });
}

let db = null;
let persistTimer = null;
let persistPending = false;

function persistDbNow() {
  if (!db) return;
  try {
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, dbPath + ".bak");
    }
  } catch (_) {}
  const data = db.export();
  const tmpPath = dbPath + ".tmp";
  fs.writeFileSync(tmpPath, Buffer.from(data));
  fs.renameSync(tmpPath, dbPath);
  persistPending = false;
}

function schedulePersistDb() {
  persistPending = true;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (persistPending) persistDbNow();
  }, PERSIST_DEBOUNCE_MS);
}

function flushDb() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistPending) persistDbNow();
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length ? rows[0] : null;
}

function runSqlNoPersist(sql, params = []) {
  db.run(sql, params);
}

function runSql(sql, params = []) {
  runSqlNoPersist(sql, params);
  schedulePersistDb();
}

function runInTransaction(fn) {
  runSqlNoPersist("BEGIN IMMEDIATE");
  try {
    const result = fn();
    runSqlNoPersist("COMMIT");
    schedulePersistDb();
    return result;
  } catch (err) {
    try {
      runSqlNoPersist("ROLLBACK");
    } catch (_) {}
    throw err;
  }
}

function applyStoragePragmas() {
  try {
    runSqlNoPersist("PRAGMA synchronous = NORMAL");
    runSqlNoPersist("PRAGMA temp_store = MEMORY");
    runSqlNoPersist("PRAGMA cache_size = -500000");
  } catch (_) {}
}

function ensureCompaniesFiscalYearColumn() {
  try {
    const cols = queryAll("PRAGMA table_info(companies)");
    const hasColumn = cols.some((col) => col.name === "fiscal_year");
    if (!hasColumn) {
      runSql("ALTER TABLE companies ADD COLUMN fiscal_year INTEGER");
    }
  } catch (_) {}
}

function normalizeFiscalYear(value) {
  const year = parseInt(value, 10);
  if (isNaN(year) || year < 1990 || year > 2100) return null;
  return year;
}

function initDb() {
  if (db) return Promise.resolve(db);

  return initSqlJs().then((SQL) => {
    if (fs.existsSync(dbPath)) {
      db = new SQL.Database(fs.readFileSync(dbPath));
    } else {
      db = new SQL.Database();
    }

    applyStoragePragmas();

    db.run(`
      CREATE TABLE IF NOT EXISTS global_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0
      )
    `);
    ensureCompaniesFiscalYearColumn();
    db.run(`
      CREATE TABLE IF NOT EXISTS company_config (
        company_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (company_id, key)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_invoices_company_id
      ON invoices (company_id)
    `);
    schedulePersistDb();
    return db;
  });
}

function getGlobalConfig(key) {
  const row = queryOne("SELECT value FROM global_config WHERE key = ?", [key]);
  return row ? parseJson(row.value) : null;
}

function putGlobalConfig(key, value) {
  runSql(`
    INSERT INTO global_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [key, JSON.stringify(value)]);
}

function listCompanies() {
  return queryAll(`
    SELECT id, name, created_at AS createdAt, fiscal_year AS fiscalYear
    FROM companies
    WHERE is_deleted = 0
    ORDER BY created_at
  `);
}

function listDeletedCompanies() {
  return queryAll(`
    SELECT id, name, created_at AS createdAt, deleted_at AS deletedAt, fiscal_year AS fiscalYear
    FROM companies
    WHERE is_deleted = 1
    ORDER BY deleted_at DESC
  `);
}

function listCompanyIds() {
  return queryAll("SELECT id FROM companies").map((row) => row.id);
}

function upsertCompany(company) {
  const fiscalYear = normalizeFiscalYear(company.fiscalYear);
  runSql(`
    INSERT INTO companies (id, name, created_at, fiscal_year, deleted_at, is_deleted)
    VALUES (?, ?, ?, ?, NULL, 0)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      created_at = excluded.created_at,
      fiscal_year = COALESCE(excluded.fiscal_year, companies.fiscal_year),
      deleted_at = NULL,
      is_deleted = 0
  `, [company.id, company.name, company.createdAt || new Date().toISOString(), fiscalYear]);
}

function updateCompanyName(companyId, name) {
  runSql("UPDATE companies SET name = ? WHERE id = ?", [name, companyId]);
}

function softDeleteCompany(companyId) {
  runSql(`
    UPDATE companies
    SET is_deleted = 1, deleted_at = ?
    WHERE id = ?
  `, [new Date().toISOString(), companyId]);
}

function restoreCompany(companyId) {
  runSql(`
    UPDATE companies
    SET is_deleted = 0, deleted_at = NULL
    WHERE id = ?
  `, [companyId]);
}

function deleteCompanyPermanently(companyId) {
  runInTransaction(() => {
    runSqlNoPersist("DELETE FROM invoices WHERE company_id = ?", [companyId]);
    runSqlNoPersist("DELETE FROM company_config WHERE company_id = ?", [companyId]);
    runSqlNoPersist("DELETE FROM companies WHERE id = ?", [companyId]);
  });
}

function deleteAllCompanies() {
  runInTransaction(() => {
    runSqlNoPersist("DELETE FROM invoices");
    runSqlNoPersist("DELETE FROM company_config");
    runSqlNoPersist("DELETE FROM companies");
  });
}

function getCompanyConfig(companyId, key) {
  const row = queryOne(
    "SELECT value FROM company_config WHERE company_id = ? AND key = ?",
    [companyId, key]
  );
  return row ? parseJson(row.value) : null;
}

function getAllCompanyConfig(companyId) {
  const rows = queryAll(
    "SELECT key, value FROM company_config WHERE company_id = ?",
    [companyId]
  );
  const config = {};
  rows.forEach((row) => {
    config[row.key] = parseJson(row.value);
  });
  return config;
}

function putCompanyConfig(companyId, entries) {
  runInTransaction(() => {
    Object.entries(entries).forEach(([key, value]) => {
      runSqlNoPersist(`
        INSERT INTO company_config (company_id, key, value) VALUES (?, ?, ?)
        ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value
      `, [companyId, key, JSON.stringify(value)]);
    });
  });
}

function listInvoices(companyId) {
  return queryAll(
    "SELECT id, data FROM invoices WHERE company_id = ? ORDER BY id",
    [companyId]
  ).map((row) => {
    const invoice = parseJson(row.data, {});
    invoice.id = row.id;
    return invoice;
  });
}

function saveInvoice(companyId, invoice) {
  const payload = { ...invoice };
  const invoiceId = payload.id;
  delete payload.id;

  if (invoiceId) {
    runSql(
      "UPDATE invoices SET data = ? WHERE id = ? AND company_id = ?",
      [JSON.stringify(payload), invoiceId, companyId]
    );
    return { ...payload, id: invoiceId };
  }

  runSql(
    "INSERT INTO invoices (company_id, data) VALUES (?, ?)",
    [companyId, JSON.stringify(payload)]
  );
  const row = queryOne("SELECT last_insert_rowid() AS id");
  return { ...payload, id: row.id };
}

function replaceCompanyInvoices(companyId, invoices) {
  const list = Array.isArray(invoices) ? invoices : [];
  const saved = runInTransaction(() => {
    runSqlNoPersist("DELETE FROM invoices WHERE company_id = ?", [companyId]);
    const insertStmt = db.prepare(
      "INSERT INTO invoices (company_id, data) VALUES (?, ?)"
    );
    const results = [];
    try {
      list.forEach((invoice) => {
        const payload = { ...invoice };
        delete payload.id;
        insertStmt.run([companyId, JSON.stringify(payload)]);
        const row = queryOne("SELECT last_insert_rowid() AS id");
        results.push({ ...payload, id: row.id });
      });
    } finally {
      insertStmt.free();
    }
    return results;
  });
  flushDb();
  return saved;
}

function deleteInvoice(companyId, invoiceId) {
  runSql("DELETE FROM invoices WHERE company_id = ? AND id = ?", [companyId, invoiceId]);
}

function clearInvoices(companyId) {
  runSql("DELETE FROM invoices WHERE company_id = ?", [companyId]);
}

function getCashFlowReport(companyId, dateFrom, dateTo, rates) {
  return buildCashFlowReportFromDb(
    { listInvoices, getAllCompanyConfig },
    companyId,
    dateFrom,
    dateTo,
    rates
  );
}

function getStorageStats() {
  let dbSizeBytes = 0;
  try {
    if (fs.existsSync(dbPath)) {
      dbSizeBytes = fs.statSync(dbPath).size;
    }
  } catch (_) {}

  const companies = queryOne("SELECT COUNT(*) AS count FROM companies WHERE is_deleted = 0") || { count: 0 };
  const deleted = queryOne("SELECT COUNT(*) AS count FROM companies WHERE is_deleted = 1") || { count: 0 };
  const invoices = queryOne("SELECT COUNT(*) AS count FROM invoices") || { count: 0 };

  return {
    dbPath,
    dbSizeBytes,
    dbSizeMB: Math.round((dbSizeBytes / (1024 * 1024)) * 100) / 100,
    activeCompanies: companies.count,
    deletedCompanies: deleted.count,
    invoiceCount: invoices.count
  };
}

process.on("exit", flushDb);
process.on("SIGINT", () => {
  flushDb();
  process.exit(0);
});
process.on("SIGTERM", () => {
  flushDb();
  process.exit(0);
});

module.exports = {
  dataDir,
  dbPath,
  initDb,
  flushDb,
  getStorageStats,
  getGlobalConfig,
  putGlobalConfig,
  listCompanies,
  listDeletedCompanies,
  listCompanyIds,
  upsertCompany,
  updateCompanyName,
  softDeleteCompany,
  restoreCompany,
  deleteCompanyPermanently,
  deleteAllCompanies,
  getCompanyConfig,
  getAllCompanyConfig,
  putCompanyConfig,
  listInvoices,
  saveInvoice,
  replaceCompanyInvoices,
  deleteInvoice,
  clearInvoices,
  getCashFlowReport
};
