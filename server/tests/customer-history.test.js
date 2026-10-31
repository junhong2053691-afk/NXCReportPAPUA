const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Database = require("better-sqlite3");

const { computeCustomerDetail } = require("../lib/customerDetail");
const { todayKey } = require("../lib/dates");

const projectRoot = path.join(__dirname, "..", "..");

// computeCustomerDetail 会读配置，而 config.json 不进 git。用模板才能在干净 checkout 上跑。
process.env.TRADER_CONFIG = path.join(projectRoot, "config.example.json");

function detailDatabase() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE customers (
      company_id TEXT NOT NULL,
      id TEXT NOT NULL,
      username TEXT DEFAULT '',
      name TEXT DEFAULT '',
      mobile TEXT DEFAULT '',
      referrer TEXT DEFAULT '',
      top_referrer TEXT DEFAULT '',
      bank_account TEXT DEFAULT '',
      bank_name TEXT DEFAULT '',
      register_date TEXT DEFAULT '',
      register_date_key TEXT DEFAULT '',
      last_login TEXT DEFAULT '',
      last_login_date TEXT DEFAULT '',
      last_deposit TEXT DEFAULT '',
      dep_count INTEGER DEFAULT 0,
      dep_total REAL DEFAULT 0,
      wd_count INTEGER DEFAULT 0,
      wd_total REAL DEFAULT 0,
      PRIMARY KEY (company_id, id)
    );
    CREATE TABLE transactions (
      company_id TEXT NOT NULL,
      id TEXT NOT NULL,
      type TEXT DEFAULT '',
      customer_id TEXT DEFAULT '',
      username TEXT DEFAULT '',
      name TEXT DEFAULT '',
      mobile TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      status TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      created_date TEXT DEFAULT '',
      method TEXT DEFAULT '',
      PRIMARY KEY (company_id, id)
    );
  `);
  return db;
}

test("customer detail history is company-scoped and limited to the newest 50 transactions", () => {
  const db = detailDatabase();
  const insertCustomer = db.prepare(`
    INSERT INTO customers
      (company_id, id, username, name, mobile, dep_count, dep_total, wd_count, wd_total, last_deposit)
    VALUES (?, 'shared-id', ?, ?, '0400000000', 55, 550, 0, 0, ?)
  `);
  insertCustomer.run("alpha", "alpha-user", "Alpha Customer", "2026-08-17 10:54:00");
  insertCustomer.run("beta", "beta-user", "Beta Customer", "2026-08-17 11:00:00");

  const insertTransaction = db.prepare(`
    INSERT INTO transactions
      (company_id, id, type, customer_id, username, name, mobile, amount, status, created_at, created_date)
    VALUES (?, ?, 'DEPOSIT', 'shared-id', ?, ?, '0400000000', 10, 'SUCCESS', ?, ?)
  `);
  const today = todayKey();
  for (let index = 0; index < 55; index += 1) {
    const minute = String(index).padStart(2, "0");
    insertTransaction.run(
      "alpha",
      `alpha-${minute}`,
      "alpha-user",
      "Alpha Customer",
      `2026-08-17 10:${minute}:00`,
      today
    );
  }
  insertTransaction.run(
    "beta",
    "beta-newest",
    "beta-user",
    "Beta Customer",
    "2026-08-17 11:00:00",
    today
  );

  try {
    const detail = computeCustomerDetail(db, "alpha", { id: "shared-id" });
    assert.equal(detail.customer.name, "Alpha Customer");
    assert.equal(detail.companyId, "alpha");
    assert.equal(detail.transactions.length, 50);
    assert.equal(detail.transactions[0].id, "alpha-54");
    assert.equal(detail.transactions.at(-1).id, "alpha-05");
    assert.ok(detail.transactions.every((row) => row.id.startsWith("alpha-")));

    const byMobile = computeCustomerDetail(db, "alpha", { mobile: "0400000000" });
    assert.equal(byMobile.customer.username, "alpha-user");
    assert.equal(computeCustomerDetail(db, "missing-company", { id: "shared-id" }), null);
  } finally {
    db.close();
  }
});

test("customerLink creates accessible history links only when a stable identifier exists", () => {
  const source = fs.readFileSync(path.join(projectRoot, "public", "js", "customer-detail.js"), "utf8");
  const sandbox = {
    window: {
      addEventListener() {},
    },
    document: {
      addEventListener() {},
      getElementById() { return null; },
    },
    cleanDisplayName(value) {
      return String(value || "").replace(/<[^>]*>/g, "").trim();
    },
    displayNameHtml(value) {
      return String(value || "-")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
    },
  };
  vm.runInNewContext(source, sandbox);

  const linked = sandbox.window.customerLink("Alice", "cust-1", "0400 000 000");
  assert.match(linked, /class="customer-link"/);
  assert.match(linked, /aria-haspopup="dialog"/);
  assert.match(linked, /data-cid="cust-1"/);
  assert.match(linked, /data-cmobile="0400 000 000"/);
  assert.match(linked, /transactions\.html\?q=0400%20000%20000/);

  const mobileFallback = sandbox.window.customerLink("", "", "0499999999");
  assert.match(mobileFallback, />0499999999<\/a>/);

  const plain = sandbox.window.customerLink("<b>Unknown</b>", "", "");
  assert.equal(plain, "&lt;b>Unknown&lt;/b>");
  assert.doesNotMatch(plain, /customer-link/);
});

test("customer history links cover customer views and stay out of payment-channel scripts", () => {
  const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), "utf8");
  assert.match(read("public", "js", "referrer-report.js"), /customerLink\(c\.name/);
  assert.match(read("public", "js", "audit-history.js"), /customerLink\(txCustomerLabel, tx\.customer_id, tx\.mobile\)/);
  assert.doesNotMatch(read("public", "js", "bank-accounts.js"), /customerLink\(/);
  assert.doesNotMatch(read("public", "js", "bank-settings.js"), /customerLink\(/);
});
