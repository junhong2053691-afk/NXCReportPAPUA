const test = require("node:test");
const assert = require("node:assert/strict");

const {
  I18N,
  I18N_ATTRS,
  I18N_PHRASES,
  I18N_PHRASES_ZH,
  buildReverseMap,
  translateString,
} = require("../../public/js/i18n");

const CJK = /[一-鿿]/;
const LANGS = ["zh", "en"];

// Tenant data is protected in two layers.
//
// Layer 1, the engine: a string that is not an exact dictionary entry is
// returned byte-identical. There is no substring replacement, which is what
// used to turn "Public Bank Amy" into "Public 银行 Amy" in Chinese mode.
const TENANT_DATA = [
  "Public Bank Amy",
  "Maybank 1234",
  "CIMB Bank Berhad",
  "Name wrong",
  "Total transfer 500",
  "New today deposit reversed",
  "Amy Time Deposit",
  "Rolex",
  "X6",
  // server/lib/bankApply.js writes these into bank_ledger.other_info and
  // server/db/init.js matches them with LIKE. Translating them breaks the
  // migration, so they must survive untouched.
  "WITHDRAW 250.00 split self 100.00",
  "DEPOSIT 80.00 split self 20.00",
  "WITHDRAW 250.00 split 1/3",
  "No cash movement",
];

// Layer 2, translate="no" on the rendering element: data that happens to be
// spelled exactly like a dictionary entry is indistinguishable from UI copy,
// so the engine cannot and must not try to guess. These are pinned here so the
// boundary between the two layers stays visible -- if one of them ever stops
// being rewritten, the marker on its cell may have become load-bearing for the
// wrong reason.
const NEEDS_MARKER = ["Total", "Bank", "Name", "All Customers"];

test("zh and en dictionaries cover the same keys", () => {
  assert.deepEqual(Object.keys(I18N.zh).sort(), Object.keys(I18N.en).sort());
});

// The one deliberate exception: the page source spells this with the
// traditional 綫, and the dictionary normalises it to the simplified 线.
const ZH_NORMALISED = { "在綫人数": "在线人数" };

test("every zh value is its own key", () => {
  for (const key of Object.keys(I18N.zh)) {
    assert.equal(
      I18N.zh[key],
      ZH_NORMALISED[key] || key,
      `I18N.zh[${JSON.stringify(key)}] must be the key itself`
    );
  }
});

test("no English value is left untranslated", () => {
  for (const key of Object.keys(I18N.en)) {
    assert.ok(
      !CJK.test(I18N.en[key]),
      `untranslated: ${JSON.stringify(key)} -> ${JSON.stringify(I18N.en[key])}`
    );
  }
});

test("tenant data passes through byte-identical", () => {
  for (const value of TENANT_DATA) {
    for (const lang of LANGS) {
      assert.equal(
        translateString(value, lang),
        value,
        `${lang}: ${JSON.stringify(value)} was rewritten`
      );
    }
  }
});

test("data spelled exactly like UI copy relies on the translate=\"no\" marker", () => {
  for (const value of NEEDS_MARKER) {
    assert.notEqual(
      translateString(value, "zh"),
      value,
      `${JSON.stringify(value)} is no longer ambiguous; re-check why its cell is marked`
    );
  }
});

test("no phrase rule matches tenant data", () => {
  for (const value of TENANT_DATA) {
    for (const [pattern] of I18N_PHRASES.concat(I18N_PHRASES_ZH)) {
      assert.ok(
        !pattern.test(value),
        `${pattern} matches tenant data ${JSON.stringify(value)}`
      );
    }
  }
});

test("translating a Chinese source is idempotent", () => {
  // The engine always re-translates from the cached Chinese source, so the only
  // thing that must hold is that a second pass over the same source is stable.
  for (const key of Object.keys(I18N.zh)) {
    for (const lang of LANGS) {
      const once = translateString(key, lang);
      assert.equal(translateString(key, lang), once, `unstable: ${JSON.stringify(key)}`);
    }
  }
});

test("translating a Chinese source to zh returns it unchanged", () => {
  for (const key of Object.keys(I18N.zh)) {
    assert.equal(translateString(key, "zh"), ZH_NORMALISED[key] || key);
  }
});

test("surrounding whitespace is preserved", () => {
  assert.equal(translateString("  总览  ", "en"), "  Overview  ");
  assert.equal(translateString("\n  保存\n", "en"), "\n  Save\n");
  assert.equal(translateString("   ", "en"), "   ");
});

test("null, undefined and empty input are passed through", () => {
  assert.equal(translateString(null, "en"), null);
  assert.equal(translateString(undefined, "en"), undefined);
  assert.equal(translateString("", "en"), "");
});

test("the reverse map is deterministic", () => {
  assert.deepEqual(buildReverseMap(), buildReverseMap());
});

// There is deliberately no "every forward phrase has an inverse" test. The
// engine always translates from a node's cached Chinese source, so the en->zh
// rules are a cold path that only fires on text that was already English in the
// DOM (appUiLabel output, mostly). Requiring a mirror for every rule would push
// more open-ended patterns into that path, and those are what rewrite data.

test("value is not a translated attribute", () => {
  // bank-accounts.js parses displayed text back into stored values
  // (parseStatus, bankByPickerLabel) and reads rows via <input value>.
  // Translating `value` would write a translated status into bank_ledger.
  assert.ok(!I18N_ATTRS.includes("value"), "I18N_ATTRS must never include `value`");
});
