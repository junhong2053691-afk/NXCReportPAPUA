// One full pass before the vendored script below blocks the first paint, then
// bind the toggle and start observing. app.js is not loaded on this page, so
// login.html wires i18n.js up itself.
if (window.dashI18nApply) { window.dashI18nApply(); setupLanguage(); }
