const STORAGE_KEY = "paisa-dashboard-v1";
const NOTIFICATION_STORAGE_KEY = "paisa-budget-notifications-v1";
const MAX_SBI_IMPORT_ROWS = 2000;
const CATEGORIES = [
  { id: "food", label: "Food & dining", color: "#f19a58" },
  { id: "transport", label: "Transport", color: "#6d63e8" },
  { id: "shopping", label: "Shopping", color: "#e9768c" },
  { id: "bills", label: "Bills", color: "#45a99a" },
  { id: "health", label: "Health", color: "#5c9ce5" },
  { id: "other", label: "Other", color: "#b28bd7" },
];
const elements = {
  monthPicker: document.getElementById("month-picker"),
  expenseForm: document.getElementById("expense-form"),
  expenseAmount: document.getElementById("expense-amount"),
  expenseTitle: document.getElementById("expense-title"),
  expenseCategory: document.getElementById("expense-category"),
  expenseMethod: document.getElementById("expense-method"),
  expenseDate: document.getElementById("expense-date"),
  formMessage: document.getElementById("form-message"),
  budgetForm: document.getElementById("budget-form"),
  budgetAlerts: document.getElementById("budget-alerts"),
  budgetAlertList: document.getElementById("budget-alert-list"),
  notificationButton: document.getElementById("notification-button"),
  notificationHint: document.getElementById("notification-hint"),
  statementFile: document.getElementById("statement-file"),
  statementMessage: document.getElementById("statement-message"),
  statementPreview: document.getElementById("statement-preview"),
  statementSummary: document.getElementById("statement-summary"),
  statementRows: document.getElementById("statement-rows"),
  importButton: document.getElementById("import-button"),
  methodFilter: document.getElementById("method-filter"),
  transactionList: document.getElementById("transaction-list"),
  transactionsEmpty: document.getElementById("transactions-empty"),
  chart: document.getElementById("spending-chart"),
  chartPeriod: document.getElementById("chart-period"),
  chartEmpty: document.getElementById("chart-empty"),
  chartLegend: document.getElementById("chart-legend"),
  appMessage: document.getElementById("app-message"),
  installButton: document.getElementById("install-button"),
  storageCaption: document.getElementById("storage-caption"),
  reportPeriod: document.getElementById("report-period"),
  reportSpent: document.getElementById("report-spent"),
  reportBudget: document.getElementById("report-budget"),
  reportBalanceLabel: document.getElementById("report-balance-label"),
  reportBalance: document.getElementById("report-balance"),
  reportBody: document.getElementById("report-body"),
  reportFoot: document.getElementById("report-foot"),
  exportReport: document.getElementById("export-report"),
};

let selectedMonth = currentMonth();
const loadedState = loadState();
let state = { transactions: [], budgets: {} };
let backendReady = false;
let messageTimer;
let installPromptEvent = null;
let notificationHistory = new Set();
const attemptedNotifications = new Set();
let statementCandidates = [];
let pdfJsPromise;

function currentMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { data: { transactions: [], budgets: {} }, error: null };

    const parsed = JSON.parse(saved);
    if (
      !parsed ||
      !Array.isArray(parsed.transactions) ||
      typeof parsed.budgets !== "object" ||
      parsed.budgets === null ||
      Array.isArray(parsed.budgets)
    ) {
      throw new Error("Saved data has an unexpected format.");
    }

    const validTransactions = parsed.transactions.every((transaction) =>
      transaction &&
      typeof transaction.id === "string" &&
      typeof transaction.title === "string" &&
      Number.isFinite(transaction.amount) &&
      typeof transaction.date === "string" &&
      CATEGORIES.some((category) => category.id === transaction.category) &&
      ["cash", "upi"].includes(transaction.method)
    );
    if (!validTransactions) throw new Error("A saved expense is incomplete or invalid.");

    const validBudgets = Object.entries(parsed.budgets).every(([month, budgets]) =>
      /^\d{4}-\d{2}$/.test(month) &&
      budgets &&
      typeof budgets === "object" &&
      !Array.isArray(budgets) &&
      Object.entries(budgets).every(([category, amount]) =>
        CATEGORIES.some((item) => item.id === category) &&
        Number.isFinite(amount) &&
        amount > 0 &&
        amount <= 99999999
      )
    );
    if (!validBudgets) throw new Error("A saved category budget is incomplete or invalid.");

    return {
      data: { transactions: parsed.transactions, budgets: parsed.budgets },
      error: null,
    };
  } catch (error) {
    return {
      data: { transactions: [], budgets: {} },
      error: `Saved dashboard data could not be loaded: ${error.message}`,
    };
  }
}

function loadNotificationHistory() {
  try {
    const saved = localStorage.getItem(NOTIFICATION_STORAGE_KEY);
    if (!saved) return new Set();
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === "string")) {
      throw new Error("Saved reminder history has an unexpected format.");
    }
    return new Set(parsed);
  } catch (error) {
    showAppMessage(`Browser reminder history could not be loaded: ${error.message}`);
    return new Set();
  }
}

async function apiRequest(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`The backend returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const error = new Error(payload.error || `The backend returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function isEmptyState(value) {
  return value.transactions.length === 0 &&
    Object.values(value.budgets).every((monthBudgets) => Object.keys(monthBudgets).length === 0);
}

function hasLegacyData(value) {
  return value.transactions.length > 0 ||
    Object.values(value.budgets).some((monthBudgets) => Object.keys(monthBudgets).length > 0);
}

function setBackendControls(enabled) {
  backendReady = enabled;
  elements.expenseForm.querySelectorAll("input, select, button").forEach((control) => {
    control.disabled = !enabled;
  });
  elements.budgetForm.querySelectorAll("input").forEach((control) => {
    control.disabled = !enabled;
  });
  document.querySelector('button[form="budget-form"]').disabled = !enabled;
  elements.statementFile.disabled = !enabled;
  elements.importButton.disabled = !enabled || !statementCandidates.some((transaction) => !transaction.duplicate);
  elements.storageCaption.textContent = enabled
    ? "Saved to this computer"
    : "Local database unavailable";
}

function showAppMessage(message, type = "error") {
  window.clearTimeout(messageTimer);
  elements.appMessage.textContent = message;
  elements.appMessage.classList.toggle("info", type === "info");
  elements.appMessage.hidden = false;
  messageTimer = window.setTimeout(() => {
    elements.appMessage.hidden = true;
  }, 6500);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}

function monthTransactions() {
  return state.transactions.filter((transaction) => transaction.date.startsWith(selectedMonth));
}

function monthBudgets() {
  return state.budgets[selectedMonth] || {};
}

function categoryById(id) {
  return CATEGORIES.find((category) => category.id === id);
}

function monthLabel() {
  const [year, month] = selectedMonth.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(
    new Date(year, month - 1, 1)
  );
}

function totalsByCategory(transactions = monthTransactions()) {
  const totalsInMinorUnits = transactions.reduce((totals, transaction) => {
    totals[transaction.category] =
      (totals[transaction.category] || 0) + Math.round(transaction.amount * 100);
    return totals;
  }, {});
  return Object.fromEntries(
    Object.entries(totalsInMinorUnits).map(([category, amount]) => [category, amount / 100])
  );
}

function totalOf(object) {
  return Object.values(object).reduce((sum, amount) => sum + Math.round(amount * 100), 0) / 100;
}

function totalTransactions(transactions) {
  return transactions.reduce((sum, transaction) => sum + Math.round(transaction.amount * 100), 0) / 100;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error("The CSV has an unfinished quoted field.");
  row.push(cell.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function normalizedHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findSbiColumns(rows) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 20); rowIndex += 1) {
    const headers = rows[rowIndex].map(normalizedHeader);
    const find = (predicate) => headers.findIndex(predicate);
    const transactionDate = find((header) =>
      ["txndate", "transactiondate", "date"].includes(header)
    );
    const valueDate = find((header) => header === "valuedate");
    const description = find((header) =>
      ["description", "narration", "remarks", "particulars", "transactiondetails", "transactiondescription"]
        .some((name) => header === name || header.includes(name))
    );
    const debit = find((header) =>
      header.startsWith("debit") ||
      header.startsWith("withdrawal") ||
      /^dr(amount|amt)?$/.test(header)
    );
    const amount = find((header) => ["amount", "transactionamount", "txnamount"].includes(header));
    const type = find((header) =>
      ["type", "drcr", "transactiontype", "debitcreditindicator"].includes(header)
    );

    if ((transactionDate >= 0 || valueDate >= 0) && description >= 0 && (debit >= 0 || amount >= 0)) {
      return {
        headerIndex: rowIndex,
        dateIndex: transactionDate >= 0 ? transactionDate : valueDate,
        descriptionIndex: description,
        debitIndex: debit,
        amountIndex: amount,
        typeIndex: type,
        referenceIndex: find((header) =>
          header.includes("ref") || header.includes("cheque") || header.includes("utr")
        ),
        balanceIndex: find((header) => header.includes("balance")),
      };
    }
  }
  throw new Error("Could not find date, description, and debit columns in this SBI CSV.");
}

function statementDate(value) {
  const text = String(value || "").trim();
  const makeDate = (year, month, day) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return makeDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    return makeDate(year, Number(match[2]), Number(match[1]));
  }

  match = /^(\d{1,2})[\s-]+([a-z]{3,})[,]?[\s-]+(\d{4})$/i.exec(text);
  if (match) {
    const month = new Date(`${match[2].slice(0, 3)} 1, ${match[3]}`).getMonth() + 1;
    return makeDate(Number(match[3]), month, Number(match[1]));
  }
  return null;
}

function statementAmount(value, rowNumber) {
  const text = String(value || "").trim().replace(/[₹,\s]/g, "");
  if (text === "" || text === "-" || text === "—") return 0;
  const amountText = text.startsWith("(") && text.endsWith(")")
    ? `-${text.slice(1, -1)}`
    : text;
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(amountText)) {
    throw new Error(`The debit amount on statement row ${rowNumber} is not valid.`);
  }
  return Number(amountText);
}

async function hashStatementRow(identity, occurrence) {
  if (!window.crypto?.subtle) {
    throw new Error("This browser cannot create secure import fingerprints.");
  }
  const encoded = new TextEncoder().encode(`${identity}\u001e${occurrence}`);
  const digest = await window.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function parseSbiStatement(rows) {
  const columns = findSbiColumns(rows);
  const occurrenceCounts = new Map();
  const transactions = [];

  for (let rowIndex = columns.headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const description = row[columns.descriptionIndex] || "";
    if (!/\bUPI\b/i.test(description)) continue;

    let amount;
    if (columns.debitIndex >= 0) {
      amount = Math.abs(statementAmount(row[columns.debitIndex], rowIndex + 1));
    } else {
      const rawAmount = row[columns.amountIndex] || "";
      const type = (row[columns.typeIndex] || "").trim();
      const parsedAmount = statementAmount(rawAmount, rowIndex + 1);
      const isDebit = /\b(debit|dr|withdrawal)\b/i.test(type) || parsedAmount < 0;
      if (!isDebit) continue;
      amount = Math.abs(parsedAmount);
    }
    if (amount === 0) continue;
    if (amount > 99999999) {
      throw new Error(`The debit on statement row ${rowIndex + 1} exceeds the app's amount limit.`);
    }

    const date = statementDate(row[columns.dateIndex]);
    if (!date) throw new Error(`Could not read the transaction date on statement row ${rowIndex + 1}.`);

    const reference = columns.referenceIndex >= 0 ? row[columns.referenceIndex] || "" : "";
    const balance = columns.balanceIndex >= 0 ? row[columns.balanceIndex] || "" : "";
    const identity = [
      date,
      description.toLowerCase().replace(/\s+/g, " ").trim(),
      amount.toFixed(2),
      reference.trim(),
      balance.trim(),
    ].join("\u001f");
    const occurrence = occurrenceCounts.get(identity) || 0;
    occurrenceCounts.set(identity, occurrence + 1);
    const sourceHash = await hashStatementRow(identity, occurrence);

    transactions.push({
      id: `sbi-${sourceHash}`,
      sourceHash,
      title: description.slice(0, 70),
      amount,
      category: "other",
      method: "upi",
      date,
      duplicate: false,
    });
    if (transactions.length > MAX_SBI_IMPORT_ROWS) {
      throw new Error(`Choose a statement with no more than ${MAX_SBI_IMPORT_ROWS} UPI debits.`);
    }
  }
  return transactions;
}

async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import("./node_modules/pdfjs-dist/build/pdf.min.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc =
        new URL("./node_modules/pdfjs-dist/build/pdf.worker.min.mjs", document.baseURI).href;
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

function groupPdfTextLines(items) {
  const sortedItems = items
    .filter((item) => item.text && Number.isFinite(item.x) && Number.isFinite(item.y))
    .sort((left, right) => right.y - left.y || left.x - right.x);
  const lines = [];

  for (const item of sortedItems) {
    const lastLine = lines[lines.length - 1];
    if (!lastLine || Math.abs(lastLine.y - item.y) > 2.5) {
      lines.push({ y: item.y, items: [item] });
    } else {
      lastLine.items.push(item);
    }
  }

  return lines.map((line) => {
    line.items.sort((left, right) => left.x - right.x);
    line.text = line.items.map((item) => item.text).join(" ");
    return line;
  });
}

function findPdfSbiColumns(line) {
  const labels = line.items.map((item) => ({ item, name: normalizedHeader(item.text) }));
  const date = labels.find(({ name }) => ["txndate", "transactiondate", "date", "valuedate"].includes(name))?.item;
  const description = labels.find(({ name }) =>
    ["description", "narration", "particulars", "remarks", "transactiondetails"]
      .some((label) => name.includes(label))
  )?.item;
  const debit = labels.find(({ name }) =>
    name.startsWith("debit") || name.startsWith("withdrawal") || /^dr(amount|amt)?$/.test(name)
  )?.item;
  const reference = labels.find(({ name }) =>
    name.startsWith("ref") || name.includes("cheque") || name.includes("utr")
  )?.item;

  if (!date || !description || !debit || date.x >= description.x || description.x >= debit.x) {
    return null;
  }

  const isHeaderLabel = (name) =>
    ["txndate", "transactiondate", "date", "valuedate"].includes(name) ||
    ["description", "narration", "particulars", "remarks", "transactiondetails"]
      .some((label) => name.includes(label)) ||
    name.startsWith("debit") ||
    name.startsWith("withdrawal") ||
    /^dr(amount|amt)?$/.test(name) ||
    name.startsWith("credit") ||
    name.startsWith("deposit") ||
    name.startsWith("ref") ||
    name.includes("cheque") ||
    name.includes("utr") ||
    name.includes("balance");
  const headerPositions = labels
    .filter(({ name }) => isHeaderLabel(name))
    .map(({ item }) => item.x)
    .sort((left, right) => left - right);
  const nextBoundary = (position) =>
    headerPositions.find((headerPosition) => headerPosition > position + 1) ?? Number.POSITIVE_INFINITY;

  return {
    dateStart: date.x,
    dateEnd: nextBoundary(date.x),
    descriptionStart: description.x,
    descriptionEnd: nextBoundary(description.x),
    debitStart: debit.x,
    debitEnd: nextBoundary(debit.x),
    referenceStart: reference ? reference.x : nextBoundary(debit.x),
    referenceEnd: reference ? nextBoundary(reference.x) : Number.POSITIVE_INFINITY,
  };
}

function pdfColumnText(line, start, end) {
  return line.items
    .filter((item) => {
      const center = item.x + (Number.isFinite(item.width) ? item.width / 2 : 0);
      return center >= start && center < end;
    })
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function parseSbiPdf(file) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  let documentProxy;

  try {
    documentProxy = await loadingTask.promise;
    if (documentProxy.numPages > 100) {
      throw new Error("Choose a statement PDF with no more than 100 pages.");
    }

    const rows = [["Txn Date", "Description", "Debit", "Reference", "Balance"]];
    let columns = null;
    let foundText = false;
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      const page = await documentProxy.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items
        .filter((item) => typeof item.str === "string" && item.str.trim() && item.transform)
        .map((item) => ({
          text: item.str.trim(),
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
        }));
      if (items.length > 0) foundText = true;

      for (const line of groupPdfTextLines(items)) {
        const detectedColumns = findPdfSbiColumns(line);
        if (detectedColumns) {
          columns = detectedColumns;
          continue;
        }
        if (!columns) continue;

        const date = pdfColumnText(line, columns.dateStart, columns.dateEnd);
        const description = pdfColumnText(line, columns.descriptionStart, columns.descriptionEnd);
        if (!date && !description) continue;
        const debit = pdfColumnText(line, columns.debitStart, columns.debitEnd);
        const reference = pdfColumnText(line, columns.referenceStart, columns.referenceEnd);
        if (date) {
          rows.push([date, description, debit, reference, ""]);
        } else {
          const previous = rows[rows.length - 1];
          const firstItem = line.items[0];
          if (
            previous &&
            /\bUPI\b/i.test(previous[1]) &&
            firstItem &&
            firstItem.x >= columns.descriptionStart - 5 &&
            firstItem.x < columns.debitStart
          ) {
            previous[1] = `${previous[1]} ${description}`.trim();
            if (!previous[2] && debit) previous[2] = debit;
            if (!previous[3] && reference) previous[3] = reference;
          }
        }
      }
      await page.cleanup();
    }

    if (!foundText) {
      throw new Error("This PDF has no selectable text. Use a text-based statement or upload a CSV instead.");
    }
    if (!columns) {
      throw new Error("Could not identify the SBI statement table in this PDF. Try downloading the statement as CSV.");
    }
    return await parseSbiStatement(rows);
  } finally {
    await loadingTask.destroy();
  }
}

function budgetStatus(spent, budget) {
  const spentMinorUnits = Math.round(spent * 100);
  const budgetMinorUnits = Math.round(budget * 100);
  if (budgetMinorUnits <= 0) return { key: "none", label: "No budget" };
  if (spentMinorUnits > budgetMinorUnits) return { key: "over", label: "Over budget" };
  if (spentMinorUnits === budgetMinorUnits) return { key: "limit", label: "At limit" };
  if (spentMinorUnits / budgetMinorUnits >= 0.8) return { key: "near", label: "Near limit" };
  return { key: "under", label: "On track" };
}

function createStatusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `report-status ${status.key}`;
  badge.textContent = status.label;
  return badge;
}

function renderCategoryOptions() {
  elements.expenseCategory.replaceChildren();
  for (const category of CATEGORIES) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = category.label;
    elements.expenseCategory.append(option);
  }
}

function renderBudgetInputs() {
  const budgets = monthBudgets();
  elements.budgetForm.replaceChildren();

  for (const category of CATEGORIES) {
    const wrapper = document.createElement("label");
    wrapper.className = "budget-item";

    const top = document.createElement("span");
    top.className = "budget-item-top";
    const categoryName = document.createElement("span");
    categoryName.className = "budget-category";
    const dot = document.createElement("span");
    dot.className = "budget-dot";
    dot.style.backgroundColor = category.color;
    const label = document.createElement("span");
    label.textContent = category.label;
    categoryName.append(dot, label);
    top.append(categoryName);

    const inputWrap = document.createElement("span");
    inputWrap.className = "budget-input-wrap";
    inputWrap.append(document.createTextNode("₹"));
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "99999999";
    input.step = "100";
    input.inputMode = "decimal";
    input.name = category.id;
    input.id = `budget-${category.id}`;
    input.value = String(budgets[category.id] || 0);
    input.setAttribute("aria-label", `${category.label} monthly budget`);
    inputWrap.append(input);

    const progress = document.createElement("div");
    progress.className = "budget-progress";
    progress.setAttribute("aria-hidden", "true");
    const fill = document.createElement("div");
    fill.className = "budget-progress-fill";
    fill.style.backgroundColor = category.color;
    progress.append(fill);

    const foot = document.createElement("span");
    foot.className = "budget-item-foot";
    const spent = document.createElement("span");
    spent.className = "budget-spent";
    const remaining = document.createElement("span");
    remaining.className = "budget-remaining";
    foot.append(spent, remaining);

    wrapper.append(top, inputWrap, progress, foot);
    elements.budgetForm.append(wrapper);
  }
}

function renderSummary(transactions, categoryTotals) {
  const spent = totalOf(categoryTotals);
  const budgets = monthBudgets();
  const budget = totalOf(budgets);
  const available = budget - spent;
  const upi = transactions
    .filter((transaction) => transaction.method === "upi");
  const cash = transactions
    .filter((transaction) => transaction.method === "cash");

  document.getElementById("total-spent").textContent = formatCurrency(spent);
  document.getElementById("transaction-count").textContent =
    `${transactions.length} transaction${transactions.length === 1 ? "" : "s"} this month`;
  document.getElementById("total-budget").textContent = formatCurrency(budget);
  document.getElementById("remaining-budget").textContent = formatCurrency(Math.max(available, 0));
  document.getElementById("remaining-caption").textContent =
    budget === 0
      ? "Set budgets to see your balance"
      : available < 0
        ? `${formatCurrency(Math.abs(available))} over budget`
        : "Still available this month";
  document.getElementById("upi-total").textContent = formatCurrency(totalTransactions(upi));
  document.getElementById("cash-total").textContent = `Cash: ${formatCurrency(totalTransactions(cash))}`;
}

function renderBudgets(categoryTotals) {
  const budgets = monthBudgets();
  for (const category of CATEGORIES) {
    const spent = categoryTotals[category.id] || 0;
    const budget = budgets[category.id] || 0;
    const item = elements.budgetForm.querySelector(`#budget-${category.id}`).closest(".budget-item");
    const fill = item.querySelector(".budget-progress-fill");
    const spentText = item.querySelector(".budget-spent");
    const remainingText = item.querySelector(".budget-remaining");
    const progress = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;
    const status = budgetStatus(spent, budget);
    const overBudget = status.key === "over";

    fill.style.width = `${progress}%`;
    fill.style.backgroundColor = overBudget
      ? "#d95362"
      : ["near", "limit"].includes(status.key)
        ? "#ffb171"
        : category.color;
    spentText.textContent = `${formatCurrency(spent)} spent`;
    remainingText.textContent = budget > 0
      ? overBudget
        ? `${formatCurrency(spent - budget)} over`
        : `${formatCurrency(budget - spent)} left`
      : "No budget set";
    remainingText.classList.toggle("over-budget", ["limit", "over"].includes(status.key));
    remainingText.classList.toggle("near-budget", status.key === "near");
    item.setAttribute(
      "aria-label",
      `${category.label}: ${formatCurrency(spent)} spent${budget > 0 ? ` of ${formatCurrency(budget)}` : ", no budget set"}`
    );
  }
}

function renderBudgetReminders(categoryTotals) {
  const alerts = CATEGORIES.flatMap((category) => {
    const spent = categoryTotals[category.id] || 0;
    const budget = monthBudgets()[category.id] || 0;
    const status = budgetStatus(spent, budget);
    if (!["near", "limit", "over"].includes(status.key)) return [];

    const detail = status.key === "over"
      ? `${formatCurrency(spent - budget)} over budget`
      : status.key === "limit"
        ? "budget limit reached"
        : `${Math.floor((spent / budget) * 100)}% of budget used`;
    return [{ category, detail, status }];
  });

  elements.budgetAlertList.replaceChildren();
  for (const alert of alerts) {
    const item = document.createElement("li");
    item.className = `budget-alert-item ${alert.status.key}`;
    item.textContent = `${alert.category.label}: ${alert.detail}.`;
    elements.budgetAlertList.append(item);
  }
  elements.budgetAlerts.hidden = alerts.length === 0;
  checkBrowserBudgetNotifications(categoryTotals);
}

function rememberBrowserNotification(key) {
  notificationHistory.add(key);
  try {
    localStorage.setItem(
      NOTIFICATION_STORAGE_KEY,
      JSON.stringify([...notificationHistory].slice(-300))
    );
  } catch (error) {
    showAppMessage(`A browser reminder could not be saved to reminder history: ${error.message}`);
  }
}

function sendBrowserBudgetNotification(key, title, body) {
  if (
    !("Notification" in window) ||
    window.Notification.permission !== "granted" ||
    notificationHistory.has(key) ||
    attemptedNotifications.has(key)
  ) {
    return;
  }

  attemptedNotifications.add(key);
  try {
    const notification = new window.Notification(title, {
      body,
      icon: "./assets/paisa-192.png",
      tag: key,
    });
    notification.onclick = () => window.focus();
    rememberBrowserNotification(key);
  } catch (error) {
    showAppMessage(`A browser budget alert could not be shown: ${error.message}`);
  }
}

function checkBrowserBudgetNotifications(categoryTotals) {
  if (
    selectedMonth !== currentMonth() ||
    !("Notification" in window) ||
    window.Notification.permission !== "granted"
  ) {
    return;
  }

  for (const category of CATEGORIES) {
    const spent = categoryTotals[category.id] || 0;
    const budget = monthBudgets()[category.id] || 0;
    if (budget <= 0) continue;

    if (spent / budget >= 0.8) {
      sendBrowserBudgetNotification(
        `${selectedMonth}:${category.id}:near`,
        "Budget reminder",
        `${category.label}: ${formatCurrency(spent)} spent of ${formatCurrency(budget)}.`
      );
    }
    if (spent > budget) {
      sendBrowserBudgetNotification(
        `${selectedMonth}:${category.id}:over`,
        "Budget exceeded",
        `${category.label} is ${formatCurrency(spent - budget)} over its budget.`
      );
    }
  }
}

function renderNotificationControls() {
  if (!("Notification" in window)) {
    elements.notificationButton.disabled = true;
    elements.notificationButton.textContent = "Browser alerts unavailable";
    elements.notificationHint.textContent =
      "In-app warnings start at 80% and when a budget is exceeded.";
    return;
  }

  const permission = window.Notification.permission;
  elements.notificationButton.disabled = permission === "granted" || permission === "denied";
  elements.notificationButton.textContent =
    permission === "granted"
      ? "Browser alerts enabled"
      : permission === "denied"
        ? "Browser alerts blocked"
        : "Enable browser alerts";
  elements.notificationHint.textContent = permission === "denied"
    ? "Browser alerts are blocked in site settings. In-app warnings remain on."
    : permission === "granted"
      ? "In-app and browser alerts are enabled. Browser alerts appear while Paisa is open."
      : "In-app warnings start at 80% and over budget. Browser alerts appear while Paisa is open.";
}

function reportRows(categoryTotals) {
  return CATEGORIES.map((category) => {
    const spent = categoryTotals[category.id] || 0;
    const budget = monthBudgets()[category.id] || 0;
    return {
      category,
      spent,
      budget,
      remaining: budget - spent,
      status: budgetStatus(spent, budget),
    };
  });
}

function renderBudgetReport(categoryTotals) {
  const rows = reportRows(categoryTotals);
  const spent = totalOf(categoryTotals);
  const budget = totalOf(monthBudgets());
  const balance = budget - spent;
  elements.reportPeriod.textContent = monthLabel();
  elements.reportSpent.textContent = formatCurrency(spent);
  elements.reportBudget.textContent = formatCurrency(budget);
  elements.reportBalanceLabel.textContent = budget === 0
    ? "No budgets set"
    : balance < 0
      ? "Over budget"
      : "Available";
  elements.reportBalance.textContent = budget === 0 ? "—" : formatCurrency(Math.abs(balance));
  elements.reportBody.replaceChildren();
  elements.reportFoot.replaceChildren();

  for (const reportRow of rows) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const label = document.createElement("span");
    label.className = "category-label";
    const dot = document.createElement("span");
    dot.className = "budget-dot";
    dot.style.backgroundColor = reportRow.category.color;
    const name = document.createElement("span");
    name.textContent = reportRow.category.label;
    label.append(dot, name);
    nameCell.append(label);

    const spentCell = document.createElement("td");
    spentCell.className = "amount-column";
    spentCell.textContent = formatCurrency(reportRow.spent);
    const budgetCell = document.createElement("td");
    budgetCell.className = "amount-column";
    budgetCell.textContent = reportRow.budget > 0 ? formatCurrency(reportRow.budget) : "—";
    const remainingCell = document.createElement("td");
    remainingCell.className = "amount-column";
    remainingCell.textContent = reportRow.budget > 0
      ? reportRow.remaining < 0
        ? `${formatCurrency(Math.abs(reportRow.remaining))} over`
        : formatCurrency(reportRow.remaining)
      : "—";
    const statusCell = document.createElement("td");
    statusCell.append(createStatusBadge(reportRow.status));
    row.append(nameCell, spentCell, budgetCell, remainingCell, statusCell);
    elements.reportBody.append(row);
  }

  const totalRow = document.createElement("tr");
  const totalLabel = document.createElement("th");
  totalLabel.scope = "row";
  totalLabel.textContent = "Total";
  const totalSpent = document.createElement("td");
  totalSpent.className = "amount-column";
  totalSpent.textContent = formatCurrency(spent);
  const totalBudget = document.createElement("td");
  totalBudget.className = "amount-column";
  totalBudget.textContent = formatCurrency(budget);
  const totalBalance = document.createElement("td");
  totalBalance.className = "amount-column";
  totalBalance.textContent = budget === 0 ? "—" : formatCurrency(Math.abs(balance));
  const totalStatus = document.createElement("td");
  totalStatus.append(createStatusBadge(budgetStatus(spent, budget)));
  totalRow.append(totalLabel, totalSpent, totalBudget, totalBalance, totalStatus);
  elements.reportFoot.append(totalRow);
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function exportBudgetReport() {
  const categoryTotals = totalsByCategory();
  const rows = reportRows(categoryTotals);
  const spent = totalOf(categoryTotals);
  const budget = totalOf(monthBudgets());
  const csvRows = [
    ["Category", "Spent (INR)", "Budget (INR)", "Remaining (INR)", "Status"],
    ...rows.map((row) => [
      row.category.label,
      row.spent.toFixed(2),
      row.budget.toFixed(2),
      row.budget > 0 ? row.remaining.toFixed(2) : "",
      row.status.label,
    ]),
    [
      "Total",
      spent.toFixed(2),
      budget.toFixed(2),
      budget > 0 ? (budget - spent).toFixed(2) : "",
      budgetStatus(spent, budget).label,
    ],
  ];
  const csv = csvRows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const downloadUrl = URL.createObjectURL(
    new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `paisa-budget-report-${selectedMonth}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}

function renderChart(categoryTotals) {
  const canvas = elements.chart;
  const bounds = canvas.getBoundingClientRect();
  const size = Math.max(1, Math.round(bounds.width));
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(size * pixelRatio);
  canvas.height = Math.round(size * pixelRatio);

  const context = canvas.getContext("2d");
  if (!context) {
    showAppMessage("Your browser could not draw the spending chart.");
    return;
  }

  context.scale(pixelRatio, pixelRatio);
  context.clearRect(0, 0, size, size);
  const items = CATEGORIES
    .map((category) => ({ ...category, amount: categoryTotals[category.id] || 0 }))
    .filter((category) => category.amount > 0)
    .sort((left, right) => right.amount - left.amount);
  const total = items.reduce((sum, item) => sum + item.amount, 0);

  elements.chartPeriod.textContent = monthLabel();
  elements.chart.setAttribute(
    "aria-label",
    total > 0
      ? `Pie chart of ${formatCurrency(total)} spending by category for ${monthLabel()}`
      : `No spending recorded for ${monthLabel()}`
  );
  elements.chartEmpty.hidden = total > 0;
  elements.chartLegend.replaceChildren();

  if (total === 0) return;

  const center = size / 2;
  const radius = size * 0.43;
  let startAngle = -Math.PI / 2;
  for (const item of items) {
    const endAngle = startAngle + (item.amount / total) * Math.PI * 2;
    context.beginPath();
    context.moveTo(center, center);
    context.arc(center, center, radius, startAngle, endAngle);
    context.closePath();
    context.fillStyle = item.color;
    context.fill();
    startAngle = endAngle;
  }

  context.beginPath();
  context.arc(center, center, radius * 0.62, 0, Math.PI * 2);
  context.fillStyle = "#111a2b";
  context.fill();
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#f1f4ff";
  context.font = `700 ${Math.max(14, size * 0.105)}px Manrope, sans-serif`;
  context.fillText(formatCurrency(total), center, center - 5, size * 0.55);
  context.fillStyle = "#9aa8be";
  context.font = `500 ${Math.max(9, size * 0.045)}px 'DM Sans', sans-serif`;
  context.fillText("total spent", center, center + size * 0.1);

  for (const item of items) {
    const listItem = document.createElement("li");
    listItem.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = item.color;
    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = item.label;
    const value = document.createElement("span");
    value.className = "legend-value";
    value.textContent = `${Math.round((item.amount / total) * 100)}%`;
    listItem.append(swatch, name, value);
    elements.chartLegend.append(listItem);
  }
}

function renderTransactions(transactions) {
  const methodFilter = elements.methodFilter.value;
  const filtered = transactions
    .filter((transaction) => methodFilter === "all" || transaction.method === methodFilter)
    .sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id));

  elements.transactionList.replaceChildren();
  elements.transactionsEmpty.hidden = filtered.length > 0;

  for (const transaction of filtered) {
    const category = categoryById(transaction.category);
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.className = "expense-name";
    nameCell.textContent = transaction.title;

    const categoryCell = document.createElement("td");
    const categoryLabel = document.createElement("span");
    categoryLabel.className = "category-label";
    const dot = document.createElement("span");
    dot.className = "budget-dot";
    dot.style.backgroundColor = category.color;
    const categoryText = document.createElement("span");
    categoryText.textContent = category.label;
    categoryLabel.append(dot, categoryText);
    categoryCell.append(categoryLabel);

    const dateCell = document.createElement("td");
    dateCell.textContent = formatDate(transaction.date);
    const methodCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `payment-badge${transaction.method === "cash" ? " cash" : ""}`;
    badge.textContent = transaction.method === "upi" ? "UPI" : "Cash";
    methodCell.append(badge);

    const amountCell = document.createElement("td");
    amountCell.className = "transaction-amount";
    amountCell.textContent = formatCurrency(transaction.amount);

    const actionCell = document.createElement("td");
    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-button";
    deleteButton.type = "button";
    deleteButton.dataset.deleteId = transaction.id;
    deleteButton.setAttribute("aria-label", `Delete ${transaction.title}`);
    deleteButton.title = "Delete expense";
    deleteButton.textContent = "×";
    deleteButton.disabled = !backendReady;
    actionCell.append(deleteButton);

    row.append(nameCell, categoryCell, dateCell, methodCell, amountCell, actionCell);
    elements.transactionList.append(row);
  }
}

function renderStatementPreview() {
  const existingIds = new Set(state.transactions.map((transaction) => transaction.id));
  const seenIds = new Set();
  statementCandidates = statementCandidates.map((transaction) => {
    const duplicate = existingIds.has(transaction.id) || seenIds.has(transaction.id);
    seenIds.add(transaction.id);
    return { ...transaction, duplicate };
  });

  elements.statementRows.replaceChildren();
  for (const [index, transaction] of statementCandidates.entries()) {
    const row = document.createElement("tr");
    const dateCell = document.createElement("td");
    dateCell.textContent = formatDate(transaction.date);
    const detailsCell = document.createElement("td");
    detailsCell.className = "import-details";
    detailsCell.textContent = transaction.title;
    detailsCell.title = transaction.title;
    const amountCell = document.createElement("td");
    amountCell.className = "amount-column";
    amountCell.textContent = formatCurrency(transaction.amount);
    const categoryCell = document.createElement("td");
    if (transaction.duplicate) {
      categoryCell.textContent = "—";
    } else {
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Category for ${transaction.title}`);
      for (const category of CATEGORIES) {
        const option = document.createElement("option");
        option.value = category.id;
        option.textContent = category.label;
        select.append(option);
      }
      select.value = transaction.category;
      select.addEventListener("change", () => {
        statementCandidates[index].category = select.value;
      });
      categoryCell.append(select);
    }

    const statusCell = document.createElement("td");
    if (transaction.duplicate) {
      const status = document.createElement("span");
      status.className = "import-status-duplicate";
      status.textContent = "Already imported";
      statusCell.append(status);
    } else {
      statusCell.append(createStatusBadge({ key: "under", label: "Ready" }));
    }
    row.append(dateCell, detailsCell, amountCell, categoryCell, statusCell);
    elements.statementRows.append(row);
  }

  const duplicateCount = statementCandidates.filter((transaction) => transaction.duplicate).length;
  const importableCount = statementCandidates.length - duplicateCount;
  elements.statementSummary.textContent =
    `Found ${statementCandidates.length} UPI debit${statementCandidates.length === 1 ? "" : "s"}. ` +
    `${importableCount} ready to import; ${duplicateCount} already imported. Review each category before saving.`;
  elements.statementPreview.hidden = false;
  elements.importButton.textContent =
    `Import ${importableCount} new UPI transaction${importableCount === 1 ? "" : "s"}`;
  elements.importButton.disabled = !backendReady || importableCount === 0;
}

function render() {
  const transactions = monthTransactions();
  const categoryTotals = totalsByCategory(transactions);
  renderSummary(transactions, categoryTotals);
  renderBudgets(categoryTotals);
  renderBudgetReminders(categoryTotals);
  renderBudgetReport(categoryTotals);
  renderChart(categoryTotals);
  renderTransactions(transactions);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.register("./sw.js").catch((error) => {
    showAppMessage(`Offline app support could not be enabled: ${error.message}`);
  });
}

async function initialize() {
  elements.monthPicker.value = selectedMonth;
  elements.expenseDate.value = localDate();
  notificationHistory = loadNotificationHistory();
  renderNotificationControls();
  renderCategoryOptions();
  renderBudgetInputs();
  render();

  try {
    let serverState = await apiRequest("/api/state");
    if (!Array.isArray(serverState.transactions) || !serverState.budgets) {
      throw new Error("The backend returned an unexpected data format.");
    }

    if (isEmptyState(serverState) && !loadedState.error && hasLegacyData(loadedState.data)) {
      try {
        await apiRequest("/api/migrate", {
          method: "POST",
          body: JSON.stringify(loadedState.data),
        });
        serverState = await apiRequest("/api/state");
        showAppMessage("Your existing browser data has been moved into the local database.", "info");
      } catch (error) {
        if (error.status !== 409) throw error;
        serverState = await apiRequest("/api/state");
      }
    }

    state = serverState;
    setBackendControls(true);
    renderBudgetInputs();
    render();
    if (loadedState.error) {
      showAppMessage(`Your previous browser backup could not be read: ${loadedState.error}`);
    }
  } catch (error) {
    state = loadedState.data;
    setBackendControls(false);
    renderBudgetInputs();
    render();
    showAppMessage(
      `Could not connect to the local database. Start the app with "npm start" in its project folder. ${error.message}`
    );
  }

  if (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true
  ) {
    elements.installButton.hidden = true;
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPromptEvent = event;
});

elements.installButton.addEventListener("click", async () => {
  if (!installPromptEvent) {
    const installed =
      window.matchMedia("(display-mode: standalone)").matches ||
      navigator.standalone === true;
    const isAppleDevice =
      /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (installed) {
      showAppMessage("Paisa is already installed on this device.", "info");
      return;
    }

    showAppMessage(
      isAppleDevice
        ? "To install Paisa, tap Share in Safari, then choose Add to Home Screen."
        : "To install Paisa, choose Install app or Add to Home screen from your browser menu.",
      "info"
    );
    return;
  }

  const promptEvent = installPromptEvent;
  installPromptEvent = null;
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice.outcome === "accepted") {
      elements.installButton.hidden = true;
    } else {
      showAppMessage("Installation was cancelled. You can try again from your browser menu.", "info");
    }
  } catch (error) {
    showAppMessage(`App installation could not be started: ${error.message}`);
  }
});

window.addEventListener("appinstalled", () => {
  installPromptEvent = null;
  elements.installButton.hidden = true;
});

elements.notificationButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    showAppMessage("Browser notifications are not supported here. In-app budget warnings are still available.", "info");
    renderNotificationControls();
    return;
  }
  if (window.Notification.permission === "denied") {
    showAppMessage("Allow notifications for this site in your browser settings to enable browser alerts.", "info");
    return;
  }

  try {
    const permission = window.Notification.permission === "granted"
      ? "granted"
      : await window.Notification.requestPermission();
    renderNotificationControls();
    if (permission === "granted") {
      checkBrowserBudgetNotifications(totalsByCategory());
      showAppMessage("Browser budget alerts are enabled while Paisa is open.", "info");
    } else {
      showAppMessage("Browser alerts were not enabled. In-app budget warnings remain on.", "info");
    }
  } catch (error) {
    showAppMessage(`Browser alerts could not be enabled: ${error.message}`);
  }
});

elements.exportReport.addEventListener("click", () => {
  try {
    exportBudgetReport();
  } catch (error) {
    showAppMessage(`The budget report could not be downloaded: ${error.message}`);
  }
});

elements.statementFile.addEventListener("change", async () => {
  elements.statementMessage.textContent = "";
  elements.statementMessage.classList.remove("success");
  elements.statementPreview.hidden = true;
  elements.statementRows.replaceChildren();
  statementCandidates = [];
  elements.importButton.disabled = true;
  const file = elements.statementFile.files[0];
  if (!file) return;

  try {
    if (file.size > 5 * 1024 * 1024) {
      throw new Error("Choose a CSV or PDF smaller than 5 MB.");
    }
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isCsv = file.type === "text/csv" || /\.csv$/i.test(file.name);
    if (!isPdf && !isCsv) throw new Error("Choose an SBI CSV or PDF statement.");
    statementCandidates = isPdf
      ? await parseSbiPdf(file)
      : await parseSbiStatement(parseCsv(await file.text()));
    if (statementCandidates.length === 0) {
      throw new Error("No UPI debit transactions were found in this statement.");
    }
    renderStatementPreview();
  } catch (error) {
    elements.statementFile.value = "";
    const reason = error.name === "PasswordException"
      ? "Password-protected PDFs are not supported."
      : error.message;
    elements.statementMessage.textContent = `SBI statement could not be read: ${reason}`;
  }
});

elements.importButton.addEventListener("click", async () => {
  const transactions = statementCandidates.filter((transaction) => !transaction.duplicate);
  if (!backendReady || transactions.length === 0) return;
  elements.importButton.disabled = true;
  elements.statementMessage.textContent = "";
  elements.statementMessage.classList.remove("success");

  try {
    const result = await apiRequest("/api/import/sbi", {
      method: "POST",
      body: JSON.stringify({ transactions }),
    });
    state = await apiRequest("/api/state");
    renderBudgetInputs();
    render();
    const previewDuplicates = statementCandidates.length - transactions.length;
    const duplicateCount = previewDuplicates + result.duplicates;
    statementCandidates = [];
    elements.statementFile.value = "";
    elements.statementRows.replaceChildren();
    elements.statementPreview.hidden = true;
    elements.importButton.disabled = true;
    elements.statementMessage.classList.add("success");
    elements.statementMessage.textContent =
      `Imported ${result.imported} UPI transaction${result.imported === 1 ? "" : "s"}. ` +
      `${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} skipped.`;
  } catch (error) {
    elements.statementMessage.textContent = `UPI transactions were not imported: ${error.message}`;
    renderStatementPreview();
  }
});

elements.expenseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.formMessage.textContent = "";

  if (!backendReady) {
    showAppMessage("Expenses cannot be saved until the local database is running.");
    return;
  }

  const amount = Number(elements.expenseAmount.value);
  const title = elements.expenseTitle.value.trim();
  const date = elements.expenseDate.value;
  const category = elements.expenseCategory.value;
  const method = elements.expenseMethod.value;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 99999999) {
    elements.formMessage.textContent = "Enter an amount greater than ₹0 and no more than ₹99,999,999.";
    elements.expenseAmount.focus();
    return;
  }
  if (!title) {
    elements.formMessage.textContent = "Add a short description for this expense.";
    elements.expenseTitle.focus();
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`))) {
    elements.formMessage.textContent = "Choose a valid expense date.";
    elements.expenseDate.focus();
    return;
  }

  const transaction = {
    amount,
    title,
    date,
    category,
    method,
  };
  let savedTransaction;
  try {
    ({ transaction: savedTransaction } = await apiRequest("/api/transactions", {
      method: "POST",
      body: JSON.stringify(transaction),
    }));
  } catch (error) {
    showAppMessage(`Expense was not saved: ${error.message}`);
    return;
  }

  state = { ...state, transactions: [...state.transactions, savedTransaction] };
  selectedMonth = date.slice(0, 7);
  elements.monthPicker.value = selectedMonth;
  elements.expenseForm.reset();
  elements.expenseDate.value = localDate();
  elements.expenseCategory.value = category;
  elements.expenseMethod.value = method;
  renderBudgetInputs();
  render();
  elements.expenseAmount.focus();
});

elements.budgetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!backendReady) {
    showAppMessage("Budgets cannot be saved until the local database is running.");
    return;
  }

  const nextBudgets = {};
  for (const category of CATEGORIES) {
    const input = elements.budgetForm.elements.namedItem(category.id);
    const amount = Number(input.value);
    if (!Number.isFinite(amount) || amount < 0 || amount > 99999999) {
      showAppMessage(`Enter a valid budget for ${category.label}.`);
      input.focus();
      return;
    }
    if (amount > 0) nextBudgets[category.id] = amount;
  }

  let savedBudgets;
  try {
    ({ budgets: savedBudgets } = await apiRequest(`/api/budgets/${selectedMonth}`, {
      method: "PUT",
      body: JSON.stringify(nextBudgets),
    }));
  } catch (error) {
    showAppMessage(`Budgets were not saved: ${error.message}`);
    return;
  }
  state = { ...state, budgets: { ...state.budgets, [selectedMonth]: savedBudgets } };
  render();
});

elements.monthPicker.addEventListener("change", () => {
  if (!/^\d{4}-\d{2}$/.test(elements.monthPicker.value)) return;
  selectedMonth = elements.monthPicker.value;
  renderBudgetInputs();
  render();
});

elements.methodFilter.addEventListener("change", () => renderTransactions(monthTransactions()));

elements.transactionList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-delete-id]");
  if (!button) return;
  if (!backendReady) {
    showAppMessage("Expenses cannot be deleted until the local database is running.");
    return;
  }

  button.disabled = true;
  try {
    await apiRequest(`/api/transactions/${encodeURIComponent(button.dataset.deleteId)}`, {
      method: "DELETE",
    });
  } catch (error) {
    button.disabled = false;
    showAppMessage(`Expense was not deleted: ${error.message}`);
    return;
  }
  state = {
    ...state,
    transactions: state.transactions.filter((transaction) => transaction.id !== button.dataset.deleteId),
  };
  render();
});

window.addEventListener("resize", () => {
  renderChart(totalsByCategory());
});

initialize().catch((error) => {
  setBackendControls(false);
  showAppMessage(`Dashboard initialization failed: ${error.message}`);
});
registerServiceWorker();
