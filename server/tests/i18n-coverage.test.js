const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { I18N, I18N_PHRASES } = require("../../public/js/i18n");

const ROOT = path.join(__dirname, "..", "..");
const CJK = /[一-鿿]/;

// Files that are no longer routed (server/index.js maps /index.html to the
// generated page and redirects /deposits.html and /withdrawals.html), so their
// copy is not worth translating.
const DEAD = new Set(["dashboard.js", "dashboard-inline.js", "deposits.js", "withdrawals.js"]);

function decodeEscapes(src) {
  return src.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.search(/(^|[^:])\/\//);
      return idx >= 0 ? line.slice(0, line.indexOf("//", idx)) : line;
    })
    .join("\n");
}

// Split on the characters that also end a DOM text node (tags, quotes, template
// interpolation), so each candidate is roughly one text node.
const BOUNDARY = /["'`<>{}$\n\r\\]/;

function candidates(src) {
  const out = [];
  let buf = "";
  for (const ch of src) {
    if (BOUNDARY.test(ch)) {
      if (CJK.test(buf)) out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (CJK.test(buf)) out.push(buf.trim());
  return out.filter(Boolean);
}

// A candidate that ends (or begins) mid-sentence is a fragment of an
// interpolated string such as `共 ${n} 笔`; the real text node is the whole
// thing and is matched by a phrase rule, which this static scan cannot see.
const FRAGMENT = /[：:，、·|（(「]$|^[，、·|）)」]|^n[一-鿿]|[#–—]\s*$/;

function scan() {
  const files = [path.join(ROOT, "server", "index.js")].concat(
    fs.readdirSync(path.join(ROOT, "public", "js"))
      .filter((f) => f.endsWith(".js") && f !== "i18n.js" && !DEAD.has(f))
      .map((f) => path.join(ROOT, "public", "js", f))
  );

  const gaps = new Map(); // text -> file
  for (const file of files) {
    const src = stripComments(decodeEscapes(fs.readFileSync(file, "utf8")));
    for (const text of candidates(src)) {
      if (gaps.has(text)) continue;
      if (I18N.zh[text] !== undefined) continue;
      if (I18N_PHRASES.some(([re]) => re.test(text))) continue;
      if (FRAGMENT.test(text)) continue;
      gaps.set(text, path.basename(file));
    }
  }
  return gaps;
}

// Ratchet. Every string below is a fragment of an interpolated text node that
// the static scan cannot reassemble -- at runtime the full node is handled by a
// phrase rule. The point of the number is that it must never go UP: a new page
// with untranslated copy fails this test.
const KNOWN_FRAGMENTS = 35;

test("no new untranslated UI copy", () => {
  const gaps = scan();
  const lines = [...gaps].map(([text, file]) => `  ${file}: ${JSON.stringify(text)}`);
  assert.ok(
    gaps.size <= KNOWN_FRAGMENTS,
    `untranslated strings rose from ${KNOWN_FRAGMENTS} to ${gaps.size}.\n` +
      `Add the new ones to I18N, or a phrase rule if a value is interpolated into them:\n` +
      lines.join("\n")
  );
});

test("the ratchet is tight", () => {
  const gaps = scan();
  assert.ok(
    gaps.size >= KNOWN_FRAGMENTS - 5,
    `only ${gaps.size} strings left but KNOWN_FRAGMENTS is ${KNOWN_FRAGMENTS}; lower it so the ratchet keeps biting`
  );
});

test("the dictionary actually covers the pages", () => {
  // Guards against the scan silently matching nothing (a refactor that changes
  // how page copy is written would otherwise make the ratchet above pass).
  const src = decodeEscapes(fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8"));
  const found = candidates(stripComments(src)).filter((t) => I18N.zh[t] !== undefined);
  assert.ok(found.length > 200, `only ${found.length} page strings resolve to dictionary keys`);
});
