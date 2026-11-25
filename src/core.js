// Runs the Wylth Sales Panel (the same code that ran on Cloudflare Workers) on Azure Functions.
// - store: a Cloudflare-KV-compatible store on Azure Blob Storage (get, getWithMetadata, put with expiry, delete)
// - handle: turns an Azure HTTP request into a web Request for the panel and back, with gzip
// - sync: the 5-minute lead snapshot sync, plus an optional mirror of the old Cloudflare data during the move
import zlib from "node:zlib";
import worker from "./worker.js";
import { msLogin, msCallback } from "./ms-auth.js";

export function blobStore(container) {
  const name = k => encodeURIComponent(k);
  const ready = container.createIfNotExists().catch(() => null);
  async function read(key) {
    await ready;
    const b = container.getBlockBlobClient(name(key));
    try {
      const props = await b.getProperties(), md = props.metadata || {};
      if (md.exp && Number(md.exp) < Date.now()) { await b.deleteIfExists().catch(() => null); return null; }
      const buf = await b.downloadToBuffer();
      return { buf, meta: md.meta ? JSON.parse(Buffer.from(md.meta, "base64").toString("utf8")) : null };
    } catch (e) { if (e && (e.statusCode === 404 || e.code === "BlobNotFound")) return null; throw e; }
  }
  const as = (buf, type) => type === "json" ? JSON.parse(buf.toString("utf8")) : type === "arrayBuffer" ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf.toString("utf8");
  return {
    async get(key, type) { const r = await read(key); return r ? as(r.buf, type) : null; },
    async getWithMetadata(key, type) { const r = await read(key); return r ? { value: as(r.buf, type), metadata: r.meta } : { value: null, metadata: null }; },
    async put(key, value, opts = {}) {
      await ready;
      const body = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      const metadata = {};
      if (opts.expirationTtl) metadata.exp = String(Date.now() + opts.expirationTtl * 1000);
      if (opts.expiration) metadata.exp = String(opts.expiration * 1000);
      if (opts.metadata) metadata.meta = Buffer.from(JSON.stringify(opts.metadata)).toString("base64");
      await container.getBlockBlobClient(name(key)).uploadData(body, { metadata });
    },
    async delete(key) { await ready; await container.getBlockBlobClient(name(key)).deleteIfExists(); },
    async keys() { await ready; const out = []; for await (const b of container.listBlobsFlat()) out.push(decodeURIComponent(b.name)); return out; }
  };
}

export function makeEnv(store) {
  return Object.assign({}, process.env, { PANEL_KV: store, SNAP_STEP: process.env.SNAP_STEP || "100" });
}

const ZIP = /json|text|javascript|svg/;
export async function handle(env, method, url, headers, bodyBuf) {
  const u = new URL(url);
  if (u.pathname === "/__mirror") return mirrorRoute(env);
  if (u.pathname === "/auth/ms/login" && method === "GET") return msLogin(env, u);
  if (u.pathname === "/auth/ms/callback" && method === "GET") return msCallback(env, u, headers);
  if (u.pathname === "/__health") { // counts and times only, no panel data
    const m = await env.PANEL_KV.get("snap:v1", "json").catch(() => null), b = await env.PANEL_KV.get("snapb:v1", "text").catch(() => null);
    let prog = null; if (b) { try { const x = JSON.parse(b); prog = { rows: (x.rows || []).length, pipeline: (x.pi || 0) + "/" + ((x.pls || []).length) }; } catch { prog = "unreadable"; } }
    const dg = await env.PANEL_KV.get("snapdiag", "json").catch(() => null);
    const o = { ok: true, now: new Date().toISOString(), snapshot: m ? { leads: m.n, syncedAt: new Date(m.at).toISOString(), fullBuild: m.full } : null, building: !!b, progress: prog, lastSync: dg ? Object.assign({}, dg, { at: new Date(dg.at).toISOString() }) : null, mirroring: !!env.MIGRATE_FROM, lastMirror: lastMirror ? new Date(lastMirror).toISOString() : null };
    return { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: Buffer.from(JSON.stringify(o)) };
  }
  const init = { method, headers };
  if (!["GET", "HEAD"].includes(method) && bodyBuf && bodyBuf.length) init.body = bodyBuf;
  const r = await worker.fetch(new Request(url, init), env, { waitUntil() {}, passThroughOnException() {} });
  let body = Buffer.from(await r.arrayBuffer());
  const out = {}; r.headers.forEach((v, k) => { out[k] = v; });
  const ae = (headers.get ? headers.get("accept-encoding") : headers["accept-encoding"]) || "";
  if (body.length > 1024 && /gzip/.test(ae) && ZIP.test(out["content-type"] || "") && !out["content-encoding"]) {
    body = zlib.gzipSync(body); out["content-encoding"] = "gzip"; out["vary"] = "Accept-Encoding";
  }
  return { status: r.status, headers: out, body };
}

// ---- moving from Cloudflare: copy the old store across until the GHL links are switched (setting MIGRATE_FROM) ----
async function exportSig(env, ts) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GHL_SSO_KEY || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const b = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("export|" + ts)));
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
let lastMirror = 0;
export async function mirror(env) {
  const from = (env.MIGRATE_FROM || "").replace(/\/+$/, ""); if (!from) return { skipped: true };
  const ts = Date.now(), r = await fetch(from + "/__export?ts=" + ts + "&sig=" + encodeURIComponent(await exportSig(env, ts)));
  if (!r.ok) throw new Error("export failed: " + r.status + " " + (await r.text()).slice(0, 200));
  const d = await r.json(), st = env.PANEL_KV, names = Object.keys(d.keys);
  for (const k of names) {
    const e = d.keys[k], opts = e.exp ? { expiration: e.exp } : {};
    if (e.b64 != null) await st.put(k, Buffer.from(e.b64, "base64"), Object.assign(opts, e.meta ? { metadata: e.meta } : {}));
    else await st.put(k, e.text, opts);
  }
  let removed = 0; const have = new Set(names);
  for (const k of await st.keys()) if (!k.startsWith("snap") && !have.has(k)) { await st.delete(k); removed++; }
  lastMirror = Date.now();
  return { copied: names.length, removed, at: new Date(d.at).toISOString() };
}
async function mirrorRoute(env) {
  const j = o => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(o)) });
  if (!env.MIGRATE_FROM) return j({ skipped: "not moving" });
  if (Date.now() - lastMirror < 20000) return j({ skipped: "just ran", at: new Date(lastMirror).toISOString() });
  try { return j(await mirror(env)); } catch (e) { return { status: 502, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: e.message })) }; }
}

export async function sync(env, log) {
  if (env.MIGRATE_FROM) { try { log("mirror", await mirror(env)); } catch (e) { log("mirror failed", e.message); } }
  const t0 = Date.now(); let mErr = null;
  if (env.MIGRATE_FROM) { /* mirror result already logged above */ }
  try { log("snapshot", await worker.scheduled({ cron: "*/5 * * * *" }, env, { waitUntil() {} })); } catch (e) { mErr = String(e && e.message || e).slice(0, 300); }
  const dg = await env.PANEL_KV.get("snapdiag", "json").catch(() => null);
  if (mErr) await env.PANEL_KV.put("snapdiag", JSON.stringify({ at: Date.now(), ok: false, err: mErr, ms: Date.now() - t0 }));
  else if (!dg || dg.at < t0) await env.PANEL_KV.put("snapdiag", JSON.stringify({ at: Date.now(), ok: true, ms: Date.now() - t0 }));
}
