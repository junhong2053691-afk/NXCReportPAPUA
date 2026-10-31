#!/usr/bin/env node
"use strict";

// Telegram 消息排版的肉眼预览。只读，不碰真库、不发任何网络请求。
//
// 存在的理由：三个渲染器（/balance /today /blocked）的正确性靠单测守，但「在手机上
// 看起来歪不歪」只能看。<pre> 块的对齐全靠 displayWidth 补白，一个中文字顶两格，差一格
// 就整列散掉——所以每行前面打印它的显示宽度，超过 TABLE_MAX_WIDTH 的直接标出来。
//
// 文件名不以 .test.js 结尾，不会被 `node --test server/tests/*.test.js` 捡到。
//
//   node scripts/preview-telegram.js

const { bankDatabase, addAccount, addLedger, addAccountEvent } = require("../server/tests/bank-fixture");
const { refreshBankBalance } = require("../server/lib/bankReport");
const { renderBalance, renderToday } = require("../server/lib/telegramRender");
const { renderBlocked } = require("../server/lib/bankCleanupReport");
const { TABLE_MAX_WIDTH, displayWidth, stripHtml } = require("../server/lib/telegramFormat");
const { todayKey } = require("../server/lib/dates");

const TODAY = todayKey();
const db = bankDatabase();

let seq = 0;
function mk(overrides, amount) {
  const id = addAccount(db, { company_id: "alpha", sort_order: ++seq, ...overrides });
  addLedger(db, id, amount, TODAY);
  refreshBankBalance(db, id, { alert: false });
  return id;
}

// 一家公司，四类账户各一个——刻意混长中文名与长户名，那是最容易把列顶歪的输入。
mk({ bank_branch: "CBA Sydney", account_number: "100007122" }, 1500);
mk({ bank_branch: "ANZ Melbourne", reset_daily_balance: 1, account_number: "100003344" }, 300.25);
mk({ bank_branch: "NAB Perth", active: 0, account_number: "100009900" }, 777);
mk({ bank_branch: "招商银行深圳分行", account_kind: "ghost", account_number: "100005566" }, 2500);
mk({ bank_branch: "FastPay", account_kind: "payment_gateway", account_number: "" }, 9999);

const bannedDirty = mk(
  {
    bank_branch: "Westpac Old",
    account_name: "BRIDGET ISABELLA",
    lifecycle_status: "banned",
    active: 0,
    account_number: "100001234",
  },
  1230
);
const bannedGhost = mk(
  { bank_branch: "Ubank 旧户", lifecycle_status: "banned", active: 0, account_kind: "ghost" },
  450
);
const bannedClean = mk(
  {
    bank_branch: "Bendigo Spare",
    lifecycle_status: "banned",
    active: 0,
    account_kind: "payment_gateway",
    account_number: "100008800",
  },
  0
);
addAccountEvent(db, bannedDirty, "banned", "2026-08-29 03:00:00");
addAccountEvent(db, bannedGhost, "banned", "2026-09-23 03:00:00");
addAccountEvent(db, bannedClean, "banned", "2026-08-02 03:00:00");

// 第二家：只有封禁户，用来看「（全封禁）」与多公司概要。第三家一个账户都没有。
const onlyBanned = addAccount(db, {
  company_id: "beta",
  bank_branch: "HSBC Gone",
  lifecycle_status: "banned",
  active: 0,
  sort_order: 1,
});
addLedger(db, onlyBanned, 88, TODAY);
refreshBankBalance(db, onlyBanned, { alert: false });

const ALPHA = { id: "alpha", name: "AussieX6" };
const BETA = { id: "beta", name: "Rolex66" };
const GAMMA = { id: "gamma", name: "新公司名字" };

function dump(label, blocks) {
  console.log("\n" + "=".repeat(60));
  console.log("  " + label);
  console.log("=".repeat(60));
  for (const line of stripHtml(blocks.join("\n\n")).split("\n")) {
    const w = displayWidth(line);
    // <pre> 外面的脚注与标题行超一点无妨；表格行超了就是手机上会横向滚动。
    const mark = w > TABLE_MAX_WIDTH ? " !" : "  ";
    console.log(String(w).padStart(3) + mark + "| " + line);
  }
}

dump("/balance（单公司明细）", renderBalance(db, [ALPHA], { dateKey: TODAY }));
dump("/balance（多公司概要）", renderBalance(db, [ALPHA, BETA, GAMMA], { dateKey: TODAY }));
dump("/balance all（多公司明细）", renderBalance(db, [ALPHA, BETA], { dateKey: TODAY, detail: true }));
dump("/blocked（单公司明细）", renderBlocked(db, [ALPHA]));
dump("/blocked（多公司概要）", renderBlocked(db, [ALPHA, BETA, GAMMA]));
dump("/blocked all（多公司明细）", renderBlocked(db, [ALPHA, BETA], { detail: true }));
dump("/blocked（无封禁渠道）", renderBlocked(db, [GAMMA]));
dump(
  "/today（单公司）",
  renderToday(db, [ALPHA], {
    dateKey: TODAY,
    computeDashboard: () => ({
      deposits: { total: 12345.6, count: 42 },
      withdrawals: { total: 8000, count: 11 },
      winLoss: { total: 4345.6 },
      depositUsersToday: 28,
      customers: { newToday: 5 },
    }),
  })
);

console.log(
  "\n左列是 displayWidth。表格行（<pre> 里面）应 ≤ " +
    TABLE_MAX_WIDTH +
    "；标了 ! 的若是表格行就是手机上会横向滚动。"
);
db.close();
