const fs = require("fs");
const path = require("path");

const dataDir = process.env.VISIONBOOKS_DATA_DIR
  ? path.resolve(process.env.VISIONBOOKS_DATA_DIR)
  : path.join(__dirname, "data");
const backupRoot = path.join(dataDir, "backups");
const dbBackupDir = path.join(backupRoot, "database");
const companyBackupDir = path.join(backupRoot, "companies");

const MAX_DB_BACKUPS = 48;
const MAX_COMPANY_SNAPSHOTS = 60;
const DB_BACKUP_INTERVAL_MS = 30 * 60 * 1000;

const companyBackupTimers = {};
let dbBackupTimer = null;
let lastDbBackupAt = 0;

function ensureDirs() {
  fs.mkdirSync(dbBackupDir, { recursive: true });
  fs.mkdirSync(companyBackupDir, { recursive: true });
}

function sanitizeFilePart(value) {
  return String(value || "unknown")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "unknown";
}

function isoStamp(date) {
  return (date || new Date()).toISOString().replace(/[:.]/g, "-");
}

function writeFileAtomic(filePath, contents) {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, contents);
  fs.renameSync(tmpPath, filePath);
}

function pruneOldFiles(dir, pattern, maxKeep) {
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => {
        const fullPath = path.join(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch (_) {}
        return { name, fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (_) {
    return;
  }
  files.slice(maxKeep).forEach((file) => {
    try {
      fs.unlinkSync(file.fullPath);
    } catch (_) {}
  });
}

function findCompanyRecord(storage, companyId) {
  const active = storage.listCompanies().find((c) => c.id === companyId);
  if (active) return active;
  return storage.listDeletedCompanies().find((c) => c.id === companyId) || null;
}

function backupDatabaseFile(dbPath, reason) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  ensureDirs();
  const stamp = isoStamp();
  const dest = path.join(dbBackupDir, `visionbooks-${stamp}.db`);
  fs.copyFileSync(dbPath, dest);
  pruneOldFiles(dbBackupDir, /^visionbooks-.*\.db$/, MAX_DB_BACKUPS);
  lastDbBackupAt = Date.now();
  return { path: dest, reason: reason || "manual" };
}

function scheduleDatabaseBackup(storage, reason, minIntervalMs) {
  const interval = Number(minIntervalMs) || 5 * 60 * 1000;
  if (Date.now() - lastDbBackupAt < interval) return null;
  try {
    return backupDatabaseFile(storage.dbPath, reason);
  } catch (err) {
    console.warn("Database backup failed:", err.message || err);
    return null;
  }
}

function backupCompanySnapshot(storage, companyId) {
  ensureDirs();
  const company = findCompanyRecord(storage, companyId) || { id: companyId, name: "Company", fiscalYear: null };
  const config = storage.getAllCompanyConfig(companyId);
  const invoices = storage.listInvoices(companyId);
  const savedAt = new Date().toISOString();
  const payload = {
    version: 1,
    savedAt,
    company: {
      id: company.id,
      name: company.name || "",
      fiscalYear: company.fiscalYear != null ? company.fiscalYear : null
    },
    config,
    invoices
  };

  const companyDir = path.join(
    companyBackupDir,
    sanitizeFilePart(company.name) + "__" + String(company.fiscalYear || "year") + "__" + companyId
  );
  fs.mkdirSync(companyDir, { recursive: true });
  const fileName = "snapshot-" + isoStamp(new Date(savedAt)) + ".json";
  const filePath = path.join(companyDir, fileName);
  writeFileAtomic(filePath, JSON.stringify(payload));
  pruneOldFiles(companyDir, /^snapshot-.*\.json$/, MAX_COMPANY_SNAPSHOTS);
  return {
    path: filePath,
    companyId,
    companyName: company.name || "",
    fiscalYear: company.fiscalYear,
    savedAt,
    configKeys: Object.keys(config).length,
    invoiceCount: invoices.length
  };
}

function scheduleCompanyBackup(storage, companyId, delayMs) {
  const wait = Number(delayMs) || 8000;
  if (companyBackupTimers[companyId]) clearTimeout(companyBackupTimers[companyId]);
  companyBackupTimers[companyId] = setTimeout(() => {
    delete companyBackupTimers[companyId];
    try {
      backupCompanySnapshot(storage, companyId);
    } catch (err) {
      console.warn("Company backup failed for", companyId, err.message || err);
    }
  }, wait);
}

function listCompanyBackups(companyId) {
  ensureDirs();
  const matches = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(companyBackupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch (_) {
    return matches;
  }

  dirs.forEach((entry) => {
    if (!entry.name.endsWith("__" + companyId)) return;
    const dirPath = path.join(companyBackupDir, entry.name);
    let files = [];
    try {
      files = fs.readdirSync(dirPath)
        .filter((name) => /^snapshot-.*\.json$/.test(name));
    } catch (_) {
      return;
    }
    files.forEach((name) => {
      const fullPath = path.join(dirPath, name);
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch (_) {}
      matches.push({
        fileName: name,
        path: fullPath,
        sizeBytes: stat ? stat.size : 0,
        savedAt: stat ? stat.mtime.toISOString() : null
      });
    });
  });

  matches.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return matches;
}

function getBackupStats() {
  ensureDirs();
  let dbBackups = 0;
  let dbBackupBytes = 0;
  let companySnapshots = 0;
  let companySnapshotBytes = 0;

  try {
    fs.readdirSync(dbBackupDir).forEach((name) => {
      if (!/^visionbooks-.*\.db$/.test(name)) return;
      dbBackups += 1;
      try {
        dbBackupBytes += fs.statSync(path.join(dbBackupDir, name)).size;
      } catch (_) {}
    });
  } catch (_) {}

  try {
    fs.readdirSync(companyBackupDir, { withFileTypes: true }).forEach((entry) => {
      if (!entry.isDirectory()) return;
      const dirPath = path.join(companyBackupDir, entry.name);
      let files = [];
      try {
        files = fs.readdirSync(dirPath).filter((name) => /^snapshot-.*\.json$/.test(name));
      } catch (_) {
        return;
      }
      companySnapshots += files.length;
      files.forEach((name) => {
        try {
          companySnapshotBytes += fs.statSync(path.join(dirPath, name)).size;
        } catch (_) {}
      });
    });
  } catch (_) {}

  return {
    backupRoot,
    dbBackups,
    dbBackupBytes,
    dbBackupMB: Math.round((dbBackupBytes / (1024 * 1024)) * 100) / 100,
    companySnapshots,
    companySnapshotBytes,
    companySnapshotMB: Math.round((companySnapshotBytes / (1024 * 1024)) * 100) / 100,
    lastDbBackupAt: lastDbBackupAt ? new Date(lastDbBackupAt).toISOString() : null
  };
}

function startPeriodicDatabaseBackup(storage) {
  if (dbBackupTimer) clearInterval(dbBackupTimer);
  dbBackupTimer = setInterval(() => {
    scheduleDatabaseBackup(storage, "interval", DB_BACKUP_INTERVAL_MS - 1000);
  }, DB_BACKUP_INTERVAL_MS);
  scheduleDatabaseBackup(storage, "startup", 0);
}

function afterCompanyDataSaved(storage, companyId) {
  scheduleCompanyBackup(storage, companyId, 8000);
  scheduleDatabaseBackup(storage, "company-save", 5 * 60 * 1000);
}

function afterInvoicesSaved(storage, companyId) {
  scheduleCompanyBackup(storage, companyId, 12000);
}

module.exports = {
  backupDatabaseFile,
  backupCompanySnapshot,
  scheduleCompanyBackup,
  scheduleDatabaseBackup,
  afterCompanyDataSaved,
  afterInvoicesSaved,
  listCompanyBackups,
  getBackupStats,
  startPeriodicDatabaseBackup
};
