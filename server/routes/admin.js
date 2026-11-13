const fs = require("fs");
const express = require("express");
const bcrypt = require("bcryptjs");
const { getDb } = require("../db/init");
const { getCompany, maskToken } = require("../lib/companies");
const { companyDetailsForUser, companyIdsForUser, isFullAdmin, authorizedCompanyIds } = require("../lib/userAccess");
const { requireAdmin, requireFullAdmin } = require("../middleware");
const { MIN_PASSWORD_LENGTH } = require("../lib/passwordPolicy");
const {
  getTelegramSettings,
  saveTelegramSettings,
  clearControlBotToken,
  parseChatIds,
  isValidChatId,
  getBackupSettings,
  saveBackupSettings,
} = require("../lib/appSettings");
const { sendMessage, isValidToken, sanitizeErrorText } = require("../services/telegram");
const { pre } = require("../lib/telegramFormat");

const router = express.Router();

router.use(requireAdmin);

function normalizeRole(value) {
  const role = String(value || "operator").trim().toLowerCase();
  return role === "admin" || role === "operator" ? role : null;
}

function normalizeCompanyIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim().toLowerCase()).filter(Boolean))];
}

function validateCompanyIds(db, ids) {
  const missing = ids.filter((id) => !getCompany(db, id));
  if (missing.length) {
    const error = new Error("存在无效的公司 ID");
    error.status = 400;
    throw error;
  }
}

function runAtomic(db, fn) {
  if (typeof db.transaction === "function") return db.transaction(fn)();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (_) {}
    throw error;
  }
}

function replaceCompanyAssignments(db, userId, companyIds) {
  db.prepare("DELETE FROM user_companies WHERE user_id = ?").run(userId);
  const insert = db.prepare("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)");
  for (const companyId of companyIds) insert.run(userId, companyId);
}

// admin 的公司范围（2026-11-13）：'all' = 全部公司 admin，'limited' = 只看 user_companies。operator 没有这个概念。
function normalizeScope(value) {
  const scope = String(value || "").trim().toLowerCase();
  return scope === "all" || scope === "limited" ? scope : null;
}

function userScope(user) {
  if (user.role !== "admin") return null;
  return user.company_scope === "limited" ? "limited" : "all";
}

// 受限 admin 只能管「授权公司全部落在自己范围内」的 operator：部分在外的也不行，
// 否则它改授权时会把那个 operator 在别家的授权顺手抹掉。全部公司 admin 什么都能管。
function canManageOperator(db, actor, target) {
  if (target.role !== "operator") return false;
  if (isFullAdmin(db, actor)) return true;
  const mine = new Set(authorizedCompanyIds(db, actor));
  const theirs = companyIdsForUser(db, target.id);
  return theirs.length > 0 && theirs.every((id) => mine.has(id));
}

function companiesWithinActorScope(db, actor, companyIds) {
  if (isFullAdmin(db, actor)) return true;
  const mine = new Set(authorizedCompanyIds(db, actor));
  return companyIds.every((id) => mine.has(id));
}

const USER_COLUMNS = "id, username, name, role, status, company_scope, created_at, updated_at";

function publicUser(db, user) {
  const scope = userScope(user);
  const companies = user.role === "operator" || scope === "limited" ? companyDetailsForUser(db, user.id) : [];
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    status: user.status,
    company_scope: scope,
    created_at: user.created_at,
    updated_at: user.updated_at,
    company_ids: companies.map((company) => company.id),
    companies: companies.map((company) => ({ id: company.id, name: company.name })),
  };
}

// ---------------------------------------------------------------- Telegram 全局设置
//
// 挂在这个 router 上而不是 /api/banks：这里已经 router.use(requireAdmin)，新端点自动
// 受保护；而且它挂载在 resolveCompany 之前，req.companyId 天然是 undefined，正好匹配
// 「总控 Bot 是全局配置」的语义。

// telegram_outbox.last_error 存的是内部异常原文，要吐给浏览器之前先洗一遍
// （sanitizeErrorText 会抹掉任何 bot token 形状的字符串）。
const sanitizeError = sanitizeErrorText;

function publicTelegramSettings(s) {
  return {
    enabled: s.enabled,
    // token 与 access_token 同等敏感：只回脱敏值，永不返回明文。
    control_bot_token_set: Boolean(s.controlBotToken),
    control_bot_token_masked: maskToken(s.controlBotToken),
    control_chat_ids: s.controlChatIds,
    mirror_alerts_to_control: s.mirrorAlertsToControl,
    poll_timeout_seconds: s.pollTimeoutSeconds,
    outbox_flush_seconds: s.outboxFlushSeconds,
    reconcile_seconds: s.reconcileSeconds,
    updated_at: s.updatedAt,
    updated_by: s.updatedBy,
  };
}

function actorLabel(req) {
  const user = req?.session?.user;
  if (!user) return "";
  return String(user.name || user.username || user.id || "");
}

router.get("/telegram", (_req, res) => {
  res.json({ settings: publicTelegramSettings(getTelegramSettings(getDb())) });
});

router.put("/telegram", (req, res) => {
  const db = getDb();
  const body = req.body || {};
  try {
    const saved = saveTelegramSettings(
      db,
      {
        enabled: body.enabled,
        controlBotToken: body.control_bot_token,
        controlChatIds: body.control_chat_ids,
        mirrorAlertsToControl: body.mirror_alerts_to_control,
        pollTimeoutSeconds: body.poll_timeout_seconds,
        outboxFlushSeconds: body.outbox_flush_seconds,
        reconcileSeconds: body.reconcile_seconds,
      },
      actorLabel(req)
    );
    // 改完即时生效：重建定时器（间隔可能变了）并按新配置调整 bot 集合。
    // 整体 try/catch —— Bot 起不来不该让保存失败。
    try {
      require("../services/telegramBots").applySettings(saved);
    } catch (e) {
      console.warn("[telegram] apply settings:", e.message);
    }
    res.json({ ok: true, settings: publicTelegramSettings(saved) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete("/telegram/token", (req, res) => {
  const saved = clearControlBotToken(getDb(), actorLabel(req));
  try {
    require("../services/telegramBots").applySettings(saved);
  } catch (e) {
    console.warn("[telegram] apply settings:", e.message);
  }
  res.json({ ok: true, settings: publicTelegramSettings(saved) });
});

// 用**表单里的值**发测试消息（token 留空则用已存的），这样保存前就能验证配置对不对。
// 照 /api/companies/test-connection 的既有模式。
router.post("/telegram/test", async (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const current = getTelegramSettings(db);
  const token = String(body.control_bot_token || "").trim() || current.controlBotToken;
  const chatIds = body.control_chat_ids !== undefined
    ? parseChatIds(body.control_chat_ids)
    : parseChatIds(current.controlChatIds);

  if (!token) return res.status(400).json({ error: "请先填写总控 Bot Token" });
  if (!isValidToken(token)) {
    return res.status(400).json({ error: "Bot token 格式不正确，应形如 123456789:AAxxxxxxxx…" });
  }
  const bad = chatIds.filter((v) => !isValidChatId(v));
  if (bad.length) return res.status(400).json({ error: "chat id 必须是整数：" + bad.join(", ") });
  if (!chatIds.length) return res.status(400).json({ error: "请先填写至少一个白名单 chat" });

  // 顺便验证 HTML parse_mode 这条链路本身能走通——命令回复和余额报警都靠它排版。
  const text = [
    "✅ 测试消息",
    "操盘后台的 Telegram 配置可用。",
    pre([
      "/balance   渠道余额",
      "/today     今日业绩",
      "/help      全部命令",
    ]),
  ].join("\n");

  const failures = [];
  for (const chatId of chatIds) {
    try {
      await sendMessage(token, chatId, text, { botKey: "control-test", parseMode: "HTML" });
    } catch (e) {
      failures.push(`${chatId}: ${sanitizeError(e.message)}`);
    }
  }
  if (failures.length) {
    return res.status(400).json({ error: "发送失败 — " + failures.join("；") });
  }
  res.json({ ok: true, message: `已向 ${chatIds.length} 个 chat 发送测试消息` });
});

router.get("/telegram/status", (_req, res) => {
  const db = getDb();
  const counts = { pending: 0, sent: 0, failed: 0, skipped: 0, expired: 0 };
  let lastFailure = null;
  let lastSentAt = null;
  try {
    for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM telegram_outbox GROUP BY state").all()) {
      counts[row.state] = row.n;
    }
    const failed = db
      .prepare(
        "SELECT company_id, bot_key, last_error, created_at FROM telegram_outbox WHERE state = 'failed' ORDER BY id DESC LIMIT 1"
      )
      .get();
    if (failed) {
      lastFailure = {
        company_id: failed.company_id,
        bot_key: failed.bot_key,
        created_at: failed.created_at,
        reason: sanitizeError(failed.last_error),
      };
    }
    lastSentAt =
      db.prepare("SELECT sent_at FROM telegram_outbox WHERE state = 'sent' ORDER BY id DESC LIMIT 1").get()
        ?.sent_at || null;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Bot 级别的故障（401 token 无效 / 403 被踢出群 / 409 有别的消费者）只会写进
  // telegram_bot_state，不产生 outbox 行。光看出站队列的话，坏 token 会完全静默——
  // 那正是这个面板要避免的情况。
  let bots = [];
  try {
    const health = require("../services/telegramBots").botHealth();
    const parkedBy = new Map(health.parked.map((p) => [p.bot_key, p]));
    const states = db
      .prepare("SELECT bot_key, last_error, updated_at FROM telegram_bot_state ORDER BY bot_key")
      .all();
    const keys = new Set([...states.map((s) => s.bot_key), ...health.running, ...parkedBy.keys()]);
    bots = [...keys].sort().map((botKey) => {
      const state = states.find((s) => s.bot_key === botKey);
      const park = parkedBy.get(botKey);
      return {
        bot_key: botKey,
        running: health.running.includes(botKey),
        parked_reason: park ? sanitizeError(park.reason) : "",
        retry_in_seconds: park ? park.retry_in_seconds : null,
        last_error: sanitizeError(state?.last_error || ""),
        updated_at: state?.updated_at || "",
      };
    });
  } catch (e) {
    console.warn("[telegram] bot health:", e.message);
  }

  res.json({ counts, last_failure: lastFailure, last_sent_at: lastSentAt, bots });
});

// ---------------------------------------------------------------- 数据库快照备份
//
// 和 Telegram 同理挂在这个 router 上：已经 router.use(requireAdmin)，而且挂载在
// resolveCompany 之前，req.companyId 天然是 undefined —— 正好匹配「备份是整库、
// 与公司无关」的语义。

function publicBackupSettings(s, dir) {
  return {
    enabled: s.enabled,
    dir: s.dir, // 用户填的原值（可能为空）
    effective_dir: dir, // 实际会写进去的绝对路径
    hour: s.hour,
    keep_days: s.keepDays,
    updated_at: s.updatedAt,
    updated_by: s.updatedBy,
  };
}

// 备份是整个库（含所有公司的客户资料）：只给「全部公司」admin。
router.get("/backup", requireFullAdmin, (_req, res) => {
  const db = getDb();
  const backup = require("../services/backup");
  const settings = getBackupSettings(db);
  let dir = "";
  let files = [];
  let totalBytes = 0;
  try {
    dir = backup.resolveDir(settings);
    files = backup.listSnapshots(dir);
    totalBytes = files.reduce((sum, f) => sum + Number(f.bytes || 0), 0);
  } catch (e) {
    return res.status(500).json({ error: "备份目录不可用: " + e.message });
  }
  res.json({
    settings: publicBackupSettings(settings, dir),
    files,
    total_bytes: totalBytes,
    log: backup.recentBackupLog(db, 30),
  });
});

router.put("/backup", requireFullAdmin, (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const backup = require("../services/backup");
  try {
    const saved = saveBackupSettings(
      db,
      {
        enabled: body.enabled,
        dir: body.dir,
        hour: body.hour,
        keepDays: body.keep_days,
      },
      actorLabel(req)
    );
    // 目录是否真的可写，要等规范化之后才能验——现在验，总比等到凌晨 4 点才发现好。
    let dir;
    try {
      dir = backup.resolveDir(saved);
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      return res.status(400).json({ error: "备份目录不可写: " + e.message });
    }
    res.json({ ok: true, settings: publicBackupSettings(saved, dir) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 手动触发。不 await —— 226MB 的库要跑十秒级，HTTP 请求不该挂在那里等。
// 结果去 GET /backup 的 log 里看。
router.post("/backup/run", requireFullAdmin, (_req, res) => {
  const backup = require("../services/backup");
  backup
    .runSnapshot({ kind: "manual" })
    .catch((e) => console.error("[backup] 手动触发失败:", e.message));
  res.json({ ok: true, started: true, message: "已在后台开始备份，约需十几秒，完成后刷新查看" });
});

// 全部公司 admin 看全部账号；受限 admin 只看自己 + 它管得了的 operator。
router.get("/users", (req, res) => {
  const db = getDb();
  const actor = req.session.user;
  const full = isFullAdmin(db, actor);
  const users = db
    .prepare(
      `SELECT ${USER_COLUMNS}
       FROM users
       WHERE role IN ('admin', 'operator')
       ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username ASC`
    )
    .all()
    .filter((user) => full || user.id === actor.id || canManageOperator(db, actor, user))
    .map((user) => publicUser(db, user));
  res.json({ users });
});

router.post("/users", (req, res) => {
  const { username, password, name } = req.body || {};
  const u = String(username || "").trim();
  const p = String(password || "");
  const displayName = String(name || "").trim() || u;
  const role = normalizeRole(req.body?.role);
  const companyIds = normalizeCompanyIds(req.body?.company_ids);

  if (!role) {
    return res.status(400).json({ error: "角色只能是 admin 或 operator" });
  }
  if (!u || u.length < 2) {
    return res.status(400).json({ error: "账号至少 2 个字符" });
  }
  if (!p || p.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` });
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) {
    return res.status(400).json({ error: "账号只能用字母、数字、._-" });
  }

  const db = getDb();
  const actor = req.session.user;
  const full = isFullAdmin(db, actor);
  // 建 admin（以及设它的公司范围）只给全部公司 admin。
  if (role === "admin" && !full) {
    return res.status(403).json({ error: "只有「全部公司」管理员可以新建管理员" });
  }
  const scope = role === "admin" ? normalizeScope(req.body?.company_scope) || "all" : "all";
  if (db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(u)) {
    return res.status(409).json({ error: "该账号已存在" });
  }
  if (role === "operator" && !companyIds.length) {
    return res.status(400).json({ error: "operator 至少选择一家公司" });
  }
  if (role === "admin" && scope === "limited" && !companyIds.length) {
    return res.status(400).json({ error: "受限管理员至少选择一家公司" });
  }
  const assignCompanies = role === "operator" || scope === "limited";
  if (assignCompanies && !companiesWithinActorScope(db, actor, companyIds)) {
    return res.status(403).json({ error: "只能授权你自己范围内的公司" });
  }
  try {
    validateCompanyIds(db, companyIds);
    const hash = bcrypt.hashSync(p, 10);
    const result = runAtomic(db, () => {
      const inserted = db
        .prepare(
          "INSERT INTO users (username, password_hash, name, role, status, company_scope) VALUES (?, ?, ?, ?, 'active', ?)"
        )
        .run(u, hash, displayName, role, scope);
      if (assignCompanies) replaceCompanyAssignments(db, inserted.lastInsertRowid, companyIds);
      return inserted;
    });
    const user = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(result.lastInsertRowid);
    res.json({ ok: true, user: publicUser(db, user) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put("/users/:id", (req, res) => {
  const id = Number(req.params.id);
  const { password, name, status } = req.body || {};
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user || !["admin", "operator"].includes(user.role)) {
    return res.status(404).json({ error: "账号不存在" });
  }
  const actor = req.session.user;
  const actorFull = isFullAdmin(db, actor);
  const isSelf = actor.id === user.id;
  const body = req.body || {};
  const hasCompanyUpdate = Object.prototype.hasOwnProperty.call(body, "company_ids");
  const hasScopeUpdate = Object.prototype.hasOwnProperty.call(body, "company_scope");
  const companyIds = normalizeCompanyIds(body.company_ids);

  if (user.role === "admin") {
    if (isSelf && (hasCompanyUpdate || hasScopeUpdate)) {
      // 防止全部公司 admin 把自己锁在外面，也防止受限 admin 给自己放宽。
      return res.status(403).json({ error: "不能修改自己的公司范围" });
    }
    if (!isSelf) {
      // 别的 admin：只有全部公司 admin 能动，而且只能动公司范围（名字、密码、状态还是各管各的）。
      if (!actorFull) return res.status(403).json({ error: "不能修改其他管理员" });
      if (name != null || password != null || status != null) {
        return res.status(403).json({ error: "不能修改其他管理员的名字、密码或状态" });
      }
      if (!hasCompanyUpdate && !hasScopeUpdate) {
        return res.status(400).json({ error: "没有要更新的内容" });
      }
      return updateAdminScope(db, user, body, companyIds, hasCompanyUpdate, res);
    }
  } else if (!canManageOperator(db, actor, user)) {
    return res.status(403).json({ error: "无权管理此账号" });
  }

  const updates = [];
  const params = [];

  if (name != null && String(name).trim()) {
    updates.push("name = ?");
    params.push(String(name).trim());
  }
  if (password != null && String(password)) {
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` });
    }
    updates.push("password_hash = ?");
    params.push(bcrypt.hashSync(String(password), 10));
  }
  if (status === "active" || status === "disabled") {
    if (user.role === "admin" && status === "disabled") {
      return res.status(403).json({ error: "不能停用管理员账号" });
    }
    updates.push("status = ?");
    params.push(status);
  }
  if (hasCompanyUpdate) {
    if (user.role !== "operator") {
      return res.status(400).json({ error: "admin 不需要公司授权" });
    }
    if (!companyIds.length) {
      return res.status(400).json({ error: "operator 至少保留一家公司" });
    }
    if (!companiesWithinActorScope(db, actor, companyIds)) {
      return res.status(403).json({ error: "只能授权你自己范围内的公司" });
    }
    try {
      validateCompanyIds(db, companyIds);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  }

  if (!updates.length && !hasCompanyUpdate) {
    return res.status(400).json({ error: "没有要更新的内容" });
  }

  try {
    runAtomic(db, () => {
      if (updates.length) {
        updates.push("updated_at = datetime('now')");
        params.push(id);
        db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      }
      if (hasCompanyUpdate) replaceCompanyAssignments(db, id, companyIds);
    });
    const updated = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id);
    res.json({ ok: true, user: publicUser(db, updated) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// 全部公司 admin 改别的 admin 的公司范围（调用方已确认：操作者是全部公司 admin、目标不是自己）。
function updateAdminScope(db, target, body, companyIds, hasCompanyUpdate, res) {
  const currentScope = userScope(target);
  const requested = Object.prototype.hasOwnProperty.call(body, "company_scope") ? normalizeScope(body.company_scope) : currentScope;
  if (!requested) return res.status(400).json({ error: "公司范围只能是 all 或 limited" });
  const ids = requested === "limited"
    ? (hasCompanyUpdate ? companyIds : companyIdsForUser(db, target.id))
    : [];
  if (requested === "limited" && !ids.length) {
    return res.status(400).json({ error: "受限管理员至少选择一家公司" });
  }
  if (requested === "limited" && currentScope === "all") {
    // 不变量：至少留一个全部公司 admin，否则没人能再建公司、设范围、做备份。
    const others = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND company_scope = 'all' AND status = 'active' AND id <> ?")
      .get(target.id).n;
    if (!others) return res.status(403).json({ error: "至少要保留一个「全部公司」管理员" });
  }
  try {
    validateCompanyIds(db, ids);
    runAtomic(db, () => {
      db.prepare("UPDATE users SET company_scope = ?, updated_at = datetime('now') WHERE id = ?").run(requested, target.id);
      replaceCompanyAssignments(db, target.id, ids);
    });
    const updated = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(target.id);
    return res.json({ ok: true, user: publicUser(db, updated) });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
}

router.delete("/users/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user || !["admin", "operator"].includes(user.role)) {
    return res.status(404).json({ error: "账号不存在" });
  }
  if (user.role === "admin") {
    return res.status(403).json({ error: "不能删除管理员账号" });
  }
  if (!canManageOperator(db, req.session.user, user)) {
    return res.status(403).json({ error: "无权管理此账号" });
  }
  runAtomic(db, () => {
    db.prepare("DELETE FROM user_companies WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  res.json({ ok: true });
});

module.exports = router;
