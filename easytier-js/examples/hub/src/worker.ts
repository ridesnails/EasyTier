import { createEasyTierCloudflare } from "@easytier/cloudflare";
import { DurableObject } from "cloudflare:workers";

// Env 由 `wrangler types` 生成；可选的 Basic Auth 变量在这里补充声明
type E = Env & { DASH_USER?: string; DASH_PASS?: string };

const RELAY = "/relay";
const STALE_PURGE_MS = 24 * 3600 * 1000;
const MAX_BODY = 512 * 1024;

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
      rx: num(o.rx_bytes),
      tx: num(o.tx_bytes),
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
      for (const e of evts) await this.ctx.storage.put(`e:${e.at}:${e.ip}`, e);
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
  }

  async snapshot(): Promise<Snap[]> {
    const now = Date.now();
    const all = await this.ctx.storage.list<Snap>({ prefix: "r:" });
    const out: Snap[] = [];
    for (const [k, v] of all) {
      if (now - v.at > STALE_PURGE_MS) await this.ctx.storage.delete(k);
      else out.push(v);
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

async function relayHealth(req: Request, env: E, ctx: ExecutionContext) {
  try {
    const r = await easytier.fetch(new Request(new URL("/health", req.url)), env, ctx);
    return await r.json();
  } catch (e) {
    return { ok: false, state: "error", error: String(e) };
  }
}

function dashAuthOk(req: Request, env: E): boolean {
  if (!env.DASH_USER || !env.DASH_PASS) return true;
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Basic ")) return false;
  try {
    return safeEq(atob(h.slice(6)), `${env.DASH_USER}:${env.DASH_PASS}`);
  } catch { return false; }
}

// ---------- 路由 ----------
export default {
  async fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // 1) relay：WS 原样转发（官方 DO 不校验路径）；普通 GET 返回健康状态
    if (p === RELAY || p.startsWith(RELAY + "/")) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return easytier.fetch(req, env, ctx);
      }
      return json(await relayHealth(req, env, ctx));
    }

    // 2) agent 上报
    if (p === "/api/report") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const auth = req.headers.get("authorization") ?? "";
      if (!safeEq(auth, `Bearer ${env.REPORT_TOKEN}`)) return new Response("unauthorized", { status: 401 });
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > MAX_BODY) return new Response("too large", { status: 413 });

      let body: { reporter?: string; peers?: unknown; node?: unknown };
      try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      const reporter = String(body.reporter ?? "");
      if (!/^[\w.-]{1,64}$/.test(reporter)) return new Response("bad reporter", { status: 400 });

      const relay = await relayHealth(req, env, ctx);
      await env.STATUS.getByName("main").report({
        reporter, at: Date.now(), relay,
        data: { peers: body.peers ?? null, node: body.node ?? null },
      });
      return new Response(null, { status: 204 });
    }

    // 3) 看板 + 数据接口（可选 Basic Auth）
    if (!dashAuthOk(req, env)) {
      return new Response("auth required", {
        status: 401, headers: { "www-authenticate": 'Basic realm="easytier-hub"' },
      });
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
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<E>;
