// Checks the scorecard import, software/renewal notes and the Not interested pool return.
// Run: node test/scorecard.mjs
const repo = new URL("..", import.meta.url).href.replace(/\/$/, "");
const worker = (await import(repo + "/src/worker.js?" + Date.now())).default;
const { panelSession } = await import(repo + "/src/ms-auth.js");
const LOC = "loc1", PL = "pl-sales";
let opps = [{ id: "o1", name: "ARN-5", pipelineId: PL, pipelineStageId: "s1", status: "open", contactId: "c1", assignedTo: "u-rm1", locationId: LOC, customFields: [] }];
let updates = [];
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), m = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null, p = u.pathname;
  if (p === "/users/") return json({ users: [
    { id: "u-admin", name: "Admin", email: "admin@example.com", roles: { role: "admin" } },
    { id: "u-rm1", name: "Mudassir Ali", email: "m@example.com", roles: { role: "user" } },
    { id: "u-rm2", name: "Sharukh Khan", email: "s@example.com", roles: { role: "user" } }] });
  if (p === "/opportunities/pipelines") return json({ pipelines: [{ id: PL, name: "Wylth Sales Pipeline – TEST (Chitra & Arpit)", stages: [{ id: "s1", name: "New", position: 0 }] }] });
  if (/^\/opportunities\/[^/]+$/.test(p) && m === "PUT") { updates.push({ id: p.split("/")[2], body }); return json({ opportunity: { ...opps[0], ...body } }); }
  if (/^\/opportunities\/[^/]+$/.test(p)) return json({ opportunity: opps.find(o => o.id === p.split("/")[2]) || {} });
  if (/\/custom/i.test(p)) return json({ customFields: [] });
  return json({});
};
const kv = new Map(); const env = { GHL_SSO_KEY: "k", GHL_LOCATION_ID: LOC, GHL_API_TOKEN: "t",
  PANEL_KV: { async get(k, t) { const v = kv.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } } };
kv.set("cfg", JSON.stringify({ users: { "admin@example.com": { role: "admin" } } }));
const tokA = await panelSession(env, { app: "sales", sub: "u-admin", email: "admin@example.com", name: "Admin" });
const tokR = await panelSession(env, { app: "sales", sub: "u-rm1", email: "m@example.com", name: "Mudassir Ali" });
const act = async (tok, b) => { const r = await worker.fetch(new Request("https://p/api/action", { method: "POST", headers: { "content-type": "application/json", "X-Panel-Session": tok }, body: JSON.stringify(b) }), env, { waitUntil() {} }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let pass = 0, fail = 0; const ok = (c, m, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m + (x ? "  [" + x + "]" : "")); };

let r = await act(tokA, { action: "scorecard", date: "2026-11-25",
  reps: [{ person: "mudassir", recordings: 11, conversations: 9, talk_min: 15, flags: 3, opening: 2.9, discovery: 1.7, pitch_clarity: 1.9, objection_handling: 2.7, close_next_steps: 2.7, avg_score: 2.4 }, { person: "Nobody Known", recordings: 1 }],
  feedback: [{ person: "Mudassir Ali", kind: "Does well", point: "Clear opening." }, { person: "Mudassir Ali", kind: "Needs improvement", point: "Fix next steps." }] });
ok(r.status === 200 && r.body.imported === 1 && r.body.skipped.length === 1, "scorecard imports matched people and reports the rest", r.status + " " + JSON.stringify(r.body));
const stored = JSON.parse([...kv.entries()].find(([k]) => /rep|call/i.test(k) && k !== "lmeta")?.[1] || "{}");
const row = (stored.calls?.rows || [])[0];
ok(row && row.rm === "u-rm1" && row.well[0] === "Clear opening." && row.imp[0] === "Fix next steps." && row.sc.pitch === 1.9, "row carries scores and feedback", JSON.stringify(row || {}).slice(0, 160));
r = await act(tokR, { action: "scorecard", date: "2026-11-25", reps: [] });
ok(r.status === 403, "an RM cannot import the scorecard", r.status);

r = await act(tokR, { action: "lmeta", id: "o1", sw: "Investwell", rn: "2027-03-31" });
ok(r.status === 200 && r.body.meta.sw === "Investwell", "software and renewal date saved", JSON.stringify(r.body));
r = await act(tokR, { action: "lmeta", op: "get" });
ok(r.body.meta && r.body.meta.o1 && r.body.meta.o1.rn === "2027-03-31", "saved details come back", JSON.stringify(r.body));
r = await act(tokR, { action: "lmeta", id: "o1", sw: "x", rn: "not-a-date" });
ok(r.status === 400, "bad renewal date refused", r.status);

r = await act(tokR, { action: "call", id: "o1", outcome: "Not interested", note: "" });
ok(r.status === 400, "Not interested needs a reason", r.status + " " + (r.body.error || ""));
updates = [];
r = await act(tokR, { action: "call", id: "o1", outcome: "Not interested", note: "Happy with current software" });
ok(r.status === 200 && r.body.pooled === true && updates.some(u => u.body.assignedTo === ""), "Not interested with a reason returns the lead to the pool", r.status + " " + JSON.stringify(updates.map(u => Object.keys(u.body))));
// Feed route used by the daily report job
const { handle } = await import(repo + "/src/core.js?" + Date.now());
env.SCORECARD_FEED_KEY = "feed-key-feed-key-1234"; env.SCORECARD_ADMIN_EMAIL = "admin@example.com";
const feed = async (key, b) => { const h = new Headers({ "content-type": "application/json" }); if (key) h.set("x-feed-key", key); const o = await handle(env, "POST", "https://p/api/feed/scorecard", h, Buffer.from(JSON.stringify(b))); return { status: o.status, body: JSON.parse(o.body.toString() || "{}") }; };
const day = { date: "2026-11-26", reps: [{ person: "Sharukh", recordings: 4, conversations: 3, talk_min: 6, flags: 0, opening: 3, discovery: 2, pitch_clarity: 2, objection_handling: 3, close_next_steps: 2, avg_score: 2.4 }], feedback: [] };
r = await feed("", day); ok(r.status === 401, "feed without a key is refused", r.status);
r = await feed("wrong-key-wrong-key-1234", day); ok(r.status === 401, "feed with a wrong key is refused", r.status);
r = await feed("feed-key-feed-key-1234", day); ok(r.status === 200 && r.body.imported === 1, "feed with the key imports the day", r.status + " " + JSON.stringify(r.body));
console.log(fail ? "FAILED " + fail : "all " + pass + " passed"); process.exit(fail ? 1 : 0);
