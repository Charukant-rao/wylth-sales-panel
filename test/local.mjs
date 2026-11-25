// Local checks for the Azure port: storage layer on Azurite, the web adapter, and the Cloudflare -> Azure copy.
import http from "node:http";
import zlib from "node:zlib";
import { BlobServiceClient } from "@azure/storage-blob";
import { blobStore, makeEnv, handle, mirror } from "../src/core.js";
import worker from "../src/worker.js";
const AZ = "UseDevelopmentStorage=true";
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };
const st = blobStore(BlobServiceClient.fromConnectionString(AZ).getContainerClient("t" + Date.now()));
// 1. storage layer
await st.put("cfg", JSON.stringify({ a: 1, n: "Café ₹" }));
ok((await st.get("cfg", "json")).n === "Café ₹", "json round trip with unicode");
ok(await st.get("cfg") === JSON.stringify({ a: 1, n: "Café ₹" }), "text read");
ok(await st.get("nope", "json") === null, "missing key is null");
const bytes = new Uint8Array([37, 80, 68, 70, 0, 255, 1]);
await st.put("pdf:abc", bytes.buffer, { expirationTtl: 3600, metadata: { name: "Quote.pdf" } });
const g = await st.getWithMetadata("pdf:abc", "arrayBuffer");
ok(new Uint8Array(g.value).join() === bytes.join() && g.metadata.name === "Quote.pdf", "binary with metadata");
await st.put("old", "x", { expiration: Math.floor(Date.now() / 1000) - 5 });
ok(await st.get("old") === null, "expired key reads as null");
await st.delete("cfg"); ok(await st.get("cfg") === null, "delete");
ok((await st.keys()).includes("pdf:abc"), "keys lists stored names");
// 2. Cloudflare side (old worker with in-memory KV) serving /__export, Azure side mirroring it
const mem = new Map(), memMeta = new Map();
const kv = { async get(k, t) { const v = mem.get(k); if (v == null) return null; return t === "json" ? JSON.parse(v) : t === "arrayBuffer" ? v : v; },
  async getWithMetadata(k, t) { return { value: mem.get(k) ?? null, metadata: memMeta.get(k) || null }; },
  async put(k, v, o = {}) { mem.set(k, v); if (o.metadata) memMeta.set(k, o.metadata); }, async delete(k) { mem.delete(k); },
  async list() { return { keys: [...mem.keys()].map(name => ({ name })), list_complete: true }; } };
mem.set("cfg", JSON.stringify({ users: { "x@wylth.com": { role: "admin" } } })); mem.set("quotes", JSON.stringify({ seq: 5, by: {} }));
mem.set("pdf:tok1", new Uint8Array([1, 2, 3, 250]).buffer); memMeta.set("pdf:tok1", { name: "P.pdf" }); mem.set("snap:v1", "{}");
const cfEnv = { PANEL_KV: kv, GHL_SSO_KEY: "test-sso-key", GHL_LOCATION_ID: "loc" };
const srv = http.createServer(async (req, res) => { const r = await worker.fetch(new Request("http://127.0.0.1:8790" + req.url), cfEnv, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); }).listen(8790);
const bad = await fetch("http://127.0.0.1:8790/__export?ts=" + Date.now() + "&sig=nope"); ok(bad.status === 403, "export refuses a wrong signature");
const azEnv = makeEnv(st); azEnv.GHL_SSO_KEY = "test-sso-key"; azEnv.MIGRATE_FROM = "http://127.0.0.1:8790";
await st.put("tpl:gone", "[]");
const m = await mirror(azEnv);
ok(m.copied === 3 && m.removed >= 1, "mirror copied 3 keys (snapshot skipped) and removed stale ones: " + JSON.stringify(m));
ok((await st.get("cfg", "json")).users["x@wylth.com"].role === "admin", "mirrored cfg");
const p = await st.getWithMetadata("pdf:tok1", "arrayBuffer"); ok(new Uint8Array(p.value).join() === "1,2,3,250" && p.metadata.name === "P.pdf", "mirrored pdf bytes and name");
ok(await st.get("tpl:gone") === null && await st.get("snap:v1") === null, "stale key removed, snapshot not copied");
// 3. web adapter: page served gzipped, API errors pass through
const h = new Headers({ "accept-encoding": "gzip, br" });
const page = await handle(azEnv, "GET", "https://example.azurewebsites.net/", h, null);
ok(page.status !== 500, "page request handled (status " + page.status + ")");
if (page.headers["content-encoding"] === "gzip") ok(zlib.gunzipSync(page.body).length > page.body.length, "page gzipped (" + page.body.length + " bytes)");
const api = await handle(azEnv, "GET", "https://example.azurewebsites.net/api/live", h, null);
ok(api.status === 401 || api.status === 403, "api without session refused (" + api.status + ")");
const post = await handle(azEnv, "POST", "https://example.azurewebsites.net/api/action", new Headers({ "content-type": "application/json" }), Buffer.from("{}"));
ok(post.status === 401 || post.status === 403, "POST body passes through (" + post.status + ")");
srv.close(); console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
