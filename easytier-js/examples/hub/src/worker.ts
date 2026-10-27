import { createEasyTierCloudflare } from "@easytier/cloudflare";
import { DurableObject } from "cloudflare:workers";

// Env 由 `wrangler types` 生成；可选的 Basic Auth 变量在这里补充声明
type E = Env & { DASH_USER?: string; DASH_PASS?: string };

const RELAY = "/relay";
const STALE_PURGE_MS = 24 * 3600 * 1000;
const MAX_BODY = 512 * 1024;

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

export class StatusObject extends DurableObject<E> {
  async report(s: Snap): Promise<void> {
    await this.ctx.storage.put(`r:${s.reporter}`, s);
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
}

// ---------- 工具函数 ----------
const enc = new TextEncoder();
function safeEq(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}
const json = (b: unknown, status = 200) =>
  Response.json(b, { status, headers: { "cache-control": "no-store" } });

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
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<E>;
