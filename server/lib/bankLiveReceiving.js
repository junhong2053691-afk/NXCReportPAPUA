// 实时收款银行（bank_accounts.live_receiving）：员工在当日流水的接单区勾选「现在正在收款的
// 户」，审批平台充值单时 BANK 下拉只列这几个（前端 bank-ledger.js）。2026-11 用户需求。
//
// 约束：
//   - 每家公司最多 MAX_LIVE_RECEIVING 个，只能是运营中且「使用中」（active = 1）的户。
//   - 只能经 setLiveReceiving 整组替换（PUT /api/banks/live-receiving）。这一列刻意不在
//     PUT /api/banks/:id 的白名单里——逐户开关时两个人同时勾，会各自通过「≤ 3」的检查、
//     合起来变成 4 个；整组替换在一条 UPDATE 里完成，better-sqlite3 同步执行，不会超。
//   - 封禁 / 归档 / 取消「使用中」时由 routes/banks.js 在同一条 UPDATE 里清掉。
//   - 它只决定下拉里列哪些户，**不自动审批**：钱要有人点「审批」才入账，这条
//     铁律不变（同步本身不碰余额）。预选只在恰好勾 1 户时做（2026-11-09 用户要求），
//     勾 2～3 户不预选；规则在前端 bank-ledger.js 的 depositBankOptionsHtml。
const { isOperating } = require("./bankLifecycle");

const MAX_LIVE_RECEIVING = 3;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeIds(input) {
  if (!Array.isArray(input)) throw httpError(400, "bank_ids 必须是数组");
  const ids = [];
  for (const raw of input) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw httpError(400, "渠道 ID 无效");
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function currentLiveIds(db, companyId) {
  return db
    .prepare("SELECT id FROM bank_accounts WHERE company_id = ? AND live_receiving = 1 ORDER BY sort_order ASC, id ASC")
    .all(String(companyId || ""))
    .map((r) => r.id);
}

/**
 * 把本公司的实时收款银行整组换成 input（渠道 id 数组，可为空）。
 * 返回 { before, after }（id 数组，按渠道排序）供调用方写审计。校验失败抛带 status 的错误。
 * 不开事务：调用方（路由）把它和审计放进同一个 runAtomic。
 */
function setLiveReceiving(db, companyId, input) {
  const cid = String(companyId || "");
  const ids = normalizeIds(input);
  if (ids.length > MAX_LIVE_RECEIVING) {
    throw httpError(400, `最多 ${MAX_LIVE_RECEIVING} 个实时收款银行，请先取消一个`);
  }
  if (ids.length) {
    const marks = ids.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT id, lifecycle_status, active FROM bank_accounts WHERE company_id = ? AND id IN (${marks})`)
      .all(cid, ...ids);
    // 别家公司的 id 在这里查不到，与不存在同样处理——不泄露「这个 id 属于别家」。
    if (rows.length !== ids.length) throw httpError(400, "渠道不存在");
    if (rows.some((r) => !isOperating(r) || !Number(r.active))) {
      throw httpError(400, "只能选运营中、使用中的渠道");
    }
  }
  const before = currentLiveIds(db, cid);
  if (ids.length) {
    const marks = ids.map(() => "?").join(", ");
    db.prepare(
      `UPDATE bank_accounts SET live_receiving = CASE WHEN id IN (${marks}) THEN 1 ELSE 0 END WHERE company_id = ?`
    ).run(...ids, cid);
  } else {
    db.prepare("UPDATE bank_accounts SET live_receiving = 0 WHERE company_id = ?").run(cid);
  }
  return { before, after: currentLiveIds(db, cid) };
}

module.exports = { MAX_LIVE_RECEIVING, setLiveReceiving, currentLiveIds };
