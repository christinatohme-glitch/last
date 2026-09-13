/**
 * Cash Flow Statement engine for VisionBooks.
 * Works from invoice journal rows (General Ledger) and chart-of-accounts metadata.
 */

const CASH_PREFIXES = ["511", "512", "531"];

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function resolveAccountCode(input, accounts) {
  input = String(input || "").trim();
  if (!input) return "";
  if (accounts[input]) return input;
  const lower = input.toLowerCase();
  for (const code in accounts) {
    if (accounts[code].toLowerCase() === lower) return code;
  }
  return input;
}

function isCashAccount(code, accounts) {
  code = resolveAccountCode(code, accounts);
  if (!code) return false;
  return CASH_PREFIXES.some((p) => code === p || code.startsWith(p));
}

function accountName(code, accounts) {
  return String(accounts[code] || "").toLowerCase();
}

function getAccountInfo(code, accountData) {
  return accountData[code] || {};
}

function resolveStatementCategory(code, accounts, accountData) {
  code = resolveAccountCode(code, accounts);
  if (!code) return "";

  const visited = new Set();
  const queue = [code];

  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const info = getAccountInfo(current, accountData);
    if (info.statementCategory === "receivable" || info.statementCategory === "payable") {
      return info.statementCategory;
    }

    for (let len = current.length - 1; len >= 1; len--) {
      const parent = current.substring(0, len);
      if (accounts[parent] && !visited.has(parent)) queue.push(parent);
    }
  }

  return "";
}

function classifyAccount(code, accounts, accountData) {
  code = resolveAccountCode(code, accounts);
  const name = accountName(code, accounts);
  const info = getAccountInfo(code, accountData);
  const stmt = resolveStatementCategory(code, accounts, accountData);
  const bs = info.balanceSheetCategory || "";
  const pl = info.profitLossCategory || "";
  const first = code.charAt(0);
  const prefix2 = code.substring(0, 2);

  const tags = {
    code,
    activity: "operating",
    directLine: "otherOperating",
    wcType: null,
    nonCashAdjustment: null
  };

  if (bs === "Equity" || code.startsWith("109") || code.startsWith("45") || code.startsWith("465")) {
    tags.activity = "financing";
    tags.directLine = null;
    return tags;
  }

  if (
    bs === "Liability" &&
    stmt !== "payable" &&
    (code.startsWith("16") || code.startsWith("17") || code.startsWith("18") || code.startsWith("19"))
  ) {
    tags.activity = "financing";
    tags.directLine = null;
    return tags;
  }

  if (bs === "Assets" && !isCashAccount(code, accounts) && (first === "2" || name.includes("fixed asset"))) {
    tags.activity = "investing";
    tags.directLine = null;
    return tags;
  }

  if (
    /deprec|amort/i.test(name) ||
    code.startsWith("681") ||
    code.startsWith("68") ||
    prefix2 === "68"
  ) {
    tags.nonCashAdjustment = "depreciation";
    tags.activity = "operating";
    tags.directLine = null;
    return tags;
  }

  if (
    /provision/i.test(name) ||
    code.startsWith("15") ||
    code.startsWith("691")
  ) {
    tags.nonCashAdjustment = "provision";
    tags.activity = "operating";
    tags.directLine = null;
    return tags;
  }

  if (
    /gain.*(asset|disposal|sale)|loss.*(asset|disposal|sale)|asset sale|disposal/i.test(name) ||
    code.startsWith("75") ||
    code.startsWith("67")
  ) {
    tags.nonCashAdjustment = "assetGainLoss";
    tags.activity = "operating";
    tags.directLine = null;
    return tags;
  }

  if (stmt === "receivable" || code.startsWith("411") || code.startsWith("41")) {
    tags.wcType = "receivable";
    tags.directLine = "customerReceipts";
    return tags;
  }

  if (stmt === "payable" || code.startsWith("401") || code.startsWith("40")) {
    tags.wcType = "payable";
    tags.directLine = "supplierPayments";
    return tags;
  }

  if (
    first === "3" ||
    /inventory|stock|goods|merchandise|raw material/i.test(name)
  ) {
    tags.wcType = "inventory";
    tags.activity = "operating";
    tags.directLine = "operatingExpenses";
    return tags;
  }

  if (
    (bs === "Liability" && first === "4" && stmt !== "payable") ||
    code.startsWith("46") ||
    code.startsWith("47") ||
    /accrued|accrual|provision.*liab/i.test(name)
  ) {
    tags.wcType = "accrued";
    tags.activity = "operating";
    tags.directLine = "otherOperating";
    return tags;
  }

  if (
    /salary|salaries|wage|payroll|personnel|staff cost|employee/i.test(name) ||
    code.startsWith("42") ||
    code.startsWith("43")
  ) {
    tags.directLine = "salaries";
    return tags;
  }

  if (
    /interest|finance cost|financial charge|bank charge/i.test(name) ||
    code.startsWith("66")
  ) {
    tags.directLine = "interest";
    return tags;
  }

  if (
    /tax|withholding|income tax|corporate tax|municipal/i.test(name) ||
    code.startsWith("44") ||
    code.startsWith("445")
  ) {
    tags.directLine = "taxes";
    return tags;
  }

  if (pl === "Expenses" || first === "6") {
    tags.directLine = "operatingExpenses";
    return tags;
  }

  if (pl === "Income" || first === "7" || first === "4") {
    tags.directLine = "customerReceipts";
    return tags;
  }

  if (bs === "Assets" && !isCashAccount(code, accounts)) {
    tags.wcType = "otherCurrent";
    tags.activity = "investing";
    tags.directLine = null;
    return tags;
  }

  if (bs === "Liability") {
    tags.wcType = "otherCurrent";
    tags.activity = "financing";
    tags.directLine = null;
    return tags;
  }

  return tags;
}

function classifyInvoiceActivity(invoice, nonCashRows, accounts, accountData) {
  const title = String(invoice.title || "");
  if (title === "Sales Invoice" || title === "Receipt Invoice") return "operating";
  if (
    title === "Purchase Invoice" ||
    title === "Payment Invoice" ||
    title === "Expense Invoice"
  ) {
    return "operating";
  }

  let activity = "operating";
  let priority = 0;

  nonCashRows.forEach((row) => {
    const code = resolveAccountCode(row.account, accounts);
    if (!code || isCashAccount(code, accounts)) return;
    const tags = classifyAccount(code, accounts, accountData);
    const rank = tags.activity === "financing" ? 3 : tags.activity === "investing" ? 2 : 1;
    if (rank > priority) {
      priority = rank;
      activity = tags.activity;
    }
  });

  return activity;
}

function classifyDirectLine(invoice, nonCashRows, netUsd, accounts, accountData) {
  const title = String(invoice.title || "");
  if (title === "Sales Invoice" || title === "Receipt Invoice") return "customerReceipts";
  if (title === "Purchase Invoice" || title === "Payment Invoice") return "supplierPayments";
  if (title === "Expense Invoice") return "operatingExpenses";

  const lineScores = {
    customerReceipts: 0,
    supplierPayments: 0,
    operatingExpenses: 0,
    salaries: 0,
    interest: 0,
    taxes: 0,
    otherOperating: 0
  };

  nonCashRows.forEach((row) => {
    const code = resolveAccountCode(row.account, accounts);
    if (!code || isCashAccount(code, accounts)) return;
    const tags = classifyAccount(code, accounts, accountData);
    if (tags.directLine && lineScores[tags.directLine] !== undefined) {
      lineScores[tags.directLine] += Math.abs(row.debit - row.credit);
    }
  });

  if (netUsd > 0 && lineScores.customerReceipts > 0) return "customerReceipts";
  if (netUsd < 0 && lineScores.supplierPayments > 0) return "supplierPayments";

  let best = "otherOperating";
  let bestScore = 0;
  Object.entries(lineScores).forEach(([key, score]) => {
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  });
  return best;
}

function createDirectOperatingLines() {
  return {
    customerReceipts: { key: "customerReceipts", label: "Cash received from customers", usd: 0, lbp: 0 },
    supplierPayments: { key: "supplierPayments", label: "Cash paid to suppliers", usd: 0, lbp: 0 },
    operatingExpenses: { key: "operatingExpenses", label: "Cash paid for operating expenses", usd: 0, lbp: 0 },
    salaries: { key: "salaries", label: "Cash paid for salaries", usd: 0, lbp: 0 },
    interest: { key: "interest", label: "Cash paid for interest", usd: 0, lbp: 0 },
    taxes: { key: "taxes", label: "Cash paid for taxes", usd: 0, lbp: 0 },
    otherOperating: { key: "otherOperating", label: "Other operating cash payments", usd: 0, lbp: 0 }
  };
}

function createIndirectAdjustments() {
  return {
    depreciation: { key: "depreciation", label: "Depreciation and amortization", usd: 0, lbp: 0 },
    provisions: { key: "provisions", label: "Provisions", usd: 0, lbp: 0 },
    assetGainLoss: { key: "assetGainLoss", label: "Gains / (losses) on asset sales", usd: 0, lbp: 0 },
    receivable: { key: "receivable", label: "Changes in accounts receivable", usd: 0, lbp: 0 },
    inventory: { key: "inventory", label: "Changes in inventory", usd: 0, lbp: 0 },
    payable: { key: "payable", label: "Changes in accounts payable", usd: 0, lbp: 0 },
    accrued: { key: "accrued", label: "Changes in accrued expenses", usd: 0, lbp: 0 },
    otherWorkingCapital: { key: "otherWorkingCapital", label: "Other working capital changes", usd: 0, lbp: 0 }
  };
}

function calculateAccountBalance(code, dateIso, beforeDate, invoices, accounts, convertToUsd, convertToLbp) {
  let usd = 0;
  let lbp = 0;

  invoices.forEach((invoice) => {
    if (!invoice.date) return;
    if (beforeDate) {
      if (dateIso && invoice.date >= dateIso) return;
    } else if (dateIso && invoice.date > dateIso) {
      return;
    }

    (invoice.rows || []).forEach((row) => {
      const rowCode = resolveAccountCode(row.account, accounts);
      if (rowCode !== code) return;
      usd += convertToUsd(row.debit - row.credit, row.currency);
      lbp += convertToLbp(row.debit - row.credit, row.currency);
    });
  });

  return { usd, lbp };
}

function collectWorkingCapitalBalances(dateIso, beforeDate, invoices, accounts, accountData, convertToUsd, convertToLbp) {
  const totals = {
    receivable: { usd: 0, lbp: 0 },
    payable: { usd: 0, lbp: 0 },
    inventory: { usd: 0, lbp: 0 },
    accrued: { usd: 0, lbp: 0 },
    otherWorkingCapital: { usd: 0, lbp: 0 }
  };

  Object.keys(accounts).forEach((code) => {
    if (isCashAccount(code, accounts)) return;
    const tags = classifyAccount(code, accounts, accountData);
    if (!tags.wcType) return;

    const bal = calculateAccountBalance(code, dateIso, beforeDate, invoices, accounts, convertToUsd, convertToLbp);
    let usd = bal.usd;
    let lbp = bal.lbp;

    if (tags.wcType === "payable" || tags.wcType === "accrued") {
      usd = -usd;
      lbp = -lbp;
    }

    const bucket = tags.wcType === "otherCurrent" ? "otherWorkingCapital" : tags.wcType;
    totals[bucket].usd += usd;
    totals[bucket].lbp += lbp;
  });

  return totals;
}

function isProfitLossAccount(code, accounts, accountData) {
  code = resolveAccountCode(code, accounts);
  if (!code || isCashAccount(code, accounts)) return null;

  const info = getAccountInfo(code, accountData);
  const pl = info.profitLossCategory || "";
  const bs = info.balanceSheetCategory || "";
  const stmt = resolveStatementCategory(code, accounts, accountData);

  if (stmt === "receivable" || stmt === "payable") return null;
  if (pl === "Income" || pl === "Expenses") return pl;
  if (bs && !pl) return null;

  const firstDigit = code.charAt(0);
  if (firstDigit === "6") return "Expenses";
  if (firstDigit === "7") return "Income";
  return null;
}

function calculateProfitForPeriod(dateFrom, dateTo, invoices, accounts, accountData, convertToUsd, convertToLbp) {
  let totalRevenueUSD = 0;
  let totalRevenueLBP = 0;
  let totalExpensesUSD = 0;
  let totalExpensesLBP = 0;

  invoices.forEach((invoice) => {
    if (!invoice.date || invoice.date < dateFrom || invoice.date > dateTo) return;
    (invoice.rows || []).forEach((row) => {
      const accountNum = resolveAccountCode(row.account, accounts);
      if (!accountNum) return;
      const plType = isProfitLossAccount(accountNum, accounts, accountData);
      if (!plType) return;

      if (plType === "Income") {
        const revAmt = row.credit - row.debit;
        totalRevenueUSD += convertToUsd(revAmt, row.currency);
        totalRevenueLBP += convertToLbp(revAmt, row.currency);
      } else if (plType === "Expenses") {
        const expAmt = row.debit - row.credit;
        totalExpensesUSD += convertToUsd(expAmt, row.currency);
        totalExpensesLBP += convertToLbp(expAmt, row.currency);
      }
    });
  });

  return {
    revenueUSD: totalRevenueUSD,
    revenueLBP: totalRevenueLBP,
    expensesUSD: totalExpensesUSD,
    expensesLBP: totalExpensesLBP,
    netUSD: totalRevenueUSD - totalExpensesUSD,
    netLBP: totalRevenueLBP - totalExpensesLBP
  };
}

function calculateNonCashAdjustments(dateFrom, dateTo, invoices, accounts, accountData, convertToUsd, convertToLbp) {
  const adjustments = createIndirectAdjustments();

  invoices.forEach((invoice) => {
    if (!invoice.date || invoice.date < dateFrom || invoice.date > dateTo) return;
    (invoice.rows || []).forEach((row) => {
      const code = resolveAccountCode(row.account, accounts);
      if (!code || isCashAccount(code, accounts)) return;
      const tags = classifyAccount(code, accounts, accountData);
      if (!tags.nonCashAdjustment) return;

      const amountUsd = convertToUsd(row.debit - row.credit, row.currency);
      const amountLbp = convertToLbp(row.debit - row.credit, row.currency);

      if (tags.nonCashAdjustment === "depreciation") {
        adjustments.depreciation.usd += amountUsd;
        adjustments.depreciation.lbp += amountLbp;
      } else if (tags.nonCashAdjustment === "provision") {
        adjustments.provisions.usd += amountUsd;
        adjustments.provisions.lbp += amountLbp;
      } else if (tags.nonCashAdjustment === "assetGainLoss") {
        adjustments.assetGainLoss.usd += amountUsd;
        adjustments.assetGainLoss.lbp += amountLbp;
      }
    });
  });

  return adjustments;
}

function calculateCashBalancesUpTo(dateIso, beforeDate, invoices, accounts, convertToUsd, convertToLbp) {
  let totalUSD = 0;
  let totalLBP = 0;
  const byAccount = {};

  invoices.forEach((invoice) => {
    if (!invoice.date) return;
    if (beforeDate) {
      if (!dateIso || invoice.date >= dateIso) return;
    } else if (dateIso && invoice.date > dateIso) {
      return;
    }

    (invoice.rows || []).forEach((row) => {
      if (!isCashAccount(row.account, accounts)) return;
      const code = resolveAccountCode(row.account, accounts);
      const netUsd = convertToUsd(row.debit - row.credit, row.currency);
      const netLbp = convertToLbp(row.debit - row.credit, row.currency);
      if (!byAccount[code]) {
        byAccount[code] = {
          code,
          name: accounts[code] || row.description || code,
          type: code.startsWith("531") ? "Cash" : code.startsWith("512") ? "Bank" : "Check",
          usd: 0,
          lbp: 0
        };
      }
      byAccount[code].usd += netUsd;
      byAccount[code].lbp += netLbp;
      totalUSD += netUsd;
      totalLBP += netLbp;
    });
  });

  return { totalUSD, totalLBP, byAccount };
}

function buildCashFlowReport(options) {
  const {
    invoices = [],
    accounts = {},
    accountData = {},
    dateFrom,
    dateTo,
    convertToUsd = (amount) => amount,
    convertToLbp = (amount) => amount
  } = options;

  const opening = calculateCashBalancesUpTo(dateFrom, true, invoices, accounts, convertToUsd, convertToLbp);
  const closing = calculateCashBalancesUpTo(dateTo, false, invoices, accounts, convertToUsd, convertToLbp);

  const sections = {
    operating: { title: "Cash Flow from Operating Activities", items: [], totalUSD: 0, totalLBP: 0 },
    investing: { title: "Cash Flow from Investing Activities", items: [], totalUSD: 0, totalLBP: 0 },
    financing: { title: "Cash Flow from Financing Activities", items: [], totalUSD: 0, totalLBP: 0 }
  };

  const directOperating = createDirectOperatingLines();
  const details = [];

  invoices.forEach((invoice) => {
    if (!invoice.date || invoice.date < dateFrom || invoice.date > dateTo) return;

    const cashRows = [];
    const nonCashRows = [];
    (invoice.rows || []).forEach((row) => {
      if (isCashAccount(row.account, accounts)) cashRows.push(row);
      else nonCashRows.push(row);
    });
    if (!cashRows.length) return;

    let netUsd = 0;
    let netLbp = 0;
    const cashAccounts = [];
    cashRows.forEach((row) => {
      netUsd += convertToUsd(row.debit - row.credit, row.currency);
      netLbp += convertToLbp(row.debit - row.credit, row.currency);
      cashAccounts.push(row.account);
    });

        if (Math.abs(netUsd) < 0.0001 && Math.abs(netLbp) < 0.0001) {
            details.push({
                date: invoice.date,
                voucher: invoice.voucher,
                title: invoice.title || "Journal Voucher",
                cashAccount: cashAccounts.join(", "),
                description: (invoice.title || "Journal Voucher") + " — internal cash transfer",
                inflowUsd: 0,
                outflowUsd: 0,
                activity: "Operating",
                directLine: "otherOperating",
                isInternalTransfer: true
            });
            return;
        }

    const activity = classifyInvoiceActivity(invoice, nonCashRows, accounts, accountData);
    const counterpart = nonCashRows
      .map((r) => resolveAccountCode(r.account, accounts))
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");

    let description = invoice.title || "Journal Voucher";
    if (counterpart) description += " — " + counterpart;

    sections[activity].items.push({
      date: invoice.date,
      voucher: invoice.voucher,
      title: invoice.title || "Journal Voucher",
      description,
      usd: netUsd,
      lbp: netLbp
    });
    sections[activity].totalUSD += netUsd;
    sections[activity].totalLBP += netLbp;

    if (activity === "operating") {
      const directKey = classifyDirectLine(invoice, nonCashRows, netUsd, accounts, accountData);
      directOperating[directKey].usd += netUsd;
      directOperating[directKey].lbp += netLbp;
    }

    details.push({
      date: invoice.date,
      voucher: invoice.voucher,
      title: invoice.title || "Journal Voucher",
      cashAccount: cashAccounts.join(", "),
      description,
      inflowUsd: netUsd > 0 ? netUsd : 0,
      outflowUsd: netUsd < 0 ? Math.abs(netUsd) : 0,
      activity: activity.charAt(0).toUpperCase() + activity.slice(1),
      directLine: activity === "operating" ? classifyDirectLine(invoice, nonCashRows, netUsd, accounts, accountData) : null
    });
  });

  Object.keys(sections).forEach((key) => {
    sections[key].items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  });
  details.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const netUSD = sections.operating.totalUSD + sections.investing.totalUSD + sections.financing.totalUSD;
  const netLBP = sections.operating.totalLBP + sections.investing.totalLBP + sections.financing.totalLBP;

  const profit = calculateProfitForPeriod(dateFrom, dateTo, invoices, accounts, accountData, convertToUsd, convertToLbp);
  const openingWc = collectWorkingCapitalBalances(dateFrom, true, invoices, accounts, accountData, convertToUsd, convertToLbp);
  const closingWc = collectWorkingCapitalBalances(dateTo, false, invoices, accounts, accountData, convertToUsd, convertToLbp);
  const nonCash = calculateNonCashAdjustments(dateFrom, dateTo, invoices, accounts, accountData, convertToUsd, convertToLbp);

  const indirectAdjustments = createIndirectAdjustments();
  indirectAdjustments.depreciation = { ...indirectAdjustments.depreciation, ...nonCash.depreciation };
  indirectAdjustments.provisions = { ...indirectAdjustments.provisions, ...nonCash.provisions };
  indirectAdjustments.assetGainLoss = { ...indirectAdjustments.assetGainLoss, ...nonCash.assetGainLoss };

  ["receivable", "inventory", "payable", "accrued", "otherWorkingCapital"].forEach((key) => {
    const openingBal = openingWc[key] || { usd: 0, lbp: 0 };
    const closingBal = closingWc[key] || { usd: 0, lbp: 0 };
    const changeUsd = closingBal.usd - openingBal.usd;
    const changeLbp = closingBal.lbp - openingBal.lbp;
    const cashImpactUsd = key === "payable" || key === "accrued" ? changeUsd : -changeUsd;
    const cashImpactLbp = key === "payable" || key === "accrued" ? changeLbp : -changeLbp;
    indirectAdjustments[key].usd = cashImpactUsd;
    indirectAdjustments[key].lbp = cashImpactLbp;
    indirectAdjustments[key].changeUsd = changeUsd;
    indirectAdjustments[key].changeLbp = changeLbp;
    indirectAdjustments[key].openingUsd = openingBal.usd;
    indirectAdjustments[key].openingLbp = openingBal.lbp;
    indirectAdjustments[key].closingUsd = closingBal.usd;
    indirectAdjustments[key].closingLbp = closingBal.lbp;
  });

  let operatingIndirectUSD = profit.netUSD;
  let operatingIndirectLBP = profit.netLBP;
  Object.values(indirectAdjustments).forEach((line) => {
    const usd = Number(line.usd);
    const lbp = Number(line.lbp);
    operatingIndirectUSD += Number.isFinite(usd) ? usd : 0;
    operatingIndirectLBP += Number.isFinite(lbp) ? lbp : 0;
  });

  const reconciliation = {
    openingCashUsd: opening.totalUSD,
    closingCashUsd: closing.totalUSD,
    actualNetChangeUsd: closing.totalUSD - opening.totalUSD,
    reportedNetChangeUsd: netUSD,
    differenceUsd: (closing.totalUSD - opening.totalUSD) - netUSD,
    indirectOperatingUsd: operatingIndirectUSD,
    directOperatingUsd: sections.operating.totalUSD
  };

  return {
    period: { from: dateFrom, to: dateTo },
    opening,
    closing,
    sections,
    directOperating,
    indirect: {
      profit,
      adjustments: indirectAdjustments,
      operatingUSD: operatingIndirectUSD,
      operatingLBP: operatingIndirectLBP,
      openingWorkingCapital: openingWc,
      closingWorkingCapital: closingWc
    },
    details,
    netUSD,
    netLBP,
    reconciliation
  };
}

function buildCashFlowReportFromDb(storage, companyId, dateFrom, dateTo, rates) {
  const invoices = storage.listInvoices(companyId);
  const config = storage.getAllCompanyConfig(companyId);
  const accounts = config.accounts || {};
  const accountData = config.accountData || {};
  const customCurrencies = config.customCurrencies || [];
  const defaultRate = rates && rates.defaultRate ? rates.defaultRate : 1;

  function convertToUsd(amount, currency) {
    const amt = Number(amount) || 0;
    if (!currency || currency === "USD") return amt;
    if (currency === "LBP") return defaultRate ? amt / defaultRate : amt;
    const found = customCurrencies.find((c) => c.code === currency);
    if (found && found.rateToUsd) return amt / found.rateToUsd;
    return amt;
  }

  function convertToLbp(amount, currency) {
    const amt = Number(amount) || 0;
    if (currency === "LBP") return amt;
    if (!currency || currency === "USD") return amt * defaultRate;
    const found = customCurrencies.find((c) => c.code === currency);
    if (found && found.rateToUsd) return (amt / found.rateToUsd) * defaultRate;
    return amt * defaultRate;
  }

  return buildCashFlowReport({
    invoices,
    accounts,
    accountData,
    dateFrom,
    dateTo,
    convertToUsd,
    convertToLbp
  });
}

const cashFlowExports = {
  buildCashFlowReport,
  buildCashFlowReportFromDb,
  classifyAccount,
  isCashAccount,
  resolveAccountCode,
  parseJson
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = cashFlowExports;
}

if (typeof globalThis !== "undefined") {
  globalThis.VisionBooksCashFlow = cashFlowExports;
}
