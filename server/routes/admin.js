const express = require("express");
const bcrypt = require("bcryptjs");
const { getDb } = require("../db/init");
const { getCompany } = require("../lib/companies");
const { companyDetailsForUser } = require("../lib/userAccess");
const { requireAdmin } = require("../middleware");

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

function publicUser(db, user) {
  const companies = user.role === "operator" ? companyDetailsForUser(db, user.id) : [];
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at,
    company_ids: companies.map((company) => company.id),
    companies: companies.map((company) => ({ id: company.id, name: company.name })),
  };
}

router.get("/users", (_req, res) => {
  const db = getDb();
  const users = db
    .prepare(
      `SELECT id, username, name, role, status, created_at, updated_at
       FROM users
       WHERE role IN ('admin', 'operator')
       ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username ASC`
    )
    .all()
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
  if (!p || p.length < 4) {
    return res.status(400).json({ error: "密码至少 4 个字符" });
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) {
    return res.status(400).json({ error: "账号只能用字母、数字、._-" });
  }

  const db = getDb();
  if (db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(u)) {
    return res.status(409).json({ error: "该账号已存在" });
  }
  if (role === "operator" && !companyIds.length) {
    return res.status(400).json({ error: "operator 至少选择一家公司" });
  }
  try {
    validateCompanyIds(db, companyIds);
    const hash = bcrypt.hashSync(p, 10);
    const result = runAtomic(db, () => {
      const inserted = db
        .prepare(
          "INSERT INTO users (username, password_hash, name, role, status) VALUES (?, ?, ?, ?, 'active')"
        )
        .run(u, hash, displayName, role);
      if (role === "operator") replaceCompanyAssignments(db, inserted.lastInsertRowid, companyIds);
      return inserted;
    });
    const user = db.prepare("SELECT id, username, name, role, status, created_at, updated_at FROM users WHERE id = ?").get(result.lastInsertRowid);
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
  if (user.role === "admin" && req.session.user.id !== user.id) {
    return res.status(403).json({ error: "不能修改其他管理员" });
  }

  const updates = [];
  const params = [];
  const hasCompanyUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, "company_ids");
  const companyIds = normalizeCompanyIds(req.body?.company_ids);

  if (name != null && String(name).trim()) {
    updates.push("name = ?");
    params.push(String(name).trim());
  }
  if (password != null && String(password)) {
    if (String(password).length < 4) {
      return res.status(400).json({ error: "密码至少 4 个字符" });
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
    const updated = db
      .prepare("SELECT id, username, name, role, status, created_at, updated_at FROM users WHERE id = ?")
      .get(id);
    res.json({ ok: true, user: publicUser(db, updated) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

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
  runAtomic(db, () => {
    db.prepare("DELETE FROM user_companies WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  res.json({ ok: true });
});

module.exports = router;
