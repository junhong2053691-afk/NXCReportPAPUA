// 侧栏开合（2026-11-10 用户要求）：不要侧栏外悬浮的「>」、不要汉堡图标。
// 收起时点 logo 展开；展开时用栏内右上角的「<」收起；平板左上角浮的也是 logo。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");
const index = read("server", "index.js");
const app = read("public", "js", "app.js");
const css = read("public", "css", "style.css");

test("侧栏外没有悬浮的展开按钮，也没有汉堡图标", () => {
  assert.doesNotMatch(index, /desktopSidebarToggleHtml/);
  assert.doesNotMatch(index, /chevron-right"><\/i><span class="icon-fallback" aria-hidden="true">›/);
  const menuBtn = index.match(/<button type="button" class="mobile-menu-btn"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(menuBtn, "平板左上角的按钮还在");
  assert.doesNotMatch(menuBtn[0], /data-lucide="menu"/);
  assert.match(menuBtn[0], /<img class="brand-symbol" src="\/brand\/nxc-icon\.png"/);
});

test("logo 是展开按钮、「<」在侧栏顶上那一行里", () => {
  const brand = index.match(/<div class="brand-mark">[\s\S]*?<\/button><\/div>/);
  assert.ok(brand, "brand-mark 结构变了");
  assert.match(brand[0], /<button type="button" class="brand-toggle" id="sidebar-expand-btn"[^>]*><img class="brand-symbol"/);
  assert.match(brand[0], /<button type="button" class="sidebar-collapse-btn icon-btn" id="sidebar-collapse-btn"[^>]*><i data-lucide="chevron-left">/);
});

test("logo 只在桌面收起时展开；「<」桌面收起、平板关抽屉", () => {
  const desk = app.slice(app.indexOf("function setupDesktopSidebar("), app.indexOf("function setupMobileNav("));
  assert.match(desk, /expandBtn\.addEventListener\("click", function \(\) \{\s*if \(window\.innerWidth <= 768\) return;\s*if \(document\.documentElement\.getAttribute\("data-sidebar"\) !== "collapsed"\) return;\s*setDesktopSidebarCollapsed\(false, true\);/);
  assert.match(desk, /collapseBtn\.addEventListener\("click", function \(\) \{\s*if \(window\.innerWidth <= 768\) return;\s*setDesktopSidebarCollapsed\(true, true\);/);
  const mobile = app.slice(app.indexOf("function setupMobileNav("));
  assert.match(mobile, /window\.innerWidth <= 768 && sidebar\.classList\.contains\("open"\)\) closeSidebar\(\)/);
  // 「<」只在展开时出现；不再是 position:fixed 的悬浮按钮
  assert.match(css, /:root\[data-sidebar="expanded"\] \.sidebar-collapse-btn \{ display: inline-grid; \}/);
  const rule = css.match(/\n\.sidebar-collapse-btn \{[^}]*\}/);
  assert.ok(rule);
  assert.doesNotMatch(rule[0], /position:\s*fixed/);
});
