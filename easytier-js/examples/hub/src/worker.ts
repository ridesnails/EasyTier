import { createEasyTierCloudflare } from "@easytier/cloudflare";
import { DurableObject } from "cloudflare:workers";
// Pages are bundled into the Worker script (see src/pages.ts, generated from
// public/*.html) instead of Workers Static Assets: the assets-upload-session
// API kept failing 500/code 10013, and an Assets-based /login looped 307.
import { LOGIN_HTML, DASHBOARD_HTML } from "./pages";

const html = (body: string) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

// Env 由 `wrangler types` 生成；可选的 Basic Auth 变量在这里补充声明
type E = Env & {
  DASH_USER?: string; DASH_PASS?: string;
  // JSON: {"<node>":"<token>"}；设了就按节点分发 token，不再接受共享 REPORT_TOKEN
  NODE_TOKENS?: string;
  // "1" = 只接受按节点 token（过渡完成后设置）
  NODE_TOKENS_STRICT?: string;
};

const RELAY = "/relay";
const STALE_PURGE_MS = 24 * 3600 * 1000;
const MAX_BODY = 512 * 1024;
const MAX_LOGIN_BODY = 4 * 1024;
// DO 定时清扫：在此之前只有读接口顺手删过期键，停报节点的 h:/e: 会一直堆
const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;
// 登录失败锁定：同一 IP 10 分钟内 5 次失败后拒到窗口结束
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
// relay 新连接限速：每 IP 每分钟 10 条（浏览器/扫描器会被 Origin 规则先挡掉）
const RELAY_MAX_PER_MIN = 10;
// 单次上报的 peer 上限：防止一条上报塞几万个对象把单例 STATUS 拖死
const MAX_PEERS = 256;
// 入库白名单：宁可丢字段，也不让上报方决定我们存什么（黑名单会被上游新增字段绕过）
const PEER_KEEP = [
  "ipv4", "virtual_ipv4", "cidr", "hostname", "cost", "lat_ms", "loss_rate", "rx_bytes", "tx_bytes",
  "tunnel_proto", "nat_type", "id", "version",
  "city", "country", "lat", "lon", "wan_ip", "wan_ipv4", "wan_ipv6",
] as const;
const NODE_KEEP = ["hostname", "ipv4_addr", "peer_id", "inst_id", "listeners", "version", "feature_flag"] as const;

// 历史与事件：采样 60 秒或 peer 集合变化时存一条，保留 30 天
const HISTORY_SAMPLE_MS = 60 * 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 3600 * 1000;

// ---------- 官方 relay ----------
const easytier = createEasyTierCloudflare<E>({
  namespace: (env) => env.EASYTIER_CORE,
  config: (env) => ({
    networkName: env.EASYTIER_NETWORK_NAME,
    networkSecret: env.EASYTIER_NETWORK_SECRET,
    instanceName: "edge-relay",
    encryption: true,
  }),
});
export class EasyTierCoreObject extends easytier.DurableObject {}

// ---------- 快照存储 ----------
type Snap = { reporter: string; at: number; data: unknown; relay: unknown };
type PeerStat = {
  id: string; hostname: string;
  lat: number | null; rx: number | null; tx: number | null;
  rx_rate: number | null; tx_rate: number | null;
};
type HistEntry = { at: number; peers: PeerStat[] };
type Evt = {
  at: number; type: "join" | "leave" | "ip_change";
  ip: string; hostname: string; reporter: string;
};
type Meta = { lastHistAt: number };

const padTs = (at: number) => String(at).padStart(13, "0");

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// easytier-cli 的流量是带单位字串（如 "4.51 MB"、"47.25 kB"，humansize DECIMAL，
// 即 1000 进制），Number() 直接转会得 NaN；按数字 + 单位解析才是真实字节数。
function parseBytes(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
  if (!m) return null;
  const mult = { B: 1, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4 }[
    (m[2] || "B").toUpperCase()
  ] ?? 1;
  return parseFloat(m[1]) * mult;
}

function isPublicIpv4(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  return !/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip);
}

// 上报里节点对象原样含敏感配置（网络密钥等）与公网地址，入库前剥离，
// 只留展示用的身份字段；WAN 与坐标在入库前抽出来，写进上报节点自己的 peer 行。
function sanitizeNode(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of NODE_KEEP) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// peer 行同理：只保留展示需要的字段，既防未知字段入库，也顺手压住体积
function keepPeerFields(p: unknown): Record<string, unknown> | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PEER_KEEP) if (o[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length ? out : null;
}

// Content-Length 只是声明：缺失、NaN、伪造都能绕过，所以按真实字节流截断。
type CappedBody = { value: unknown; error: "" | "too-large" | "bad-json" };

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const cl = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(cl) && cl > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* 已断开就算了 */ }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

async function readJsonCapped(req: Request, max: number): Promise<CappedBody> {
  const bytes = await readCapped(req, max);
  if (!bytes) return { value: null, error: "too-large" };
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)), error: "" };
  } catch {
    return { value: null, error: "bad-json" };
  }
}

function sanitizeSnap(s: Snap): Snap {
  const data = (s.data ?? {}) as Record<string, unknown>;
  return { ...s, data: { ...data, node: sanitizeNode(data.node) } };
}

// 从上报的 peer 表抽出紧凑统计；兼容数组或 { peers | items } 两种形状
function peerStats(data: unknown): PeerStat[] {
  const raw = Array.isArray(data)
    ? data
    : (data as { peers?: unknown; items?: unknown } | null)?.peers
      ?? (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) return [];
  const out: PeerStat[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const id = String(o.ipv4 ?? o.virtual_ipv4 ?? o.hostname ?? "");
    if (!id) continue;
    out.push({
      id,
      hostname: String(o.hostname ?? ""),
      lat: num(o.lat_ms),
      rx: parseBytes(o.rx_bytes),
      tx: parseBytes(o.tx_bytes),
      rx_rate: null,
      tx_rate: null,
    });
  }
  return out;
}

export class StatusObject extends DurableObject<E> {
  async report(s: Snap): Promise<void> {
    const prev = await this.ctx.storage.get<Snap>(`r:${s.reporter}`);
    await this.ctx.storage.put(`r:${s.reporter}`, s);

    const cur = peerStats((s.data as { peers?: unknown } | null)?.peers);
    const old = prev ? peerStats((prev.data as { peers?: unknown } | null)?.peers) : null;

    // 变化事件：首条上报只建基线，不发 join 事件，避免全网刷屏
    let changed = false;
    if (old && prev) {
      const oldMap = new Map(old.map((p) => [p.id, p]));
      const curMap = new Map(cur.map((p) => [p.id, p]));
      const evts: Evt[] = [];
      const ipMovedOld = new Set<string>();
      for (const p of cur) {
        if (oldMap.has(p.id)) continue;
        const sameHost = old.find((o) => o.hostname && o.hostname === p.hostname);
        if (sameHost) {
          ipMovedOld.add(sameHost.id);
          evts.push({ at: s.at, type: "ip_change", ip: p.id, hostname: p.hostname, reporter: s.reporter });
        } else {
          evts.push({ at: s.at, type: "join", ip: p.id, hostname: p.hostname, reporter: s.reporter });
        }
      }
      for (const p of old) {
        if (!curMap.has(p.id) && !ipMovedOld.has(p.id)) {
          evts.push({ at: s.at, type: "leave", ip: p.id, hostname: p.hostname, reporter: s.reporter });
        }
      }
      for (let i = 0; i < evts.length; i += 64) {
        await Promise.all(evts.slice(i, i + 64).map((e) => this.ctx.storage.put(`e:${e.at}:${e.ip}`, e)));
      }
      changed = evts.length > 0;
      // 流量速率：相对上一条快照的增量 / 时间差
      const dt = (s.at - prev.at) / 1000;
      if (dt > 0) {
        for (const p of cur) {
          const o = oldMap.get(p.id);
          if (o && o.rx != null && p.rx != null && o.tx != null && p.tx != null) {
            p.rx_rate = Math.max(0, p.rx - o.rx) / dt;
            p.tx_rate = Math.max(0, p.tx - o.tx) / dt;
          }
        }
      }
    }

    // 历史采样：距上次存入 ≥60 秒，或 peer 集合有变化时存一条紧凑快照
    const meta = (await this.ctx.storage.get<Meta>(`m:${s.reporter}`)) ?? { lastHistAt: 0 };
    if (s.at - meta.lastHistAt >= HISTORY_SAMPLE_MS || changed) {
      await this.ctx.storage.put(`h:${s.reporter}:${padTs(s.at)}`, { at: s.at, peers: cur } satisfies HistEntry);
      await this.ctx.storage.put(`m:${s.reporter}`, { lastHistAt: s.at } satisfies Meta);
    }

    // 没排过清扫就排一个：停报的节点不会再触发读路径，只有定时器能回收它的 h:/e:。
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  // 定时全量清扫：过期快照（24h 未上报）、历史与事件（保留 30 天）。
  // 之前只在 snapshot/history/events 读路径顺手删，且 list 只扫前 1000 条，
  // 长期告警/停报节点会把 DO 存储慢慢堆满。
  async alarm(): Promise<void> {
    await this.sweep();
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const cutoff = now - HISTORY_RETENTION_MS;
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const rows = await this.ctx.storage.list({ limit: 500, ...(cursor ? { startAfter: cursor } : {}) });
      if (rows.size === 0) break;
      const drop: string[] = [];
      for (const [k, v] of rows) {
        cursor = k;
        if (k.startsWith("r:")) {
          const at = Number((v as Snap | undefined)?.at ?? 0);
          if (!at || now - at > STALE_PURGE_MS) drop.push(k);
        } else if (k.startsWith("h:") || k.startsWith("e:")) {
          const ts = k.startsWith("e:")
            ? Number(k.slice(2).split(":")[0])
            : Number(k.slice(k.lastIndexOf(":") + 1));
          if (Number.isFinite(ts) && ts > 0 && ts < cutoff) drop.push(k);
        }
      }
      for (let i = 0; i < drop.length; i += 128) {
        await Promise.all(drop.slice(i, i + 128).map((k) => this.ctx.storage.delete(k)));
      }
      if (rows.size < 500) break;
    }
  }

  async snapshot(): Promise<Snap[]> {
    const now = Date.now();
    const all = await this.ctx.storage.list<Snap>({ prefix: "r:" });
    const out: Snap[] = [];
    for (const [k, v] of all) {
      if (now - v.at > STALE_PURGE_MS) await this.ctx.storage.delete(k);
      // 输出时再过滤一次：即使是修复前存入的旧快照，也不再外泄敏感字段
      else out.push(sanitizeSnap(v));
    }
    return out;
  }

  async history(reporter: string, limit: number): Promise<HistEntry[]> {
    const map = await this.ctx.storage.list<HistEntry>({
      prefix: `h:${reporter}:`, reverse: true, limit,
    });
    await this.purgeOld(`h:${reporter}:`);
    return [...map.values()].reverse(); // 调用方按时间正序画曲线
  }

  async events(limit: number): Promise<Evt[]> {
    const map = await this.ctx.storage.list<Evt>({ prefix: "e:", reverse: true, limit });
    await this.purgeOld("e:");
    return [...map.values()]; // 已是倒序
  }

  // 按时间升序删掉超过保留期的 h:/e: 条目；每次最多扫 10 页，读接口触发、渐进收敛
  private async purgeOld(prefix: string): Promise<void> {
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    let startAfter: string | undefined;
    for (let page = 0; page < 10; page++) {
      const map = await this.ctx.storage.list({
        prefix, limit: 500, ...(startAfter ? { startAfter } : {}),
      });
      if (map.size === 0) break;
      let stop = false;
      let last = "";
      for (const k of map.keys()) {
        last = k;
        const ts = prefix === "e:"
          ? Number(k.slice(2).split(":")[0])
          : Number(k.slice(k.lastIndexOf(":") + 1));
        if (ts < cutoff) await this.ctx.storage.delete(k);
        else { stop = true; break; }
      }
      if (stop || map.size < 500) break;
      startAfter = last;
    }
  }
}

// ---------- 工具函数 ----------
const enc = new TextEncoder();

// 限速计数放 Cache API：Workers 的内存态只在单个 isolate 里有效（实测同一 IP 连续
// 失败 6 次仍全部 401），而 Cache 是按 colo 共享的，能真正跨 isolate 生效。
const RATE_ORIGIN = "https://et-hub-rate.internal/";
async function rateRead(key: string): Promise<number> {
  const hit = await caches.default.match(new URL(RATE_ORIGIN + key));
  if (!hit) return 0;
  const n = Number(await hit.text());
  return Number.isFinite(n) ? n : 0;
}
async function rateBump(key: string, ttlSec: number): Promise<number> {
  const next = (await rateRead(key)) + 1;
  await caches.default.put(
    new URL(RATE_ORIGIN + key),
    new Response(String(next), { headers: { "cache-control": `max-age=${ttlSec}` } }),
  );
  return next;
}
async function rateClear(key: string): Promise<void> {
  await caches.default.delete(new URL(RATE_ORIGIN + key));
}
const loginKey = (ip: string) => `login:${ip}`;
const relayKey = (ip: string) => `relay:${ip}:${Math.floor(Date.now() / 60_000)}`;

// NODE_TOKENS → Map<token, node>，顺便把非法条目挡掉（node 名必须符合 reporter 正则）
function parseNodeTokens(raw?: string): Map<string, string> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const map = new Map<string, string>();
    for (const [node, tok] of Object.entries(obj)) {
      if (!/^[\w.-]{1,64}$/.test(node)) continue;
      if (typeof tok !== "string" || tok.length < 16) continue;
      map.set(tok, node);
    }
    return map.size ? map : null;
  } catch {
    return null;
  }
}
function safeEq(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}
const json = (b: unknown, status = 200) =>
  Response.json(b, { status, headers: { "cache-control": "no-store" } });
const clampLimit = (v: string | null, def: number, max: number) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), max) : def;
};

let relayCache: { at: number; value: Record<string, unknown> } | null = null;
async function relayHealth(req: Request, env: E, ctx: ExecutionContext) {
  if (relayCache && Date.now() - relayCache.at < 60_000) return relayCache.value;
  let value: Record<string, unknown>;
  try {
    const r = await easytier.fetch(new Request(new URL("/health", req.url)), env, ctx);
    value = (await r.json()) as Record<string, unknown>;
  } catch (e) {
    // 细节只留在日志侧：对外只报"不可用"，不把内部异常文本交给匿名请求
    console.error("relay health failed", String(e));
    value = { ok: false, state: "unavailable" };
  }
  relayCache = { at: Date.now(), value };
  return value;
}

// ---------- 看板鉴权：会话 Cookie 为主，Basic 兼容 API 客户端 ----------
// 原生浏览器 Basic 弹窗太丑且无法做“退出登录”，改成自定义登录页：
// 登录成功后 Worker 发一个 HMAC 签名的会话 Cookie（密钥就是 DASH_PASS，
// Cookie 里只含过期时间 + 签名，不含用户名密码本身）。未登录时：
//  - 浏览器访问页面 -> 302 跳 /login，不再发 www-authenticate（不弹原生框）
//  - /api/* 请求 -> 401 JSON，不弹原生框，前端据此跳 /login
//  - 直接带 Basic 头的 API 客户端（如 curl -u）仍可用，不破坏旧用法。
const SESSION_COOKIE = "et_hub_session";
const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
// 会话密钥不直接用 DASH_PASS：先做一次带标签的 SHA-256 派生，
// 这样即使 cookie 泄漏也不能拿签名去离线爆破口令。
// 载荷里还签入用户名，改用户名后旧 cookie 自动失效。
async function sessionSig(env: E, exp: number, user: string): Promise<string> {
  const seed = await crypto.subtle.digest(
    "SHA-256", enc.encode(`easytier-hub-session-v1:${env.DASH_PASS ?? ""}`),
  );
  const key = await crypto.subtle.importKey(
    "raw", seed, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${user}:${exp}`));
  return b64url(new Uint8Array(sig));
}
async function sessionOk(req: Request, env: E): Promise<boolean> {
  if (!env.DASH_PASS || !env.DASH_USER) return false;
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!m) return false;
  const [expStr, sig] = decodeURIComponent(m[1]).split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now() || !sig) return false;
  return safeEq(sig, await sessionSig(env, exp, env.DASH_USER));
}
async function dashAuthOk(req: Request, env: E): Promise<boolean> {
  // fail-closed：缺配置一律不放行（旧实现是 return true，等于 secret 没设就全公开）
  if (!env.DASH_USER || !env.DASH_PASS) return false;
  const h = req.headers.get("authorization") ?? "";
  if (h.startsWith("Basic ")) {
    try {
      if (safeEq(atob(h.slice(6)), `${env.DASH_USER}:${env.DASH_PASS}`)) return true;
    } catch { /* fall through to session check */ }
  }
  return sessionOk(req, env);
}
function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------- 路由 ----------
export default {
  async fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // 缺 secret 时优先 503：宁可整站不可用，也不能回落到"匿名可读"。
    // relay 只依赖 EASYTIER_NETWORK_SECRET，单独放行。
    if (!p.startsWith(RELAY)) {
      const missing = !env.DASH_USER || !env.DASH_PASS
        ? "DASH_USER/DASH_PASS"
        : (!env.REPORT_TOKEN ? "REPORT_TOKEN" : "");
      if (missing) return json({ ok: false, error: `hub not configured: ${missing}` }, 503);
    }

    // 1) relay：WS 原样转发（官方 DO 不校验路径）；普通 GET 返回健康状态
    if (p === RELAY || p.startsWith(RELAY + "/")) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        // 浏览器发起的 WebSocket 一定带 Origin；EasyTier 原生客户端不发。
        // 带 Origin 一律拒绝，避免任意网页把这里当中继通道白嫖（drive-by）。
        if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
        const relayIp = req.headers.get("cf-connecting-ip") ?? "unknown";
        if ((await rateBump(relayKey(relayIp), 90)) > RELAY_MAX_PER_MIN) {
          return new Response("too many connections", { status: 429 });
        }
        return easytier.fetch(req, env, ctx);
      }
      return json(await relayHealth(req, env, ctx));
    }

    // 2) agent 上报
    if (p === "/api/report") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const auth = req.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const nodeTokens = parseNodeTokens(env.NODE_TOKENS);
      let boundReporter = "";
      if (nodeTokens) {
        // 每个节点一个 token：token 决定 reporter，body.reporter 被忽略，
        // 这样任何一个节点都无法覆盖别人的快照/历史（旧实现共用一个 token，可互相冒名）。
        for (const [tok, node] of nodeTokens) {
          if (safeEq(bearer, tok)) {
            boundReporter = node;
            break;
          }
        }
        if (!boundReporter) return new Response("unauthorized", { status: 401 });
        if (!boundReporter) {
          // 过渡期：NODE_TOKENS 已配好但节点还没换完时，允许共享 token 继续上报
          // （reporter 仍由 body 决定）。全部换完后把 NODE_TOKENS_STRICT 置 1 收口。
          const legacyOk = env.NODE_TOKENS_STRICT !== "1"
            && !!env.REPORT_TOKEN && safeEq(bearer, env.REPORT_TOKEN);
          if (!legacyOk) return new Response("unauthorized", { status: 401 });
        }
      } else if (!env.REPORT_TOKEN || !safeEq(bearer, env.REPORT_TOKEN)) {
        return new Response("unauthorized", { status: 401 });
      }
      const parsed = await readJsonCapped(req, MAX_BODY);
      if (parsed.error) {
        return new Response(parsed.error === "too-large" ? "too large" : "bad json", {
          status: parsed.error === "too-large" ? 413 : 400,
        });
      }
      const body = parsed.value as {
        reporter?: string; peers?: unknown; node?: unknown;
        geo?: { lat?: number; lon?: number; city?: string; country?: string };
      };
      const reporter = boundReporter || String(body.reporter ?? "");
      if (!/^[\w.-]{1,64}$/.test(reporter)) return new Response("bad reporter", { status: 400 });

      // 上报节点的 WAN：优先取节点自身 STUN 结果里的公网 IPv4，
      // 其次取 Cloudflare 看到的来源 IP；坐标取 Cloudflare 对该来源 IP 的
      // 地理位置（真实请求属性，不是猜的）。peer 表本身不带这些字段，
      // 所以只写进上报节点自己的那一行，其他节点仍为空，不编造。
      const nodeObj = (body.node ?? {}) as Record<string, unknown>;
      const stun = (nodeObj.stun_info ?? {}) as Record<string, unknown>;
      const pubList = Array.isArray(stun.public_ip) ? stun.public_ip.map(String) : [];
      let wan = pubList.find(isPublicIpv4) ?? "";
      if (!wan) {
        const cfIp = req.headers.get("cf-connecting-ip") ?? "";
        if (isPublicIpv4(cfIp)) wan = cfIp;
      }
      // IPv6：STUN 列表里的第一个全球单播地址（不含 ::1、fe80、fc00/fd00）
      const wan6 = pubList.find((ip) => ip.includes(":")
        && !ip.startsWith("::1") && !ip.toLowerCase().startsWith("fe80")
        && !ip.toLowerCase().startsWith("fc") && !ip.toLowerCase().startsWith("fd")) ?? "";
      // 坐标优先级：
      //   1) 上报自带的 geo（agent 在 env 里显式配置）
      //      —— 适用「上报出网被代理/NAT 污染」的节点：Cloudflare 看到的是代理出口，
      //         按请求来源做地理会得到错误城市（例如主路由 qwrt 被判成洛杉矶）。
      //   2) Cloudflare 对请求来源 IP 的地理（真实请求属性）
      const cf = (req as unknown as { cf?: { latitude?: string; longitude?: string; city?: string; country?: string } }).cf;
      const bodyGeo = (body.geo && typeof body.geo === "object" ? body.geo : {}) as Record<string, unknown>;
      const bLat = Number(bodyGeo.lat);
      const bLon = Number(bodyGeo.lon);
      const hasBodyGeo = Number.isFinite(bLat) && Number.isFinite(bLon)
        && Math.abs(bLat) <= 90 && Math.abs(bLon) <= 180 && (bLat !== 0 || bLon !== 0);
      const geoLat = hasBodyGeo ? bLat : (cf?.latitude ? Number(cf.latitude) : NaN);
      const geoLon = hasBodyGeo ? bLon : (cf?.longitude ? Number(cf.longitude) : NaN);
      const hasGeo = Number.isFinite(geoLat) && Number.isFinite(geoLon) && (geoLat !== 0 || geoLon !== 0);
      const geoCity = hasBodyGeo ? String(bodyGeo.city ?? "") : (typeof cf?.city === "string" ? cf.city : "");
      const geoCountry = hasBodyGeo ? String(bodyGeo.country ?? "") : (typeof cf?.country === "string" ? cf.country : "");
      // peer 表：先卡数量（防 DoS），再逐条走白名单（防未知字段入库 / 体积失控）
      const rawPeers = Array.isArray(body.peers) ? body.peers : null;
      if (rawPeers && rawPeers.length > MAX_PEERS) {
        return new Response("too many peers", { status: 413 });
      }
      let peers: Record<string, unknown>[] | null = null;
      if (rawPeers) {
        const localIp = String(nodeObj.ipv4_addr ?? "").split("/")[0];
        const localHost = String(nodeObj.hostname ?? "");
        const out: Record<string, unknown>[] = [];
        for (const p of rawPeers) {
          const o = keepPeerFields(p);
          if (!o) continue;
          const isLocal = String(o.cost ?? "") === "Local"
            || (localIp !== "" && String(o.ipv4 ?? "") === localIp)
            || (localHost !== "" && String(o.hostname ?? "") === localHost);
          if (isLocal) {
            if (wan) { o.wan_ip = wan; o.wan_ipv4 = wan; }
            if (wan6) o.wan_ipv6 = wan6;
            if (hasGeo) { o.lat = geoLat; o.lon = geoLon; }
            if (geoCity) o.city = geoCity;
            if (geoCountry) o.country = geoCountry;
          }
          out.push(o);
        }
        peers = out;
      }

      const relay = await relayHealth(req, env, ctx);
      await env.STATUS.getByName("main").report({
        reporter, at: Date.now(), relay,
        data: { peers, node: sanitizeNode(body.node) },
      });
      return new Response(null, { status: 204 });
    }

    // 2.5) 登录 / 退出 / 登录页（公开，不走看板鉴权）
    if (p === "/login") {
      if (await dashAuthOk(req, env)) {
        return Response.redirect(new URL("/", req.url), 302);
      }
      return html(LOGIN_HTML);
    }
    if (p === "/login.html") {
      return Response.redirect(new URL("/login", req.url), 302);
    }
    if (p === "/api/login") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const loginIp = req.headers.get("cf-connecting-ip") ?? "unknown";
      if ((await rateRead(loginKey(loginIp))) >= LOGIN_MAX_FAILS) {
        return json({ ok: false, error: "尝试次数过多，请稍后再试" }, 429);
      }
      let username = "", password = "", remember = false, isForm = false;
      const ct = req.headers.get("content-type") ?? "";
      // 登录在鉴权门之前，必须自己限体（旧实现用 req.json()/formData，实际无上限）
      const rawLogin = await readCapped(req, MAX_LOGIN_BODY);
      if (!rawLogin) return json({ ok: false, error: "too large" }, 413);
      try {
        const text = new TextDecoder().decode(rawLogin);
        if (ct.includes("application/json")) {
          const b = JSON.parse(text) as { username?: unknown; password?: unknown; remember?: unknown };
          username = String(b.username ?? "");
          password = String(b.password ?? "");
          remember = b.remember === true || b.remember === "true" || b.remember === "on";
        } else {
          const f = new URLSearchParams(text);
          username = f.get("username") ?? "";
          password = f.get("password") ?? "";
          remember = f.get("remember") === "on" || f.get("remember") === "true";
          isForm = true;
        }
      } catch { return json({ ok: false, error: "bad request" }, 400); }
      if (!env.DASH_USER || !env.DASH_PASS) {
        return isForm ? Response.redirect(new URL("/", req.url), 302) : json({ ok: true });
      }
      if (!safeEq(username, env.DASH_USER) || !safeEq(password, env.DASH_PASS)) {
        await rateBump(loginKey(loginIp), LOGIN_LOCK_MS / 1000);
        return json({ ok: false, error: "用户名或密码错误" }, 401);
      }
      await rateClear(loginKey(loginIp));
      const maxAge = remember ? 7 * 24 * 3600 : 24 * 3600;
      const exp = Math.floor(Date.now() / 1000) + maxAge;
      const cookie = `${SESSION_COOKIE}=${exp}.${await sessionSig(env, exp, env.DASH_USER)}; Path=/; HttpOnly; Secure; SameSite=Lax${remember ? `; Max-Age=${maxAge}` : ""}`;
      if (isForm) {
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cookie },
      });
    }
    if (p === "/api/logout") {
      // 只接受 POST：GET 形式的登出能被任意跨站 <img>/链接触发（登出 CSRF）
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": clearSessionCookie() },
      });
    }

    // 3) 看板 + 数据接口（会话 Cookie 或 Basic，失败不再弹原生框）
    if (!(await dashAuthOk(req, env))) {
      if (p.startsWith("/api/")) {
        return json({ ok: false, error: "auth required" }, 401);
      }
      return Response.redirect(new URL("/login", req.url), 302);
    }
    if (p === "/api/peers") {
      const reporters = await env.STATUS.getByName("main").snapshot();
      return json({ now: Date.now(), reporters });
    }
    if (p === "/api/history") {
      const reporter = url.searchParams.get("reporter") ?? "";
      if (!/^[\w.-]{1,64}$/.test(reporter)) return new Response("bad reporter", { status: 400 });
      const entries = await env.STATUS.getByName("main").history(
        reporter, clampLimit(url.searchParams.get("limit"), 500, 2000),
      );
      return json({ now: Date.now(), reporter, entries });
    }
    if (p === "/api/events") {
      const events = await env.STATUS.getByName("main").events(
        clampLimit(url.searchParams.get("limit"), 200, 1000),
      );
      return json({ now: Date.now(), events });
    }
    if (p === "/") return html(DASHBOARD_HTML);
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<E>;
