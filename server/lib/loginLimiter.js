// 登录限流。进程内计数即可：这个应用必须单实例（见 DEPLOY.md 2.2），重启清零也无所谓。
//
// 在跑 bcrypt 之前就计数，而不是失败之后：并发打过来的请求在第一个失败返回之前全都
// 能通过检查，那样挡不住也省不下 CPU。成功登录清掉账号维度的计数。
//
// 账号维度是全局的（不分 IP）：换 IP 的字典攻击只有它能挡。代价是别人能短暂锁住某个
// 账号，所以窗口只有 15 分钟，且 Cloudflare Access 挡在前面时匿名者根本到不了这里。

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USERNAME = 10;
const MAX_PER_IP = 30;
const MAX_KEYS = 10000;

function createLoginLimiter(now = Date.now) {
  const hits = new Map();

  function current(key) {
    const entry = hits.get(key);
    if (!entry) return null;
    if (entry.resetAt <= now()) {
      hits.delete(key);
      return null;
    }
    return entry;
  }

  function bump(key) {
    const entry = current(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    if (hits.size >= MAX_KEYS) sweep();
    hits.set(key, { count: 1, resetAt: now() + WINDOW_MS });
  }

  function sweep() {
    const t = now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= t) hits.delete(key);
    }
    // 全是未过期的 key 说明正在被刷：宁可丢计数也不能让 Map 无限长。
    if (hits.size >= MAX_KEYS) hits.clear();
  }

  /** 超限返回需要等待的秒数，否则计一次并返回 0。 */
  function attempt(ip, username) {
    const userKey = "u:" + String(username || "").toLowerCase();
    const ipKey = "i:" + String(ip || "");
    const user = current(userKey);
    const addr = current(ipKey);
    const blocked = [];
    if (user && user.count >= MAX_PER_USERNAME) blocked.push(user);
    if (addr && addr.count >= MAX_PER_IP) blocked.push(addr);
    if (blocked.length) {
      const until = Math.max(...blocked.map((entry) => entry.resetAt));
      return Math.max(1, Math.ceil((until - now()) / 1000));
    }
    bump(userKey);
    bump(ipKey);
    return 0;
  }

  function succeeded(username) {
    hits.delete("u:" + String(username || "").toLowerCase());
  }

  return { attempt, succeeded };
}

module.exports = { createLoginLimiter, MAX_PER_USERNAME, MAX_PER_IP };
