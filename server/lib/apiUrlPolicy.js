// 公司 API 地址的校验。平台 token 只存不显示，但保存和「测试连接」都会把它发往 api_url，
// 所以这个地址决定了 token 的去向：放开它，「token 永不返回明文」的保证就是空话。

const BLOCKED_HOST_RE = /(^localhost$|\.localhost$|\.local$|\.internal$)/i;

function isPrivateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
}

/** 返回地址的问题描述；空地址和合法地址返回空串（空地址由「启用同步」那条校验管）。 */
function apiUrlProblem(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return "API URL 格式无效";
  }
  if (url.protocol !== "https:") return "API URL 必须是 https";
  const host = url.hostname;
  if (BLOCKED_HOST_RE.test(host) || isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return "API URL 不能指向内网地址";
  }
  return "";
}

/**
 * 改地址时必须同时提供 token，否则库里的 token 会被发到新地址。
 * @param {{api_url?: string, access_token?: string}|null} existing 库里的公司行
 * @param {object} body 请求体
 */
function credentialChangeProblem(existing, body) {
  const nextUrl = String(body.api_url ?? existing?.api_url ?? "").trim();
  const problem = apiUrlProblem(nextUrl);
  if (problem) return problem;
  const urlChanged = Boolean(existing) && nextUrl !== String(existing.api_url || "").trim();
  const hasStoredToken = Boolean(String(existing?.access_token || "").trim());
  if (urlChanged && hasStoredToken && !String(body.access_token || "").trim()) {
    return "修改 API URL 时必须重新填写 Access Token";
  }
  return "";
}

module.exports = { apiUrlProblem, credentialChangeProblem };
