const test = require("node:test");
const assert = require("node:assert/strict");

const {
  displayWidth,
  truncateToWidth,
  padEndWidth,
  padStartWidth,
  divider,
  escapeHtml,
  stripHtml,
  pre,
  renderTable,
} = require("../lib/telegramFormat");

test("displayWidth：中文两格、ASCII 一格、变体选择符零格", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("CBA 银行"), 8, "3 + 空格 1 + 中文 4");
  assert.equal(displayWidth("【】"), 4, "全角括号也是两格");
  assert.equal(displayWidth("·"), 1, "中点是窄的，不能当两格");
  assert.equal(displayWidth("─"), 1, "制表线是窄的，否则分隔线会长一倍");
  assert.equal(displayWidth("…"), 1);
  // ⚠️ = U+26A0 + U+FE0F，变体选择符本身不占位。
  assert.equal(displayWidth("⚠️"), displayWidth("⚠"));
  assert.equal(displayWidth(""), 0);
  assert.equal(displayWidth(null), 0);
});

test("padEndWidth / padStartWidth：中英混排补白后宽度一致", () => {
  const rows = ["招商银行", "CBA", "汇丰 HSBC"];
  const padded = rows.map((r) => padEndWidth(r, 12));
  assert.equal(new Set(padded.map(displayWidth)).size, 1);
  for (const p of padded) assert.equal(displayWidth(p), 12);

  const right = rows.map((r) => padStartWidth(r, 12));
  for (const p of right) assert.equal(displayWidth(p), 12);
  assert.ok(right[1].startsWith(" "), "右对齐应把空格补在前面");
});

test("padEndWidth：已经超宽时不裁剪，交给 truncateToWidth 决定", () => {
  assert.equal(padEndWidth("abcdef", 3), "abcdef");
});

test("truncateToWidth：超宽换 …，不超原样返回，不切开代理对", () => {
  assert.equal(truncateToWidth("CBA Sydney", 20), "CBA Sydney");
  assert.equal(truncateToWidth("ANZ Melbourne", 8), "ANZ Mel…");
  assert.equal(displayWidth(truncateToWidth("ANZ Melbourne", 8)), 8);

  const cn = truncateToWidth("招商银行深圳分行", 7);
  assert.ok(displayWidth(cn) <= 7, "中文截断不许超宽");
  assert.ok(cn.endsWith("…"));

  // 星光 emoji 是代理对，切一半会变成乱码字符。
  const emoji = truncateToWidth("🌟🌟🌟🌟", 5);
  assert.ok(![...emoji].some((ch) => ch.codePointAt(0) >= 0xd800 && ch.codePointAt(0) <= 0xdfff));
});

test("divider 的长度就是要求的格数", () => {
  assert.equal(displayWidth(divider(10)), 10);
  assert.equal(divider(3), "───");
});

test("escapeHtml 只动 & < > 三个字符", () => {
  assert.equal(escapeHtml("A & B <Bank>"), "A &amp; B &lt;Bank&gt;");
  assert.equal(escapeHtml("Public_Bank *Amy* [1]"), "Public_Bank *Amy* [1]", "Markdown 的雷区在 HTML 模式无害");
  assert.equal(escapeHtml("招商银行·6789"), "招商银行·6789");
  assert.equal(escapeHtml(""), "");
});

test("stripHtml 是 escapeHtml + pre 的逆操作，用于发送失败时降级", () => {
  for (const s of ["A & B <Bank>", "招商银行 · 1234", "5 > 3 && 2 < 4"]) {
    assert.equal(stripHtml(escapeHtml(s)), s);
    assert.equal(stripHtml(pre([s])), s);
  }
  assert.equal(stripHtml("<code>42</code>"), "42");
});

test("pre 包出成对标签并把内容转义", () => {
  const out = pre(["a", "b & c"]);
  assert.equal(out, "<pre>a\nb &amp; c</pre>");
  assert.equal((out.match(/<pre>/g) || []).length, (out.match(/<\/pre>/g) || []).length);
});

test("renderTable：右列右对齐成一条线，左列超宽被截断", () => {
  const { lines, width } = renderTable(
    [
      { name: "招商银行深圳分行", amount: "1,234.50" },
      { name: "CBA", amount: "80.00" },
    ],
    [
      { key: "name", align: "left", min: 8 },
      { key: "amount", align: "right" },
    ],
    { maxWidth: 24 }
  );
  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal(displayWidth(line), width);
  assert.ok(width <= 24);
  // 两行的金额末位对齐 == 两行等宽（右列右对齐且行尾无补白）。
  assert.ok(lines.every((l) => /\d$/.test(l)));
});

test("renderTable：raw 行原样输出且不参与列宽，divider 跟着表宽", () => {
  const { lines, width } = renderTable(
    [{ raw: "运营中" }, { name: "CBA", amount: "1.00" }, { divider: true }, { name: "小计", amount: "1.00" }],
    [
      { key: "name", align: "left", min: 8 },
      { key: "amount", align: "right" },
    ]
  );
  assert.equal(lines[0], "运营中", "raw 行不补白、不截断");
  assert.equal(displayWidth(lines[2]), width);
  assert.match(lines[2], /^─+$/);
});

test("renderTable：flag 拼在行尾且不占宽度预算", () => {
  const { lines, width } = renderTable(
    [
      { name: "CBA", amount: "1.00", flag: "⚠️" },
      { name: "ANZ", amount: "2.00" },
    ],
    [
      { key: "name", align: "left", min: 8 },
      { key: "amount", align: "right" },
    ]
  );
  assert.ok(lines[0].endsWith(" ⚠️"));
  assert.equal(displayWidth(lines[0].replace(/ ⚠️$/, "")), width, "带 flag 的行前半段仍然等宽");
  assert.equal(displayWidth(lines[1]), width);
});

test("renderTable：行尾不留补白", () => {
  const { lines } = renderTable(
    [{ label: "净额", amount: "1.00", count: "" }],
    [
      { key: "label", align: "left", min: 6 },
      { key: "amount", align: "right" },
      { key: "count", align: "left" },
    ]
  );
  assert.ok(!/ $/.test(lines[0]), "空的末列会拖出看不见的空格：" + JSON.stringify(lines[0]));
});
