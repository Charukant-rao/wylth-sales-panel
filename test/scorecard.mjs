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
// Several days at once, with the rating out of 10
r = await act(tokA, { action: "scorecard", days: [
  { date: "2026-11-20", reps: [{ person: "Mudassir", rating: 6.5, conversations: 7 }, { person: "Sharukh", rating: 4.1, conversations: 3 }] },
  { date: "2026-11-21\u201322", reps: [{ person: "Mudassir", rating: 7.2, conversations: 5 }] },
  { date: "2026-11-24", reps: [{ person: "Mudassir", rating: 8.4, band: "Strong", low_sample: true, recordings: 9, conversations: 6, avg_score: 3.1 }] }] });
ok(r.status === 200 && r.body.imported === 4, "several days import in one call (date ranges use the first day)", r.status + " " + JSON.stringify(r.body));
const st2 = JSON.parse([...kv.entries()].find(([k]) => /rep|call/i.test(k) && k !== "lmeta")?.[1] || "{}").calls.rows;
const d24 = st2.find(c => c.date === "2026-11-24");
ok(d24 && d24.rating === 8.4 && d24.band === "Strong" && d24.low === true, "rating, band and few-calls flag are kept", JSON.stringify(d24 || {}).slice(0, 200));
ok(st2.some(c => c.date === "2026-11-21" && c.rating === 7.2), "a weekend range is stored under its first day");

// Full day bundle in the artifact's format, and what each person gets back
const bundle = { funnel: [{ stage: "Recordings", calls: 30 }], reps: [{ person: "mudassir", rating: 7.2, band: "Strong", conversations: 4 }, { person: "Sharukh", rating: 4.0, band: "Needs coaching", conversations: 9 }],
  feedback: [{ person: "mudassir", kind: "Does well", point: "Clear pricing." }, { person: "Sharukh", kind: "Needs improvement", point: "Ask about AUM." }],
  outcomes: [{ person: "mudassir", outcome: "Demo booked", calls: 1 }], actions: [], concerns: [{ theme: "Price", mentions: 3, handled_weakly: 1 }], flags: [], issues: [], history: [{ date: "2026-11-26", recordings: 30 }],
  rep_history: [{ date: "2026-11-25", person: "mudassir", rating: 6.1 }, { date: "2026-11-26", person: "Sharukh", rating: 4.0 }] };
r = await act(tokA, { action: "scorecard", date: "2026-11-26", bundle });
ok(r.status === 200 && r.body.imported === 2, "a full day bundle imports and also feeds the call rows", r.status + " " + JSON.stringify(r.body));
r = await act(tokA, { action: "scget" });
ok(r.status === 200 && r.body.date === "2026-11-26" && r.body.data.reps.length === 2 && r.body.data.concerns.length === 1 && r.body.data.reps.every(x => x.uid), "admin gets the whole day with people matched", JSON.stringify(r.body).slice(0, 200));
r = await act(tokR, { action: "scget" });
ok(r.status === 200 && r.body.mine === true && r.body.data.reps.length === 1 && r.body.data.reps[0].uid === "u-rm1" && r.body.data.feedback.length === 1 && r.body.data.concerns.length === 0 && r.body.data.rep_history.length === 1, "an RM gets only their own rows and no team sections", JSON.stringify(r.body.data || {}).slice(0, 200));

// Sold clients from the Onboarding sheet keep their own date and instalments
r = await act(tokR, { action: "soldimport", id: "o1", total: 11800, pays: [{ d: "2026-06-01", a: 5900 }] });
ok(r.status === 403, "an RM cannot import sold clients", r.status);
updates = [];
r = await act(tokA, { action: "soldimport", id: "o1", total: 11800, date: "2026-04-02", products: "Platform, Wylth AI", rm: "u-rm2", pays: [{ d: "2026-06-01", a: 5900, note: "UPI" }, { d: "2026-04-02", a: 5900 }] });
ok(r.status === 200 && r.body.sold.date === "2026-04-02" && r.body.pay.paid === 11800 && r.body.pay.hist.length === 2 && r.body.pay.hist[0].d === "2026-04-02", "sold import keeps the onboarding date and each instalment date", r.status + " " + JSON.stringify(r.body).slice(0, 220));
ok(updates.some(u => u.body.status === "won" && u.body.monetaryValue === 11800 && u.body.assignedTo === "u-rm2"), "the lead is marked won for the full amount and given to the sheet RM", JSON.stringify(updates.map(u => u.body.status)));
ok(JSON.parse(kv.get("cfg")).soldDates.o1 === "2026-04-02" && JSON.parse(kv.get("cfg")).users["admin@example.com"].role === "admin", "the sold date is saved and the rest of the config is kept", kv.get("cfg").slice(0, 160));

// Live MIS: demo events, targets and follow-up reminders
r = await act(tokR, { action: "call", id: "o1", outcome: "Demo booked", note: "" });
ok(r.status === 400, "a booked demo needs the demo date", r.status);
r = await act(tokR, { action: "call", id: "o1", outcome: "Demo booked", note: "Wants a live demo", followup: "2026-12-02" });
ok(r.status === 200, "a call can be logged as Demo booked", r.status + " " + (r.body.error || ""));
r = await act(tokR, { action: "status", id: "o1", status: "demo" });
ok(r.status === 200, "status can be set to Demo done", r.status + " " + (r.body.error || ""));
const evk = [...kv.keys()].find(k => k.startsWith("ev:"));
const evs = evk ? JSON.parse(kv.get(evk)) : [];
ok(evs.some(x => x.t === "booked" && x.on === "2026-12-02") && evs.some(x => x.t === "demo") && evs.some(x => x.t === "call"), "calls, booked demos and done demos are recorded", JSON.stringify(evs.map(x => x.t)));
r = await act(tokR, { action: "misbase", month: "2026-11", rows: [] });
ok(r.status === 403, "an RM cannot set MIS targets", r.status);
r = await act(tokA, { action: "misbase", month: evk.slice(3, 10), asOf: "2026-11-26", holidays: ["2026-11-10"], monthDays: 20, rows: [{ person: "Mudassir Ali", dM: 15, target: 10, committed: 200000 }, { person: "Nobody", dM: 1 }] });
ok(r.status === 200 && r.body.matched === 1 && r.body.unmatched.length === 1, "admin sets targets and the tracker baseline", JSON.stringify(r.body));
r = await act(tokR, { action: "events", month: evk.slice(3, 10) });
ok(r.status === 200 && r.body.events.length === evs.length && r.body.base.rows["u-rm1"].target === 10, "an RM gets their own events and target", JSON.stringify(r.body).slice(0, 200));
r = await act(tokR, { action: "nudge", id: "o1", text: "x" });
ok(r.status === 403, "an RM cannot send follow-up reminders", r.status);
updates = [];
r = await act(tokA, { action: "nudge", id: "o1", due: "2026-12-05", text: "Send the quotation" });
const nf = JSON.parse(kv.get("notif:u-rm1") || kv.get("notif:u-rm2") || "[]");
ok(r.status === 200 && r.body.next === "2026-12-05" && nf.some(n => /follow up/.test(n.text)), "admin reminder notifies the RM and sets the follow-up", r.status + " " + JSON.stringify(nf).slice(0, 160));

// Feed route used by the daily report job
const { handle } = await import(repo + "/src/core.js?" + Date.now());
env.SCORECARD_FEED_KEY = "feed-key-feed-key-1234"; env.SCORECARD_ADMIN_EMAIL = "admin@example.com";
const feed = async (key, b) => { const h = new Headers({ "content-type": "application/json" }); if (key) h.set("x-feed-key", key); const o = await handle(env, "POST", "https://p/api/feed/scorecard", h, Buffer.from(JSON.stringify(b))); return { status: o.status, body: JSON.parse(o.body.toString() || "{}") }; };
const day = { date: "2026-11-26", reps: [{ person: "Sharukh", recordings: 4, conversations: 3, talk_min: 6, flags: 0, opening: 3, discovery: 2, pitch_clarity: 2, objection_handling: 3, close_next_steps: 2, avg_score: 2.4 }], feedback: [] };
r = await feed("", day); ok(r.status === 401, "feed without a key is refused", r.status);
r = await feed("wrong-key-wrong-key-1234", day); ok(r.status === 401, "feed with a wrong key is refused", r.status);
r = await feed("feed-key-feed-key-1234", day); ok(r.status === 200 && r.body.imported === 1, "feed with the key imports the day", r.status + " " + JSON.stringify(r.body));
console.log(fail ? "FAILED " + fail : "all " + pass + " passed"); process.exit(fail ? 1 : 0);
