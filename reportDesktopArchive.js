const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const CATEGORY_META = {
    "balance-sheet": { fileName: "Balance Sheet.html", title: "Balance Sheet" },
    "profit-loss": { fileName: "Profit and Loss.html", title: "Profit and Loss" },
    "cash-flow": { fileName: "Cash Flow.html", title: "Cash Flow" }
};

const CATEGORY_KEYS = Object.keys(CATEGORY_META);

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function getAppReportsDir() {
    const dataDir = process.env.VISIONBOOKS_DATA_DIR
        ? path.resolve(process.env.VISIONBOOKS_DATA_DIR)
        : path.join(__dirname, "data");
    return path.join(dataDir, "VisionBooks Reports");
}

function getDesktopBaseCandidates() {
    const home = os.homedir();
    return [
        path.join(home, "Desktop"),
        path.join(home, "OneDrive", "Desktop"),
        path.join(home, "Documents")
    ];
}

function scoreReportsDir(dir) {
    if (!dir || !fs.existsSync(dir)) return 0;
    let score = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.forEach(function(dirent) {
            if (dirent.isDirectory() && /^\d{4}$/.test(dirent.name)) score += 2;
            if (dirent.isFile() && /\.html$/i.test(dirent.name)) score += 1;
        });
    } catch (_) {}
    return score;
}

function getDesktopReportsDir() {
    const home = os.homedir();
    const candidates = getDesktopBaseCandidates();
    let bestDir = "";
    let bestScore = -1;

    candidates.forEach(function(base) {
        if (!fs.existsSync(base)) return;
        const dir = path.join(base, "VisionBooks Reports");
        const score = scoreReportsDir(dir);
        if (score > bestScore) {
            bestScore = score;
            bestDir = dir;
        }
    });

    if (bestDir) return bestDir;

    for (let i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) {
            return path.join(candidates[i], "VisionBooks Reports");
        }
    }
    return path.join(home, "VisionBooks Reports");
}

function getWritableReportsDirs() {
    const dirs = [];
    const appDir = getAppReportsDir();
    fs.mkdirSync(appDir, { recursive: true });
    dirs.push(appDir);

    const desktopDir = getDesktopReportsDir();
    if (desktopDir !== appDir) {
        try {
            fs.mkdirSync(desktopDir, { recursive: true });
            dirs.push(desktopDir);
        } catch (_) {}
    }
    return dirs;
}

function normalizeCategoryKey(category) {
    const key = String(category || "").trim();
    return CATEGORY_META[key] ? key : "";
}

function resolveReportYear(entry) {
    let year = parseInt(entry.reportYear, 10);
    if (!isNaN(year) && year >= 1990 && year <= 2100) return year;

    let dateTo = String(entry.dateTo || "").trim();
    let dmyMatch = dateTo.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmyMatch) {
        year = parseInt(dmyMatch[3], 10);
        if (!isNaN(year)) return year;
    }

    let isoMatch = dateTo.match(/^(\d{4})-\d{2}-\d{2}$/);
    if (isoMatch) {
        year = parseInt(isoMatch[1], 10);
        if (!isNaN(year)) return year;
    }

    if (entry.savedAt) {
        year = new Date(entry.savedAt).getFullYear();
        if (!isNaN(year)) return year;
    }

    return new Date().getFullYear();
}

function getYearDir(rootDir, year) {
    return path.join(rootDir, String(year));
}

function getCategoryFilePath(rootDir, year, categoryKey) {
    const meta = CATEGORY_META[categoryKey];
    if (!meta) return "";
    return path.join(getYearDir(rootDir, year), meta.fileName);
}

function getMasterStyles() {
    return ""
        + "body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#0f172a;background:#f8fafc;}"
        + "h1{font-size:22px;margin:0 0 8px;}"
        + ".vb-intro{color:#64748b;font-size:13px;margin:0 0 20px;}"
        + ".vb-entry{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin:0 0 18px;box-shadow:0 2px 8px rgba(15,23,42,.06);}"
        + ".vb-entry h2{font-size:17px;margin:0 0 6px;color:#1e3a8a;}"
        + ".vb-meta{color:#64748b;font-size:13px;margin:0 0 12px;}"
        + ".vb-content table{border-collapse:collapse;width:100%;font-size:13px;}"
        + ".vb-content th,.vb-content td{border:1px solid #e2e8f0;padding:6px 8px;}"
        + ".vb-content th{background:#f1f5f9;text-align:left;}"
        + ".summary-section{margin-top:12px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;}"
        + ".summary-item{display:flex;justify-content:space-between;gap:12px;padding:4px 0;}";
}

function buildMasterHtml(categoryKey, year) {
    const meta = CATEGORY_META[categoryKey];
    return ""
        + "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n"
        + "<meta charset=\"utf-8\">\n"
        + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        + "<title>VisionBooks " + year + " — " + escapeHtml(meta.title) + "</title>\n"
        + "<style>" + getMasterStyles() + "</style>\n"
        + "</head>\n<body>\n"
        + "<h1>VisionBooks " + year + " — " + escapeHtml(meta.title) + "</h1>\n"
        + "<p class=\"vb-intro\">All saved " + escapeHtml(meta.title.toLowerCase())
        + " reports for " + year + " from every company file (newest first).</p>\n"
        + "<div id=\"vb-entries\">\n</div>\n"
        + "</body>\n</html>\n";
}

function buildEntryHtml(entry) {
    const title = entry.reportName
        ? String(entry.reportName).trim()
        : (entry.entryTitle || entry.companyName || "Report");
    const period = (entry.dateFrom && entry.dateTo)
        ? ("Period: " + entry.dateFrom + " – " + entry.dateTo)
        : "";
    const savedLine = entry.savedAtDisplay
        ? ("Saved: " + entry.savedAtDisplay)
        : (entry.savedAt ? ("Saved: " + entry.savedAt) : "");
    const metaParts = [
        entry.reportName && entry.companyName ? entry.companyName : "",
        period,
        savedLine
    ].filter(Boolean).join(" · ");

    return ""
        + "<article class=\"vb-entry\" data-id=\"" + escapeHtml(entry.id || "") + "\""
        + " data-company=\"" + escapeHtml(entry.companyName || "") + "\""
        + " data-saved=\"" + escapeHtml(entry.savedAt || "") + "\">\n"
        + "<h2>" + escapeHtml(title) + "</h2>\n"
        + (metaParts ? "<p class=\"vb-meta\">" + escapeHtml(metaParts) + "</p>\n" : "")
        + "<div class=\"vb-content\">\n" + (entry.html || "") + "\n</div>\n"
        + "</article>\n";
}

function prependEntryToMaster(filePath, categoryKey, year, entryBody) {
    let html = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf8")
        : buildMasterHtml(categoryKey, year);

    const marker = "<div id=\"vb-entries\">";
    let idx = html.indexOf(marker);
    if (idx === -1) {
        html = buildMasterHtml(categoryKey, year);
        idx = html.indexOf(marker);
    }
    const insertAt = idx + marker.length;
    html = html.slice(0, insertAt) + "\n" + entryBody + html.slice(insertAt);
    fs.writeFileSync(filePath, html, "utf8");
}

function countEntriesInHtml(html) {
    if (!html) return 0;
    const matches = html.match(/class="vb-entry"/g);
    return matches ? matches.length : 0;
}

function writeReportEntryToRoot(rootDir, categoryKey, year, entry, entryBody) {
    const meta = CATEGORY_META[categoryKey];
    const yearDir = getYearDir(rootDir, year);
    fs.mkdirSync(yearDir, { recursive: true });

    const filePath = getCategoryFilePath(rootDir, year, categoryKey);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, buildMasterHtml(categoryKey, year), "utf8");
    }
    prependEntryToMaster(filePath, categoryKey, year, entryBody);

    return {
        filePath: filePath,
        folder: yearDir,
        rootFolder: rootDir
    };
}

function appendDesktopReport(entry) {
    const categoryKey = normalizeCategoryKey(entry.category);
    const meta = CATEGORY_META[categoryKey];
    if (!meta) {
        throw new Error("Unknown report category.");
    }
    if (!entry.html || !String(entry.html).trim()) {
        throw new Error("Report HTML is empty.");
    }

    const year = resolveReportYear(entry);
    const id = entry.id || ("rpt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
    const entryTitle = entry.entryTitle
        || ((entry.companyName || "Company") + (entry.savedAtDisplay ? (" — " + entry.savedAtDisplay) : ""));
    const entryBody = buildEntryHtml(Object.assign({}, entry, { id: id, entryTitle: entryTitle }));

    const roots = getWritableReportsDirs();
    let primary = null;
    roots.forEach(function(rootDir) {
        try {
            const written = writeReportEntryToRoot(rootDir, categoryKey, year, entry, entryBody);
            if (!primary) primary = written;
        } catch (err) {
            console.warn("Report save failed for", rootDir, err.message || err);
        }
    });

    if (!primary) {
        throw new Error("Could not save report file.");
    }

    return {
        ok: true,
        id: id,
        year: year,
        category: categoryKey,
        title: meta.title,
        fileName: meta.fileName,
        filePath: primary.filePath,
        folder: primary.folder,
        rootFolder: primary.rootFolder,
        entryTitle: entryTitle
    };
}

function listYearFoldersAt(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) return [];

    return fs.readdirSync(rootDir, { withFileTypes: true })
        .filter(function(dirent) { return dirent.isDirectory() && /^\d{4}$/.test(dirent.name); })
        .map(function(dirent) { return parseInt(dirent.name, 10); })
        .filter(function(year) { return !isNaN(year); });
}

function listYearFolders() {
    const roots = [getAppReportsDir(), getDesktopReportsDir()];
    const years = new Set();
    roots.forEach(function(rootDir) {
        listYearFoldersAt(rootDir).forEach(function(year) { years.add(year); });
    });
    return Array.from(years).sort(function(a, b) { return b - a; });
}

function listDesktopReportArchive() {
    const roots = [];
    const appDir = getAppReportsDir();
    const desktopDir = getDesktopReportsDir();
    if (fs.existsSync(appDir)) roots.push(appDir);
    if (desktopDir !== appDir && fs.existsSync(desktopDir)) roots.push(desktopDir);

    const displayRoot = scoreReportsDir(desktopDir) >= scoreReportsDir(appDir) ? desktopDir : appDir;
    const years = listYearFolders();
    const yearData = years.map(function(year) {
        const files = CATEGORY_KEYS.map(function(categoryKey) {
            const meta = CATEGORY_META[categoryKey];
            let filePath = "";
            let exists = false;
            let entryCount = 0;
            let size = 0;

            roots.forEach(function(rootDir) {
                const candidatePath = getCategoryFilePath(rootDir, year, categoryKey);
                if (!fs.existsSync(candidatePath)) return;
                const html = fs.readFileSync(candidatePath, "utf8");
                const count = countEntriesInHtml(html);
                if (!exists || count > entryCount) {
                    exists = true;
                    entryCount = count;
                    filePath = candidatePath;
                    size = fs.statSync(candidatePath).size;
                }
            });

            return {
                category: categoryKey,
                title: meta.title,
                fileName: meta.fileName,
                filePath: filePath,
                exists: exists,
                entryCount: entryCount,
                size: size
            };
        });
        return { year: year, folder: getYearDir(displayRoot, year), files: files };
    });

    return {
        rootFolder: displayRoot,
        years: yearData
    };
}

function readDesktopReportFile(year, categoryKey) {
    year = parseInt(year, 10);
    categoryKey = normalizeCategoryKey(categoryKey);
    if (isNaN(year) || !categoryKey) {
        throw new Error("Year and category are required.");
    }
    const roots = [getAppReportsDir(), getDesktopReportsDir()];
    let filePath = "";
    roots.forEach(function(rootDir) {
        const candidate = getCategoryFilePath(rootDir, year, categoryKey);
        if (fs.existsSync(candidate)) filePath = candidate;
    });
    if (!filePath) {
        throw new Error("File not found for " + year + " — " + CATEGORY_META[categoryKey].title + ".");
    }
    const html = fs.readFileSync(filePath, "utf8");
    return {
        year: year,
        category: categoryKey,
        title: CATEGORY_META[categoryKey].title,
        fileName: CATEGORY_META[categoryKey].fileName,
        filePath: filePath,
        html: html,
        entryCount: countEntriesInHtml(html)
    };
}

function openPathInOs(targetPath) {
    if (!targetPath || !fs.existsSync(targetPath)) {
        throw new Error("Path not found.");
    }
    if (process.platform === "win32") {
        spawn("cmd", ["/c", "start", "", targetPath], { detached: true, stdio: "ignore" }).unref();
        return;
    }
    if (process.platform === "darwin") {
        spawn("open", [targetPath], { detached: true, stdio: "ignore" }).unref();
        return;
    }
    spawn("xdg-open", [targetPath], { detached: true, stdio: "ignore" }).unref();
}

function openDesktopReportFile(year, categoryKey) {
    const info = readDesktopReportFile(year, categoryKey);
    openPathInOs(info.filePath);
    return { ok: true, filePath: info.filePath };
}

function openDesktopReportsFolder(year) {
    const rootDir = scoreReportsDir(getDesktopReportsDir()) >= scoreReportsDir(getAppReportsDir())
        ? getDesktopReportsDir()
        : getAppReportsDir();
    const target = year ? getYearDir(rootDir, year) : rootDir;
    fs.mkdirSync(target, { recursive: true });
    openPathInOs(target);
    return { ok: true, folder: target };
}

module.exports = {
    CATEGORY_META,
    CATEGORY_KEYS,
    getAppReportsDir,
    getDesktopReportsDir,
    resolveReportYear,
    appendDesktopReport,
    listDesktopReportArchive,
    readDesktopReportFile,
    openDesktopReportFile,
    openDesktopReportsFolder
};
