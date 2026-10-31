// Set the theme before the stylesheet paints. An external file because the CSP
// forbids inline scripts; see server/lib/securityHeaders.js.
try {
  document.documentElement.setAttribute(
    "data-theme",
    localStorage.getItem("dash-theme") === "dark" ? "dark" : "light"
  );
} catch (e) {}
