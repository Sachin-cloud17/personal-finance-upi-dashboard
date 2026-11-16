const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATABASE_PATH = path.join(DATA_DIR, "paisa.sqlite");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8011);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SBI_IMPORT_ROWS = 2000;
const MAX_AMOUNT = 99999999;
const CATEGORIES = new Set(["food", "transport", "shopping", "bills", "health", "other"]);
const METHODS = new Set(["cash", "upi"]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    category TEXT NOT NULL CHECK (category IN ('food', 'transport', 'shopping', 'bills', 'health', 'other')),
    method TEXT NOT NULL CHECK (method IN ('cash', 'upi')),
    spent_on TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS budgets (
    month TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('food', 'transport', 'shopping', 'bills', 'health', 'other')),
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    PRIMARY KEY (month, category)
  );
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const insertTransaction = database.prepare(`
  INSERT INTO transactions (id, title, amount_paise, category, method, spent_on)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertImportedTransaction = database.prepare(`
  INSERT OR IGNORE INTO transactions (id, title, amount_paise, category, method, spent_on)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertBudget = database.prepare(`
  INSERT INTO budgets (month, category, amount_paise)
  VALUES (?, ?, ?)
`);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return Promise.reject(new HttpError(415, "Content-Type must be application/json."));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteCount = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      if (tooLarge) return;
      byteCount += chunk.length;
      if (byteCount > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new HttpError(413, "Request body is too large."));
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });

    request.on("error", (error) => reject(error));
  });
}

function amountToPaise(amount, allowZero = false) {
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < (allowZero ? 0 : 0.01) ||
    amount > MAX_AMOUNT
  ) {
    throw new HttpError(400, `Amount must be between ₹${allowZero ? "0" : "0.01"} and ₹${MAX_AMOUNT}.`);
  }
  const paise = Math.round(amount * 100);
  if (!allowZero && paise < 1) throw new HttpError(400, "Amount must be at least ₹0.01.");
  return paise;
}

function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isValidMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validateTransaction(value, preserveId = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expense must be an object.");
  }

  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (title.length === 0 || title.length > 70) {
    throw new HttpError(400, "Expense description must contain 1 to 70 characters.");
  }
  if (!CATEGORIES.has(value.category)) throw new HttpError(400, "Choose a valid expense category.");
  if (!METHODS.has(value.method)) throw new HttpError(400, "Payment method must be cash or UPI.");
  if (typeof value.date !== "string" || !isValidDate(value.date)) {
    throw new HttpError(400, "Choose a valid expense date.");
  }

  let id = randomUUID();
  if (preserveId) {
    if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 100) {
      throw new HttpError(400, "Imported expense has an invalid ID.");
    }
    id = value.id;
  }

  const amountPaise = amountToPaise(value.amount);
  return {
    id,
    title,
    amount: amountPaise / 100,
    amountPaise,
    category: value.category,
    method: value.method,
    date: value.date,
  };
}

function validateBudgets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Budgets must be an object keyed by category.");
  }

  const budgets = [];
  for (const [category, amount] of Object.entries(value)) {
    if (!CATEGORIES.has(category)) throw new HttpError(400, "Choose a valid budget category.");
    const amountPaise = amountToPaise(amount, true);
    if (amountPaise > 0) budgets.push({ category, amountPaise });
  }
  return budgets;
}

function transactionally(run) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readState() {
  const transactions = database.prepare(`
    SELECT id, title, amount_paise, category, method, spent_on
    FROM transactions
    ORDER BY spent_on DESC, created_at DESC, id DESC
  `).all().map((row) => ({
    id: row.id,
    title: row.title,
    amount: Number(row.amount_paise) / 100,
    category: row.category,
    method: row.method,
    date: row.spent_on,
  }));

  const budgets = {};
  for (const row of database.prepare(
    "SELECT month, category, amount_paise FROM budgets ORDER BY month, category"
  ).all()) {
    budgets[row.month] ||= {};
    budgets[row.month][row.category] = Number(row.amount_paise) / 100;
  }

  return { transactions, budgets };
}

function writeLegacyState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.transactions) ||
    typeof value.budgets !== "object" ||
    value.budgets === null ||
    Array.isArray(value.budgets)
  ) {
    throw new HttpError(400, "Legacy data is missing transactions or budgets.");
  }
  if (value.transactions.length > 10000) throw new HttpError(413, "Too many expenses to import at once.");

  const transactions = value.transactions.map((transaction) => validateTransaction(transaction, true));
  if (new Set(transactions.map((transaction) => transaction.id)).size !== transactions.length) {
    throw new HttpError(400, "Imported expenses contain duplicate IDs.");
  }

  const budgets = [];
  for (const [month, monthBudgets] of Object.entries(value.budgets)) {
    if (!isValidMonth(month)) throw new HttpError(400, "Imported data contains an invalid budget month.");
    for (const budget of validateBudgets(monthBudgets)) {
      budgets.push({ month, ...budget });
    }
  }
  if (Object.keys(value.budgets).length > 240) throw new HttpError(413, "Too many budget months to import.");

  const migration = database.prepare(
    "SELECT value FROM app_meta WHERE key = 'legacy_browser_import'"
  ).get();
  if (migration) throw new HttpError(409, "Browser data has already been imported.");

  const transactionCount = Number(database.prepare("SELECT COUNT(*) AS count FROM transactions").get().count);
  const budgetCount = Number(database.prepare("SELECT COUNT(*) AS count FROM budgets").get().count);
  if (transactionCount > 0 || budgetCount > 0) {
    throw new HttpError(409, "The database already contains data; import was not applied.");
  }

  transactionally(() => {
    for (const transaction of transactions) {
      insertTransaction.run(
        transaction.id,
        transaction.title,
        transaction.amountPaise,
        transaction.category,
        transaction.method,
        transaction.date
      );
    }
    for (const budget of budgets) insertBudget.run(budget.month, budget.category, budget.amountPaise);
    database.prepare("INSERT INTO app_meta (key, value) VALUES ('legacy_browser_import', ?)")
      .run(new Date().toISOString());
  });

  return { importedTransactions: transactions.length, importedBudgets: budgets.length };
}

function writeSbiTransactions(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.transactions)) {
    throw new HttpError(400, "SBI import must contain a transactions array.");
  }
  if (value.transactions.length > MAX_SBI_IMPORT_ROWS) {
    throw new HttpError(413, `Import no more than ${MAX_SBI_IMPORT_ROWS} transactions at a time.`);
  }

  const transactions = value.transactions.map((transaction) => {
    if (
      !transaction ||
      typeof transaction.sourceHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(transaction.sourceHash)
    ) {
      throw new HttpError(400, "Imported transaction has an invalid source fingerprint.");
    }
    return validateTransaction({ ...transaction, id: `sbi-${transaction.sourceHash}` }, true);
  });

  return transactionally(() => {
    let imported = 0;
    for (const transaction of transactions) {
      const result = insertImportedTransaction.run(
        transaction.id,
        transaction.title,
        transaction.amountPaise,
        transaction.category,
        transaction.method,
        transaction.date
      );
      imported += Number(result.changes);
    }
    return { imported, duplicates: transactions.length - imported };
  });
}

async function handleApi(request, response, url) {
  if (request.method !== "GET") {
    const origin = request.headers.origin;
    if (origin && origin !== `http://${HOST}:${PORT}`) {
      throw new HttpError(403, "Cross-origin changes are not allowed.");
    }
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, readState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/migrate") {
    const body = await readJson(request);
    const imported = writeLegacyState(body);
    sendJson(response, 200, { ok: true, ...imported });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/import/sbi") {
    const body = await readJson(request);
    sendJson(response, 200, { ok: true, ...writeSbiTransactions(body) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/transactions") {
    const body = await readJson(request);
    const transaction = validateTransaction(body);
    try {
      insertTransaction.run(
        transaction.id,
        transaction.title,
        transaction.amountPaise,
        transaction.category,
        transaction.method,
        transaction.date
      );
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new HttpError(409, "That expense already exists.");
      }
      throw error;
    }
    sendJson(response, 201, {
      transaction: {
        id: transaction.id,
        title: transaction.title,
        amount: transaction.amount,
        category: transaction.category,
        method: transaction.method,
        date: transaction.date,
      },
    });
    return;
  }

  const deleteMatch = /^\/api\/transactions\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteMatch) {
    const id = decodeURIComponent(deleteMatch[1]);
    const result = database.prepare("DELETE FROM transactions WHERE id = ?").run(id);
    if (Number(result.changes) === 0) throw new HttpError(404, "Expense was not found.");
    sendJson(response, 200, { ok: true });
    return;
  }

  const budgetMatch = /^\/api\/budgets\/(\d{4}-\d{2})$/.exec(url.pathname);
  if (request.method === "PUT" && budgetMatch) {
    const month = budgetMatch[1];
    if (!isValidMonth(month)) throw new HttpError(400, "Choose a valid budget month.");
    const budgets = validateBudgets(await readJson(request));
    transactionally(() => {
      database.prepare("DELETE FROM budgets WHERE month = ?").run(month);
      for (const budget of budgets) insertBudget.run(month, budget.category, budget.amountPaise);
    });
    sendJson(response, 200, {
      budgets: Object.fromEntries(budgets.map((budget) => [budget.category, budget.amountPaise / 100])),
    });
    return;
  }

  sendJson(response, 404, { error: "API endpoint was not found." });
}

function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid URL path." });
    return;
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const filePath = path.resolve(ROOT, relativePath);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    sendJson(response, 403, { error: "File access denied." });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "Requested file could not be read." });
      return;
    }
    response.writeHead(200, {
      "Cache-Control": ["/", "/index.html", "/script.js", "/styles.css", "/sw.js"].includes(decodedPath)
        ? "no-cache"
        : "public, max-age=3600",
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  });
}

const server = http.createServer((request, response) => {
  let url;
  try {
    url = new URL(request.url, `http://${HOST}:${PORT}`);
  } catch {
    sendJson(response, 400, { error: "Invalid request URL." });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    handleApi(request, response, url).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error("API request failed:", error);
      sendJson(response, 500, { error: "The local database could not complete that request." });
    });
    return;
  }

  serveStatic(request, response, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Paisa backend listening on http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DATABASE_PATH}`);
});

function closeServer() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);
