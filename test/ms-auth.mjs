// Checks "Sign in with Microsoft" end to end against a fake Microsoft token endpoint and a fake GHL users API.
import http from "node:http";
import { handle } from "../src/core.js";
import worker from "../src/worker.js";
import { resetUsersMemo } from "../src/ms-auth.js";

let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };
const TENANT = "tenant-1", CLIENT = "client-1";
let lastNonce = "", idOverride = {}, tokenBody = null;
const b64u = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const fake = http.createServer((req, res) => {
  let data = ""; req.on("data", c => data += c); req.on("end", () => {
    if (req.url.startsWith("/" + TENANT + "/oauth2/v2.0/token")) {
      tokenBody = new URLSearchParams(data);
      const id = Object.assign({ aud: CLIENT, tid: TENANT, nonce: lastNonce, exp: Math.floor(Date.now() / 1000) + 600, preferred_username: "Rm.One@Example.com", name: "RM One" }, idOverride);
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ id_token: b64u({ alg: "RS256" }) + "." + b64u(id) + ".sig" }));
    }
    if (req.url.startsWith("/users/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ users: [{ id: "ghl-rm1", email: "rm.one@example.com", name: "RM One" }, { id: "ghl-gone", email: "gone@example.com", deleted: true }] }));
    }
    res.writeHead(404); res.end();
  });
}).listen(8791);
const env = { GHL_SSO_KEY: "sso-test", GHL_LOCATION_ID: "loc", GHL_API_TOKEN: "t", MS_TENANT_ID: TENANT, MS_CLIENT_ID: CLIENT, MS_CLIENT_SECRET: "secret", MS_AUTHORITY: "http://127.0.0.1:8791", GHL_API_BASE: "http://127.0.0.1:8791", PANEL_KV: { async get() { return null; }, async put() {} } };
const H = (o = {}) => new Headers(o);

async function startLogin(app) {
  const r = await handle(env, "GET", "https://salespanel.example/auth/ms/login" + (app ? "?app=" + app : ""), H(), null);
  const loc = new URL(r.headers.location), cookie = r.headers["set-cookie"].split(";")[0];
  lastNonce = loc.searchParams.get("nonce");
  return { r, loc, cookie };
}
async function finish(cookie, state, extra = "") {
  return handle(env, "GET", "https://salespanel.example/auth/ms/callback?code=abc&state=" + state + extra, H({ cookie }), null);
}

// 1. Login redirects to Microsoft with PKCE and a short-lived, HttpOnly cookie
{
  const { r, loc } = await startLogin();
  ok(r.status === 302 && loc.origin + loc.pathname === "http://127.0.0.1:8791/" + TENANT + "/oauth2/v2.0/authorize", "login redirects to the tenant's Microsoft sign-in");
  ok(loc.searchParams.get("client_id") === CLIENT && loc.searchParams.get("code_challenge_method") === "S256" && loc.searchParams.get("redirect_uri") === "https://salespanel.wylth.com/auth/ms/callback", "uses PKCE and the panel's callback address");
  ok(/HttpOnly/.test(r.headers["set-cookie"]) && /Secure/.test(r.headers["set-cookie"]) && /Max-Age=600/.test(r.headers["set-cookie"]), "state cookie is HttpOnly, Secure, 10 minutes");
}
// 2. Matching GHL user gets a panel session the existing panel code accepts
{
  resetUsersMemo(); idOverride = {};
  const { loc, cookie } = await startLogin("engage");
  const r = await finish(cookie, loc.searchParams.get("state"));
  ok(tokenBody && tokenBody.get("code_verifier") && tokenBody.get("client_secret") === "secret", "code exchanged server-to-server with the PKCE verifier");
  ok(r.status === 302 && r.headers.location.startsWith("/engage#s="), "Engage sign-in returns to /engage with the session");
  const token = decodeURIComponent(r.headers.location.split("#s=")[1]);
  const claim = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  ok(claim.app === "engage" && claim.sub === "ghl-rm1" && claim.email === "rm.one@example.com", "session is for the matching GHL user");
  // The real panel code must accept it: a signed-in API call gets past sign-in (it then fails on the fake GHL, not with 401).
  const api = await worker.fetch(new Request("https://salespanel.example/api/live", { headers: { "X-Panel-Session": token } }), env, { waitUntil() {} });
  ok(api.status !== 401, "panel accepts the Microsoft-issued session (status " + api.status + ")");
  const forged = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
  const bad = await worker.fetch(new Request("https://salespanel.example/api/live", { headers: { "X-Panel-Session": forged } }), env, { waitUntil() {} });
  ok(bad.status === 401, "a tampered session is refused");
}
// 3. Refusals
{
  resetUsersMemo(); idOverride = { preferred_username: "stranger@example.com" };
  let { loc, cookie } = await startLogin();
  let r = await finish(cookie, loc.searchParams.get("state"));
  ok(r.headers.location.startsWith("/#ms_error=") && /does%20not%20match%20a%20GHL%20user/.test(r.headers.location), "Microsoft account with no GHL user is refused");
  idOverride = { preferred_username: "gone@example.com" };
  ({ loc, cookie } = await startLogin()); r = await finish(cookie, loc.searchParams.get("state"));
  ok(r.headers.location.startsWith("/#ms_error="), "deleted GHL user is refused");
  idOverride = { tid: "other-tenant" };
  ({ loc, cookie } = await startLogin()); r = await finish(cookie, loc.searchParams.get("state"));
  ok(r.headers.location.startsWith("/#ms_error="), "account from another Microsoft tenant is refused");
  idOverride = {};
  ({ loc, cookie } = await startLogin()); r = await finish(cookie, "wrong-state");
  ok(r.headers.location.startsWith("/#ms_error="), "wrong state is refused");
  r = await finish("pv_ms=forged.sig", loc.searchParams.get("state"));
  ok(r.headers.location.startsWith("/#ms_error="), "forged cookie is refused");
  ({ loc, cookie } = await startLogin()); lastNonce = "replayed";
  r = await finish(cookie, loc.searchParams.get("state"));
  ok(r.headers.location.startsWith("/#ms_error="), "wrong nonce is refused");
  const off = await handle(Object.assign({}, env, { MS_CLIENT_SECRET: "" }), "GET", "https://salespanel.example/auth/ms/login", H(), null);
  ok(off.status === 302 && off.headers.location.startsWith("/#ms_error=") && /not%20set%20up/.test(off.headers.location), "not configured: explains instead of failing");
}
fake.close(); console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
