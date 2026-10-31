// 全站安全响应头。CSP 是 XSS 的第二道防线：转义漏掉一处时，注入的脚本也跑不起来。
//
// script-src 'self' 的前提是页面没有内联 <script> 和 on* 属性，也没有第三方脚本 ——
// 新增内联脚本会被浏览器直接拦下，要放进 public/js/。
// style-src 保留 'unsafe-inline'：前端大量拼 style="..."（状态色、布局），改不动。
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function securityHeaders(_req, res, next) {
  res.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "same-origin");
  // 不带 includeSubDomains：同域名下可能还有别的服务。HTTP 响应上浏览器会忽略这个头。
  res.set("Strict-Transport-Security", "max-age=31536000");
  next();
}

module.exports = { securityHeaders, CONTENT_SECURITY_POLICY };
