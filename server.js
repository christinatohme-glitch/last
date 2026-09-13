const express = require("express");
const path = require("path");
const os = require("os");
const storage = require("./db");
const reportDesktopArchive = require("./reportDesktopArchive");
const companyBackup = require("./companyBackup");

const app = express();
const PORT = process.env.PORT || 3847;
const HOST = process.env.VISIONBOOKS_HOST || "0.0.0.0";
const BODY_LIMIT = process.env.VISIONBOOKS_BODY_LIMIT || "50gb";
const NODE_MEMORY_MB = Number(process.env.VISIONBOOKS_NODE_MEMORY_MB || 8192) || 8192;
const SERVER_INSTANCE_TOKEN = process.env.VISIONBOOKS_SERVER_INSTANCE_TOKEN || "standalone-server";

function getLanAddresses() {
  const ips = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net.family === "IPv4" && !net.internal) {
        ips.push({ interface: name, address: net.address });
      }
    });
  });
  return ips;
}

function getNetworkInfo() {
  const addresses = getLanAddresses();
  return {
    port: PORT,
    host: HOST,
    addresses,
    links: addresses.map((item) => `http://${item.address}:${PORT}`)
  };
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: BODY_LIMIT }));
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/xlsx", express.static(path.join(__dirname, "node_modules/xlsx/dist")));
app.use("/vendor/mammoth", express.static(path.join(__dirname, "node_modules/mammoth")));
app.use("/vendor/pdfjs", express.static(path.join(__dirname, "public/vendor/pdfjs")));
app.use("/vendor/html2canvas", express.static(path.join(__dirname, "node_modules/html2canvas/dist")));

storage.initDb().then(() => {
  companyBackup.startPeriodicDatabaseBackup(storage);

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      serverInstanceToken: SERVER_INSTANCE_TOKEN,
      dbPath: storage.dbPath,
      storage: storage.getStorageStats(),
      backups: companyBackup.getBackupStats(),
      network: getNetworkInfo()
    });
  });

  app.get("/api/backups/stats", (_req, res) => {
    res.json({
      storage: storage.getStorageStats(),
      backups: companyBackup.getBackupStats()
    });
  });

  app.post("/api/backups/database", (_req, res) => {
    try {
      const result = companyBackup.backupDatabaseFile(storage.dbPath, "api");
      res.json({ ok: true, backup: result });
    } catch (err) {
      res.status(500).json({ error: err.message || "Database backup failed." });
    }
  });

  app.post("/api/backups/company/:companyId", (req, res) => {
    try {
      const result = companyBackup.backupCompanySnapshot(storage, req.params.companyId);
      res.json({ ok: true, backup: result });
    } catch (err) {
      res.status(500).json({ error: err.message || "Company backup failed." });
    }
  });

  app.get("/api/backups/company/:companyId", (req, res) => {
    res.json(companyBackup.listCompanyBackups(req.params.companyId));
  });

  app.get("/api/network/info", (_req, res) => {
    res.json(getNetworkInfo());
  });

  app.get("/api/bootstrap", (_req, res) => {
    res.json({
      appUsers: storage.getGlobalConfig("appUsers"),
      appAdmins: storage.getGlobalConfig("appAdmins"),
      settingsPassword: storage.getGlobalConfig("settingsPassword"),
      usersWorkLog: storage.getGlobalConfig("usersWorkLog"),
      companyOwners: storage.getGlobalConfig("companyOwners"),
      userEmployeeTeams: storage.getGlobalConfig("userEmployeeTeams"),
      companyFileMeta: storage.getGlobalConfig("companyFileMeta"),
      modifyFeatureGlobalLocks: storage.getGlobalConfig("modifyFeatureGlobalLocks"),
      userModifyAccess: storage.getGlobalConfig("userModifyAccess"),
      firebaseSyncSettings: storage.getGlobalConfig("firebaseSyncSettings"),
      firebaseAutoSyncEnabled: storage.getGlobalConfig("firebaseAutoSyncEnabled"),
      companies: storage.listCompanies(),
      deletedCompanies: storage.listDeletedCompanies()
    });
  });

  app.get("/api/global/config/:key", (req, res) => {
    res.json({ value: storage.getGlobalConfig(req.params.key) });
  });

  app.put("/api/global/config/:key", (req, res) => {
    storage.putGlobalConfig(req.params.key, req.body.value);
    res.json({ ok: true });
  });

  const LIVE_MIRROR_SCREEN_TTL_MS = 45000;
  const liveMirrorScreens = new Map();

  function pruneLiveMirrorScreens() {
    const now = Date.now();
    for (const [id, row] of liveMirrorScreens) {
      if (!row || now - row.updatedAt > LIVE_MIRROR_SCREEN_TTL_MS) {
        liveMirrorScreens.delete(id);
      }
    }
  }

  app.post("/api/live-mirror/screenshot", (req, res) => {
    const body = req.body || {};
    const sessionId = String(body.sessionId || "").trim();
    const image = String(body.image || "");
    if (!sessionId || !image.startsWith("data:image/")) {
      res.status(400).json({ error: "Invalid live mirror screenshot payload." });
      return;
    }
    if (image.length > 600000) {
      res.status(413).json({ error: "Screenshot too large." });
      return;
    }
    liveMirrorScreens.set(sessionId, {
      sessionId,
      userName: String(body.userName || ""),
      companyName: String(body.companyName || ""),
      activity: String(body.activity || ""),
      pageId: String(body.pageId || ""),
      image,
      updatedAt: Date.now()
    });
    pruneLiveMirrorScreens();
    res.json({ ok: true });
  });

  app.get("/api/live-mirror/screenshots", (req, res) => {
    pruneLiveMirrorScreens();
    const wanted = String(req.query.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const wantedSet = wanted.length ? new Set(wanted) : null;
    const screenshots = {};
    for (const [id, row] of liveMirrorScreens) {
      if (wantedSet && !wantedSet.has(id)) continue;
      screenshots[id] = row;
    }
    res.json({ screenshots });
  });

  app.get("/api/companies", (req, res) => {
    if (req.query.deleted === "1") {
      res.json(storage.listDeletedCompanies());
      return;
    }
    res.json(storage.listCompanies());
  });

  app.get("/api/companies/ids", (_req, res) => {
    res.json(storage.listCompanyIds());
  });

  app.post("/api/companies", (req, res) => {
    storage.upsertCompany(req.body);
    storage.flushDb();
    res.json({ ok: true });
  });

  app.put("/api/companies/:companyId", (req, res) => {
    storage.updateCompanyName(req.params.companyId, req.body.name);
    storage.flushDb();
    res.json({ ok: true });
  });

  app.post("/api/companies/:companyId/soft-delete", (req, res) => {
    storage.softDeleteCompany(req.params.companyId);
    res.json({ ok: true });
  });

  app.post("/api/companies/:companyId/restore", (req, res) => {
    storage.restoreCompany(req.params.companyId);
    res.json({ ok: true });
  });

  app.delete("/api/companies/:companyId", (req, res) => {
    storage.deleteCompanyPermanently(req.params.companyId);
    res.json({ ok: true });
  });

  app.delete("/api/companies", (_req, res) => {
    storage.deleteAllCompanies();
    res.json({ ok: true });
  });

  app.get("/api/companies/:companyId/config", (req, res) => {
    res.json(storage.getAllCompanyConfig(req.params.companyId));
  });

  app.get("/api/companies/:companyId/config/:key", (req, res) => {
    res.json({ value: storage.getCompanyConfig(req.params.companyId, req.params.key) });
  });

  app.put("/api/companies/:companyId/config", (req, res) => {
    storage.putCompanyConfig(req.params.companyId, req.body);
    storage.flushDb();
    companyBackup.afterCompanyDataSaved(storage, req.params.companyId);
    res.json({ ok: true });
  });

  app.get("/api/companies/:companyId/invoices", (req, res) => {
    res.json(storage.listInvoices(req.params.companyId));
  });

  app.put("/api/companies/:companyId/invoices/bulk", (req, res) => {
    const invoices = Array.isArray(req.body.invoices) ? req.body.invoices : [];
    const saved = storage.replaceCompanyInvoices(req.params.companyId, invoices);
    companyBackup.afterInvoicesSaved(storage, req.params.companyId);
    res.json(saved);
  });

  app.post("/api/companies/:companyId/invoices", (req, res) => {
    const saved = storage.saveInvoice(req.params.companyId, req.body);
    companyBackup.afterInvoicesSaved(storage, req.params.companyId);
    res.json(saved);
  });

  app.put("/api/companies/:companyId/invoices/:invoiceId", (req, res) => {
    const invoice = { ...req.body, id: Number(req.params.invoiceId) };
    const saved = storage.saveInvoice(req.params.companyId, invoice);
    companyBackup.afterInvoicesSaved(storage, req.params.companyId);
    res.json(saved);
  });

  app.delete("/api/companies/:companyId/invoices/:invoiceId", (req, res) => {
    storage.deleteInvoice(req.params.companyId, Number(req.params.invoiceId));
    companyBackup.afterInvoicesSaved(storage, req.params.companyId);
    res.json({ ok: true });
  });

  app.delete("/api/companies/:companyId/invoices", (req, res) => {
    storage.clearInvoices(req.params.companyId);
    companyBackup.afterInvoicesSaved(storage, req.params.companyId);
    res.json({ ok: true });
  });

  app.get("/api/companies/:companyId/reports/cash-flow", (req, res) => {
    const dateFrom = String(req.query.from || "").trim();
    const dateTo = String(req.query.to || "").trim();
    if (!dateFrom || !dateTo) {
      res.status(400).json({ error: "Query parameters 'from' and 'to' (YYYY-MM-DD) are required." });
      return;
    }
    const defaultRate = Number(req.query.rate || 89500) || 89500;
    try {
      const report = storage.getCashFlowReport(req.params.companyId, dateFrom, dateTo, {
        defaultRate
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to build cash flow report." });
    }
  });

  app.post("/api/reports/desktop-save", (req, res) => {
    try {
      const result = reportDesktopArchive.appendDesktopReport(req.body || {});
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message || "Failed to save report to Desktop." });
    }
  });

  app.get("/api/reports/desktop-archive", (_req, res) => {
    res.json(reportDesktopArchive.listDesktopReportArchive());
  });

  app.get("/api/reports/desktop-archive/:year/:category", (req, res) => {
    try {
      res.json(reportDesktopArchive.readDesktopReportFile(req.params.year, req.params.category));
    } catch (err) {
      res.status(404).json({ error: err.message || "Report file not found." });
    }
  });

  app.post("/api/reports/desktop-open-file", (req, res) => {
    try {
      res.json(reportDesktopArchive.openDesktopReportFile(req.body.year, req.body.category));
    } catch (err) {
      res.status(400).json({ error: err.message || "Could not open file." });
    }
  });

  app.post("/api/reports/desktop-open-folder", (req, res) => {
    try {
      const year = req.body && req.body.year != null ? req.body.year : null;
      res.json(reportDesktopArchive.openDesktopReportsFolder(year));
    } catch (err) {
      res.status(400).json({ error: err.message || "Could not open folder." });
    }
  });

  app.get("/api/reports/desktop-files", (_req, res) => {
    res.json(reportDesktopArchive.listDesktopReportArchive());
  });

  app.get("/cashFlowEngine.js", (_req, res) => {
    res.sendFile(path.join(__dirname, "cashFlowEngine.js"));
  });

  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  const httpServer = app.listen(PORT, HOST, () => {
    const network = getNetworkInfo();
    console.log(`Talyfocous running on port ${PORT}`);
    console.log(`Local:   http://localhost:${PORT}`);
    network.links.forEach((link) => console.log(`Network: ${link}`));
    console.log(`SQLite database: ${storage.dbPath}`);
    console.log(`Request body limit: ${BODY_LIMIT}`);
    console.log(`Node memory target: ${NODE_MEMORY_MB} MB`);
  });
  httpServer.on("error", (err) => {
    console.error("Talyfocous server listen error:", err.message);
    if (process.env.VISIONBOOKS_EMBEDDED_SERVER !== "1") process.exit(1);
  });
}).catch((err) => {
  console.error("Failed to start Talyfocous:", err);
  process.exit(1);
});
