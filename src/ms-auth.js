// "Sign in with Microsoft" for opening the panel directly at salespanel.wylth.com (outside GHL).
//
// Flow (OpenID Connect authorization code + PKCE, single tenant):
//   GET /auth/ms/login?app=sales|engage  -> redirect to Microsoft, short-lived signed cookie holds state/nonce/PKCE
//   GET /auth/ms/callback                -> code exchanged at Microsoft's token endpoint (server to server, with the
//                                           client secret), the Microsoft account must match an active GHL user by
//                                           email, then the browser gets the same 8-hour panel session as GHL sign-in
//                                           (handed over in the URL fragment, which the page stores and removes).
//
// Settings: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET (Azure app settings, never in the repo).
// Optional: PANEL_BASE_URL (default https://salespanel.wylth.com), MS_AUTHORITY and GHL_API_BASE (tests only).

const enc = new TextEncoder();
const b64u = buf => Buffer.from(buf).toString("base64url");
const COOKIE = "pv_ms";
const SESSION_SECONDS = 8 * 3600; // same as the GHL sign-in session

const hmacKey = (secret, usage) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
async function sign(secret, data) { return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(data)))); }
async function verify(secret, data, sig) {
  try { return await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), Buffer.from(sig, "base64url"), enc.encode(data)); } catch { return false; }
}

// The panel's own session format (see Et/Ot in worker.js): base64url(JSON).base64url(HMAC-SHA256).
export async function panelSession(env, { app, sub, email, name }) {
  const body = b64u(enc.encode(JSON.stringify({ app, sub, email: String(email).toLowerCase(), name: name || "", exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  return body + "." + await sign("wylth-panel-session:" + env.GHL_SSO_KEY, body);
}

const configured = env => !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && env.GHL_SSO_KEY);
const base = env => (env.PANEL_BASE_URL || "https://salespanel.wylth.com").replace(/\/+$/, "");
const authority = env => (env.MS_AUTHORITY || "https://login.microsoftonline.com").replace(/\/+$/, "") + "/" + env.MS_TENANT_ID;
const redirectUri = env => base(env) + "/auth/ms/callback";
const appPath = app => app === "engage" ? "/engage" : "/";
const cookieKey = env => "wylth-panel-ms-login:" + env.MS_CLIENT_SECRET;

function redirect(location, cookie) {
  const headers = { location, "cache-control": "no-store", "referrer-policy": "no-referrer" };
  if (cookie !== undefined) headers["set-cookie"] = cookie;
  return { status: 302, headers, body: Buffer.alloc(0) };
}
const clearCookie = COOKIE + "=; Path=/auth/ms; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
const fail = (app, msg) => redirect(appPath(app) + "#ms_error=" + encodeURIComponent(msg), clearCookie);

function readCookie(headers) {
  const raw = (headers.get ? headers.get("cookie") : headers.cookie) || "";
  for (const part of raw.split(";")) { const [k, ...v] = part.trim().split("="); if (k === COOKIE) return v.join("="); }
  return "";
}

let usersMemo = { at: 0, list: null };
async function ghlUsers(env) {
  if (usersMemo.list && Date.now() - usersMemo.at < 300000) return usersMemo.list;
  const u = new URL((env.GHL_API_BASE || "https://services.leadconnectorhq.com") + "/users/");
  u.searchParams.set("locationId", env.GHL_LOCATION_ID);
  const r = await fetch(u, { headers: { Authorization: "Bearer " + env.GHL_API_TOKEN, Version: "2021-07-28", Accept: "application/json" } });
  if (!r.ok) throw new Error("GHL users " + r.status);
  const list = ((await r.json()).users || []).filter(x => !x.deleted).map(x => ({ id: x.id, email: String(x.email || "").toLowerCase(), name: x.name || [x.firstName, x.lastName].filter(Boolean).join(" ") }));
  usersMemo = { at: Date.now(), list };
  return list;
}

export async function msLogin(env, url) {
  const app = url.searchParams.get("app") === "engage" ? "engage" : "sales";
  if (!configured(env)) return redirect(appPath(app) + "#ms_error=" + encodeURIComponent("Microsoft sign-in is not set up yet. Open the panel from the GHL left menu."));
  const rnd = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
  const st = { s: rnd(18), n: rnd(18), v: rnd(32), app, t: Date.now() };
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(st.v))));
  const body = b64u(enc.encode(JSON.stringify(st)));
  const cookie = COOKIE + "=" + body + "." + await sign(cookieKey(env), body) + "; Path=/auth/ms; Max-Age=600; HttpOnly; Secure; SameSite=Lax";
  const a = new URL(authority(env) + "/oauth2/v2.0/authorize");
  for (const [k, v] of Object.entries({ client_id: env.MS_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(env), response_mode: "query", scope: "openid profile email", state: st.s, nonce: st.n, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" })) a.searchParams.set(k, v);
  return redirect(a.toString(), cookie);
}

export async function msCallback(env, url, headers) {
  const [body, sig] = readCookie(headers).split(".");
  if (!configured(env)) return fail("sales", "Microsoft sign-in is not set up yet.");
  if (!body || !sig || !await verify(cookieKey(env), body, sig)) return fail("sales", "The Microsoft sign-in expired or was started in another browser. Please try again.");
  const st = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (Date.now() - st.t > 600000 || url.searchParams.get("state") !== st.s) return fail(st.app, "The Microsoft sign-in expired. Please try again.");
  if (url.searchParams.get("error")) return fail(st.app, "Microsoft sign-in was cancelled or refused: " + (url.searchParams.get("error_description") || url.searchParams.get("error")).slice(0, 160));
  const code = url.searchParams.get("code"); if (!code) return fail(st.app, "Microsoft did not return a sign-in code.");

  // Server-to-server code exchange over TLS with the client secret: the id_token comes straight from Microsoft.
  const tr = await fetch(authority(env) + "/oauth2/v2.0/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: redirectUri(env), code_verifier: st.v, scope: "openid profile email" })
  });
  const tj = await tr.json().catch(() => ({}));
  if (!tr.ok || !tj.id_token) return fail(st.app, "Microsoft sign-in failed (" + (tj.error || tr.status) + ").");
  let id; try { id = JSON.parse(Buffer.from(tj.id_token.split(".")[1], "base64url").toString("utf8")); } catch { return fail(st.app, "Microsoft sent an unreadable sign-in."); }
  const now = Date.now() / 1000;
  if (id.aud !== env.MS_CLIENT_ID || id.tid !== env.MS_TENANT_ID || id.nonce !== st.n || !(id.exp > now)) return fail(st.app, "Microsoft sign-in could not be verified.");

  const email = String(id.email || id.preferred_username || "").toLowerCase();
  let users; try { users = await ghlUsers(env); } catch { return fail(st.app, "Could not reach GHL to check your account. Please try again."); }
  let u = email && users.find(x => x.email === email);
  if (!u && email && env.PANEL_KV) {
    // Agency-level GHL users (e.g. admins) are not in the location's user list; the panel records them in its
    // own config the first time they open it from GHL (users[email].id). Accept those too, unless switched off.
    const cfg = await env.PANEL_KV.get(st.app === "engage" ? "cfg:engage" : "cfg", "json").catch(() => null);
    const c = cfg && cfg.users && cfg.users[email];
    if (c && c.id && c.active !== false) u = { id: c.id, email, name: c.name || "" };
  }
  if (!u) return fail(st.app, "Your Microsoft account (" + (email || "no email") + ") does not match a GHL user. Open the panel from the GHL left menu instead.");
  const token = await panelSession(env, { app: st.app, sub: u.id, email: u.email, name: u.name || id.name });
  return redirect(appPath(st.app) + "#s=" + encodeURIComponent(token), clearCookie);
}

export function resetUsersMemo() { usersMemo = { at: 0, list: null }; }
