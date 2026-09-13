const fs = require("fs");
const path = require("path");

const htmlPath = path.join(__dirname, "public", "index.html");
const snippetPath = path.join(__dirname, "public", "sqlite-storage-snippet.js");

let html = fs.readFileSync(htmlPath, "utf8");
const snippet = fs.readFileSync(snippetPath, "utf8");

const startMarker = "/* ===================================== */\n/* INDEXEDDB - PERSISTENT STORAGE */";
const endMarker = "function migrateLegacyDatabase()";

const startIndex = html.indexOf(startMarker);
const endIndex = html.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
  console.error("Could not find storage start markers");
  process.exit(1);
}

const migrateEnd = html.indexOf("\n}\n\nfunction showCompanyPage()", endIndex);
if (migrateEnd === -1) {
  console.error("Could not find migrateLegacyDatabase end");
  process.exit(1);
}

html = html.slice(0, startIndex) + snippet + html.slice(migrateEnd + 2);

function replaceFunction(name, newBody) {
  const regex = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, "m");
  if (!regex.test(html)) {
    console.warn("Function not found:", name);
    return;
  }
  html = html.replace(regex, newBody.trim());
}

replaceFunction("loadCompanyNameFromDb", `function loadCompanyNameFromDb() {
    let companyId = getActiveCompanyId();
    if(!companyId) return Promise.resolve("");
    return apiRequest("/companies/" + encodeURIComponent(companyId) + "/config/companyName")
        .then(data => data && data.value ? data.value : "")
        .catch(() => "");
}`);

replaceFunction("readCompanyDataForExport", `function readCompanyDataForExport(companyId) {
    return Promise.all([
        apiRequest("/companies/" + encodeURIComponent(companyId) + "/config"),
        apiRequest("/companies/" + encodeURIComponent(companyId) + "/invoices")
    ]).then(([config, invoices]) => ({
        accounts: JSON.parse(JSON.stringify(config.accounts || {})),
        accountData: JSON.parse(JSON.stringify(config.accountData || {})),
        accountCounters: JSON.parse(JSON.stringify(config.accountCounters || {})),
        voucherCounters: JSON.parse(JSON.stringify(config.voucherCounters || {})),
        accountSeries: Array.isArray(config.accountSeries) ? [...config.accountSeries] : [],
        customCurrencies: JSON.parse(JSON.stringify(config.customCurrencies || [])),
        invoices: (invoices || []).map(inv => JSON.parse(JSON.stringify(inv)))
    }));
}`);

replaceFunction("persistAllInvoices", `function persistAllInvoices() {
    let companyId = getActiveCompanyId();
    if(!companyId) return Promise.reject("No company database open");
    if(!allInvoices.length) return Promise.resolve();
    return Promise.all(allInvoices.map(inv => {
        let copy = JSON.parse(JSON.stringify(inv));
        if(copy.id) {
            return apiRequest("/companies/" + encodeURIComponent(companyId) + "/invoices/" + copy.id, {
                method: "PUT",
                body: JSON.stringify(copy)
            }).then(saved => { inv.id = saved.id; });
        }
        return apiRequest("/companies/" + encodeURIComponent(companyId) + "/invoices", {
            method: "POST",
            body: JSON.stringify(copy)
        }).then(saved => { inv.id = saved.id; });
    }));
}`);

replaceFunction("saveDataToIndexedDB", `function saveDataToIndexedDB() {
    let companyId = getActiveCompanyId();
    if(!companyId) return Promise.reject("No company database open");

    let payload = {
        accounts: accounts,
        accountData: accountData,
        accountCounters: accountCounters,
        voucherCounters: voucherCounters,
        accountSeries: accountSeries,
        customCurrencies: customCurrencies
    };

    if(currentCompanyId) {
        let co = companyRegistry.find(c => c.id === currentCompanyId);
        if(co) {
            payload.companyId = co.id;
            payload.companyName = co.name;
        }
    }

    return apiRequest("/companies/" + encodeURIComponent(companyId) + "/config", {
        method: "PUT",
        body: JSON.stringify(payload)
    });
}`);

replaceFunction("loadDataFromIndexedDB", `function loadDataFromIndexedDB() {
    let companyId = getActiveCompanyId();
    if(!companyId) return Promise.reject("No company selected");

    return Promise.all([
        apiRequest("/companies/" + encodeURIComponent(companyId) + "/config"),
        apiRequest("/companies/" + encodeURIComponent(companyId) + "/invoices")
    ]).then(([config, invoices]) => {
        accounts = config.accounts || {};
        accountData = config.accountData || {};
        accountCounters = config.accountCounters || {};
        voucherCounters = config.voucherCounters || JSON.parse(JSON.stringify(FACTORY_DEFAULTS.voucherCounters));
        accountSeries = config.accountSeries || [];
        customCurrencies = config.customCurrencies || [];
        refreshMainAccountDropdown();
        renderCurrencyList();
        allInvoices = invoices || [];
        normalizeAllInvoiceDates();
    });
}`);

replaceFunction("saveInvoiceToIndexedDB", `function saveInvoiceToIndexedDB(invoiceData) {
    let companyId = getActiveCompanyId();
    if(!companyId) {
        return initIndexedDB().then(() => saveInvoiceToIndexedDB(invoiceData));
    }
    let copy = JSON.parse(JSON.stringify(invoiceData));
    if(copy.id) {
        return apiRequest("/companies/" + encodeURIComponent(companyId) + "/invoices/" + copy.id, {
            method: "PUT",
            body: JSON.stringify(copy)
        });
    }
    return apiRequest("/companies/" + encodeURIComponent(companyId) + "/invoices", {
        method: "POST",
        body: JSON.stringify(copy)
    });
}`);

replaceFunction("updateInvoiceInIndexedDB", `function updateInvoiceInIndexedDB(invoiceData) {
    return saveInvoiceToIndexedDB(invoiceData);
}`);

replaceFunction("loadInvoicesFromIndexedDB", `function loadInvoicesFromIndexedDB() {
    let companyId = getActiveCompanyId();
    if(!companyId) return Promise.reject("No company selected");
    return apiRequest("/companies/" + encodeURIComponent(companyId) + "/invoices").then(invoices => {
        allInvoices = invoices || [];
        normalizeAllInvoiceDates();
    });
}`);

replaceFunction("clearAllInvoicesFromDB", `function clearAllInvoicesFromDB() {
    let companyId = getActiveCompanyId();
    if(!companyId) {
        return initIndexedDB().then(() => clearAllInvoicesFromDB());
    }
    return apiRequest("/companies/" + encodeURIComponent(companyId) + "/invoices", {
        method: "DELETE"
    });
}`);

replaceFunction("deleteCompanyDatabase", `function deleteCompanyDatabase(companyId) {
    if(!companyId) return Promise.resolve();
    if(db && currentCompanyId === companyId) {
        db.close();
        db = null;
    }
    return apiRequest("/companies/" + encodeURIComponent(companyId), {
        method: "DELETE"
    }).catch(() => {});
}`);

replaceFunction("deleteAllCompanyDatabases", `function deleteAllCompanyDatabases() {
    if(db) {
        db.close();
        db = null;
    }
    currentCompanyId = null;
    return apiRequest("/companies", { method: "DELETE" }).catch(() => {});
}`);

html = html.replace(
  `    Promise.all([saveCompanyRegistry(), saveDeletedCompanyRegistry()])
        .then(() => {
            backupCompaniesToLocal();
            if(localStorage.getItem("visionBooksLastCompanyId") === companyId) {
                localStorage.removeItem("visionBooksLastCompanyId");
                localStorage.removeItem("visionBooksLastCompanyName");
            }
            renderCompanyList();
            alert("✅ Company removed from list. Restore in Settings using name: " + company.name);
        })
        .catch(() => alert("Failed to delete company file."));`,
  `    softDeleteCompanyInDb(companyId)
        .then(() => loadGlobalData())
        .then(() => {
            renderCompanyList();
            alert("✅ Company removed from list. Restore in Settings using name: " + company.name);
        })
        .catch(() => alert("Failed to delete company file."));`
);

html = html.replace(
  `    Promise.all([saveCompanyRegistry(), saveDeletedCompanyRegistry()])
        .then(() => loadGlobalData())
        .then(() => {
            if(nameInput) nameInput.value = "";
            renderDeletedCompaniesList();
            let savedText = "✅ Company '" + deleted.name + "' restored to Company Files page.";
            if(msg) {
                msg.innerText = savedText;
                msg.style.display = "block";
            }
            showCompanyPage();
            let companyMsg = document.getElementById("createCompanyMsg");
            if(companyMsg) {
                companyMsg.innerText = savedText;
                companyMsg.style.display = "block";
            }
        })
        .catch(() => alert("Failed to restore company."));`,
  `    restoreCompanyInDb(deleted.id)
        .then(() => loadGlobalData())
        .then(() => {
            if(nameInput) nameInput.value = "";
            renderDeletedCompaniesList();
            let savedText = "✅ Company '" + deleted.name + "' restored to Company Files page.";
            if(msg) {
                msg.innerText = savedText;
                msg.style.display = "block";
            }
            showCompanyPage();
            let companyMsg = document.getElementById("createCompanyMsg");
            if(companyMsg) {
                companyMsg.innerText = savedText;
                companyMsg.style.display = "block";
            }
        })
        .catch(() => alert("Failed to restore company."));`
);

html = html.replace(
  `window.addEventListener("beforeunload", function() {
    backupCompaniesToLocal();
    backupAppUsersToLocal();
});`,
  `window.addEventListener("beforeunload", function() {
    if(db && currentCompanyId) {
        saveFullCompanyData();
    }
    backupAppUsersToLocal();
});`
);

html = html.replace(
  `    if(toRemove.length && db) {
        const tx = db.transaction(["invoices"], "readwrite");
        toRemove.forEach(id => tx.objectStore("invoices").delete(id));
    }`,
  `    if(toRemove.length && getActiveCompanyId()) {
        toRemove.forEach(id => {
            apiRequest("/companies/" + encodeURIComponent(getActiveCompanyId()) + "/invoices/" + id, {
                method: "DELETE"
            }).catch(() => {});
        });
    }`
);

html = html.replace(
  `    deleteAllCompanyDatabases().then(() => {
        companyRegistry = [];
        deletedCompanyRegistry = [];
        currentCompanyId = null;
        currentEditingInvoiceId = null;
        resetToFactoryDefaults();
        sessionStorage.removeItem("currentCompanyId");
        sessionStorage.removeItem("currentCompanyName");
        localStorage.removeItem("visionBooksCompanies");
        localStorage.removeItem("visionBooksDeletedCompanies");
        localStorage.removeItem("visionBooksLastCompanyId");
        localStorage.removeItem("visionBooksLastCompanyName");
        return initGlobalDB().then(() => Promise.all([
            putGlobalConfig("companies", []),
            putGlobalConfig("deletedCompanies", [])
        ]));
    }).then(() => {
        alert("✅ All data deleted. All companies have been removed.");
        showCompanyPage();
    }).catch(() => {
        companyRegistry = [];
        deletedCompanyRegistry = [];
        currentCompanyId = null;
        currentEditingInvoiceId = null;
        resetToFactoryDefaults();
        sessionStorage.removeItem("currentCompanyId");
        sessionStorage.removeItem("currentCompanyName");
        localStorage.removeItem("visionBooksCompanies");
        localStorage.removeItem("visionBooksDeletedCompanies");
        localStorage.removeItem("visionBooksLastCompanyId");
        localStorage.removeItem("visionBooksLastCompanyName");
        initGlobalDB().then(() => Promise.all([
            putGlobalConfig("companies", []),
            putGlobalConfig("deletedCompanies", [])
        ])).finally(() => {
            alert("All data deleted. All companies have been removed.");
            showCompanyPage();
        });
    });`,
  `    deleteAllCompanyDatabases().then(() => {
        companyRegistry = [];
        deletedCompanyRegistry = [];
        currentCompanyId = null;
        currentEditingInvoiceId = null;
        resetToFactoryDefaults();
        sessionStorage.removeItem("currentCompanyId");
        sessionStorage.removeItem("currentCompanyName");
        refreshMainAccountDropdown();
        alert("✅ All data deleted. All companies have been removed.");
        showCompanyPage();
    }).catch(() => {
        companyRegistry = [];
        deletedCompanyRegistry = [];
        currentCompanyId = null;
        currentEditingInvoiceId = null;
        resetToFactoryDefaults();
        sessionStorage.removeItem("currentCompanyId");
        sessionStorage.removeItem("currentCompanyName");
        refreshMainAccountDropdown();
        alert("All data deleted. All companies have been removed.");
        showCompanyPage();
    });`
);

fs.writeFileSync(htmlPath, html);
console.log("Patched index.html for SQLite storage.");
