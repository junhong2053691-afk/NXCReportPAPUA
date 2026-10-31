const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { bankDatabase: database, addAccount } = require("./bank-fixture");
const {
  LIFECYCLE,
  statusOf,
  isOperating,
  isBanned,
  isArchived,
  isUsableForEntry,
  isCountedInTotals,
  isAlertEligible,
  isVisibleInTelegram,
  SQL_OPERATING,
  KIND_LABELS,
  KIND_TAGS,
  kindOf,
  kindLabel,
  kindTag,
} = require("../lib/bankLifecycle");
const { displayWidth } = require("../lib/telegramFormat");

test("kindOf 对枚举外的值落 nominee，三个类型标显示等宽", () => {
  assert.equal(kindOf({ account_kind: "nominee" }), "nominee");
  assert.equal(kindOf({ account_kind: "ghost" }), "ghost");
  assert.equal(kindOf({ account_kind: "payment_gateway" }), "payment_gateway");
  // 与 routes/banks.js 的 normalizeKind 同口径。这是**显示**判定，不是钱的判定——
  // 钱的判定在 isCountedInTotals，脏值在那边永远落在「计入合计」一侧。
  assert.equal(kindOf({ account_kind: "garbage" }), "nominee");
  assert.equal(kindOf({ account_kind: "" }), "nominee");
  assert.equal(kindOf({}), "nominee");
  assert.equal(kindOf(null), "nominee");

  assert.equal(kindLabel({ account_kind: "ghost" }), "幽灵");
  assert.equal(kindTag({ account_kind: "ghost" }), "幽");

  // /blocked 把类型标挂在 <pre> 的行尾，三个标宽度一旦不齐那一列立刻散掉。
  // 中文一个字顶两格，所以「人」「幽」各 2 格，「PG」也正好 2 格。
  for (const key of Object.keys(KIND_TAGS)) {
    assert.equal(displayWidth(KIND_TAGS[key]), 2, `${key} 的类型标必须是 2 格宽`);
  }
  assert.deepEqual(Object.keys(KIND_TAGS), Object.keys(KIND_LABELS), "两张表的键必须一一对应");
});

// 六个输入 × 全部谓词的真值表。核心是最后两行：空值归 active（schema 默认），
// 枚举外的脏值归 archived（失败关闭）——绝不能被当成可用账户。
test("statusOf 归一化：空值→active，枚举外→archived（失败关闭）", () => {
  assert.equal(statusOf({ lifecycle_status: "active" }), LIFECYCLE.ACTIVE);
  assert.equal(statusOf({ lifecycle_status: "banned" }), LIFECYCLE.BANNED);
  assert.equal(statusOf({ lifecycle_status: "archived" }), LIFECYCLE.ARCHIVED);
  assert.equal(statusOf({ lifecycle_status: "" }), LIFECYCLE.ACTIVE, "空串按 schema 默认");
  assert.equal(statusOf({}), LIFECYCLE.ACTIVE, "字段缺失按 schema 默认");
  assert.equal(statusOf({ lifecycle_status: "  " }), LIFECYCLE.ACTIVE, "纯空白按 schema 默认");

  assert.equal(statusOf({ lifecycle_status: "garbage" }), LIFECYCLE.ARCHIVED, "脏值必须失败关闭");
  assert.equal(statusOf({ lifecycle_status: "Active" }), LIFECYCLE.ARCHIVED, "大小写不同即脏值");
  assert.equal(statusOf(null), LIFECYCLE.ARCHIVED, "空账户不是可用账户");
});

test("脏值不得被任何谓词当成可用账户", () => {
  const dirty = { lifecycle_status: "garbage", account_kind: "nominee" };
  assert.equal(isOperating(dirty), false);
  assert.equal(isUsableForEntry(dirty), false, "脏值不能收钱");
  assert.equal(isCountedInTotals(dirty), false, "脏值不能进合计");
  assert.equal(isAlertEligible(dirty), false);
  assert.equal(isBanned(dirty), false);
  assert.equal(isArchived(dirty), true);
});

test("三态在各谓词上的行为", () => {
  const active = { lifecycle_status: "active", account_kind: "nominee" };
  const banned = { lifecycle_status: "banned", account_kind: "nominee" };
  const archived = { lifecycle_status: "archived", account_kind: "nominee" };

  assert.deepEqual(
    [active, banned, archived].map(isOperating),
    [true, false, false]
  );
  assert.deepEqual(
    [active, banned, archived].map(isUsableForEntry),
    [true, false, false],
    "封禁与归档都不能作为落账目标"
  );
  assert.deepEqual(
    [active, banned, archived].map(isAlertEligible),
    [true, false, false],
    "封禁与归档都不参与阈值报警"
  );
  assert.deepEqual(
    [active, banned, archived].map(isVisibleInTelegram),
    [true, true, false],
    "封禁仍出现在 /balance（钱在哪必须完整），归档不出现"
  );
});

test("isCountedInTotals：状态 × PaymentGateway 交叉", () => {
  assert.equal(isCountedInTotals({ lifecycle_status: "active", account_kind: "nominee" }), true);
  assert.equal(isCountedInTotals({ lifecycle_status: "active", account_kind: "ghost" }), true);
  assert.equal(
    isCountedInTotals({ lifecycle_status: "active", account_kind: "payment_gateway" }),
    false,
    "PG 的钱不是自有资金"
  );
  assert.equal(isCountedInTotals({ lifecycle_status: "banned", account_kind: "nominee" }), false);
  assert.equal(isCountedInTotals({ lifecycle_status: "archived", account_kind: "nominee" }), false);
});

// 这条是能抓到 `lifecycle_status != 'banned'` 那类反向白名单的断言。改造前的写法会让
// archived 和脏值一起被选出来当成可用账户。
test("SQL_OPERATING 是正向白名单：只选出 active，archived 与脏值都排除", () => {
  const db = database();
  const ids = {
    active: addAccount(db, { lifecycle_status: "active", account_name: "A" }),
    banned: addAccount(db, { lifecycle_status: "banned", account_name: "B" }),
    archived: addAccount(db, { lifecycle_status: "archived", account_name: "C" }),
    dirty: addAccount(db, { lifecycle_status: "garbage", account_name: "D" }),
  };

  const rows = db
    .prepare(`SELECT id FROM bank_accounts WHERE company_id = ? AND ${SQL_OPERATING}`)
    .all("alpha");

  assert.deepEqual(rows.map((r) => r.id), [ids.active]);

  // 反向白名单会放行 archived 和脏值——这正是改造前的行为，记录下来当反例。
  const loose = db
    .prepare("SELECT id FROM bank_accounts WHERE company_id = ? AND lifecycle_status != 'banned'")
    .all("alpha");
  assert.equal(loose.length, 3, "反向白名单会放行 archived 与脏值（故不可用）");
  assert.ok(loose.some((r) => r.id === ids.archived));
  assert.ok(loose.some((r) => r.id === ids.dirty));
});

// public/js/app.js 里有一份 window.BankLifecycle 镜像。两边漂移的后果很具体：前端把
// 归档账户当成可用，于是它重新出现在录入下拉和余额汇总里。
//
// 这里不止断言「字面量都在」——那种静态检查挡不住 `>=` 写成 `>` 这类错误。下面把镜像
// 真正 eval 出来，逐个输入与后端谓词对答案。app.js 是无构建的浏览器脚本，整体 eval 会
// 去碰 document，所以只截 window.BankLifecycle = Object.freeze({...}) 那一段。
function loadFrontendMirror() {
  const appJs = fs.readFileSync(path.join(__dirname, "..", "..", "public", "js", "app.js"), "utf8");
  const start = appJs.indexOf("window.BankLifecycle = Object.freeze({");
  assert.ok(start >= 0, "app.js 必须定义 window.BankLifecycle");
  const end = appJs.indexOf("\n});", start);
  assert.ok(end > start, "BankLifecycle 定义没有正常结束");
  const snippet = appJs.slice(start, end + 4);
  const window = {};
  // eslint-disable-next-line no-new-func
  new Function("window", snippet)(window);
  return window.BankLifecycle;
}

test("前端镜像的行为与后端谓词逐项一致", () => {
  const mirror = loadFrontendMirror();
  assert.ok(Object.isFrozen(mirror), "镜像应当冻结，避免页面脚本改掉判定");
  assert.deepEqual(mirror.LIFECYCLE, { ...LIFECYCLE }, "状态字面量必须两边一致");

  const inputs = [];
  for (const status of ["active", "banned", "archived", "", "   ", "garbage", "Active"]) {
    for (const kind of ["nominee", "ghost", "payment_gateway"]) {
      inputs.push({ lifecycle_status: status, account_kind: kind });
    }
  }
  inputs.push({ account_kind: "nominee" }); // 字段缺失
  inputs.push(null);

  for (const input of inputs) {
    const where = JSON.stringify(input);
    assert.equal(mirror.statusOf(input), statusOf(input), `statusOf 不一致：${where}`);
    assert.equal(mirror.isOperating(input), isOperating(input), `isOperating 不一致：${where}`);
    assert.equal(mirror.isBanned(input), isBanned(input), `isBanned 不一致：${where}`);
    assert.equal(mirror.isArchived(input), isArchived(input), `isArchived 不一致：${where}`);
    if (input) {
      assert.equal(
        mirror.isCountedInTotals(input),
        isCountedInTotals(input),
        `isCountedInTotals 不一致（前端汇总会与页面 KPI 对不上）：${where}`
      );
    }
  }
});
