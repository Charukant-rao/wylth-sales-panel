// Drives the panel's "newlead" action against a fake GHL to check the duplicate guard.
// Run: node test/duplicate-guard.mjs
const repo = new URL("..", import.meta.url).href.replace(/\/$/, "");
const worker = (await import(repo + "/src/worker.js?" + Date.now())).default;
const { panelSession } = await import(repo + "/src/ms-auth.js");

const LOC = "loc1", PL = "pl-sales";
let contacts, opps, calls;
function reset() {
  contacts = [{ id: "c-exist", name: "Existing Partner", firstName: "Existing", lastName: "Partner", phone: "+919800000001", email: "partner@example.com" }];
  opps = [{ id: "o-exist", name: "ARN-111", pipelineId: PL, pipelineStageId: "s1", status: "open", contactId: "c-exist", assignedTo: "u-rm2", locationId: LOC }];
  calls = [];
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), m = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null; calls.push(m + " " + u.pathname);
  const p = u.pathname;
  if (p === "/users/") return json({ users: [
    { id: "u-admin", name: "Admin", email: "admin@example.com", roles: { role: "admin" } },
    { id: "u-rm1", name: "RM One", email: "rm1@example.com", roles: { role: "user" } },
    { id: "u-rm2", name: "RM Two", email: "rm2@example.com", roles: { role: "user" } }] });
  if (p === "/opportunities/pipelines") return json({ pipelines: [{ id: PL, name: "Wylth Sales Pipeline \u2013 TEST (Chitra & Arpit)", stages: [{ id: "s1", name: "Fresh prospect", position: 0 }, { id: "s2", name: "Follow-up", position: 1 }] }] });
  if (p === "/contacts/search/duplicate") {
    const n = u.searchParams.get("number"), e = u.searchParams.get("email");
    const c = contacts.find(x => (n && x.phone === n) || (e && x.email === e)); return json({ contact: c || null });
  }
  if (p === "/contacts/upsert") {
    let c = contacts.find(x => (body.phone && x.phone === body.phone) || (body.email && x.email === body.email));
    if (c) { Object.assign(c, { name: body.name, firstName: body.firstName, lastName: body.lastName }); return json({ new: false, contact: c }); }
    c = { id: "c-" + contacts.length, ...body }; contacts.push(c); return json({ new: true, contact: c });
  }
  if (p === "/opportunities/search") {
    const cid = u.searchParams.get("contactId") || u.searchParams.get("contact_id"), q = u.searchParams.get("q");
    return json({ opportunities: opps.filter(o => (cid && o.contactId === cid) || (q && o.name.toLowerCase().includes(q.toLowerCase()))), meta: {} });
  }
  if (p === "/opportunities/" && m === "POST") { const o = { id: "o-" + opps.length, ...body }; opps.push(o); return json({ opportunity: o }); }
  if (/\/contacts\/[^/]+\/notes$/.test(p) || /\/contacts\/[^/]+\/tasks$/.test(p)) return json(m === "GET" ? { tasks: [] } : { ok: 1 });
  if (/^\/opportunities\/[^/]+$/.test(p)) return json({ opportunity: opps.find(o => o.id === p.split("/")[2]) || {} });
  return json({});
};
const kv = new Map(); const env = { GHL_SSO_KEY: "k", GHL_LOCATION_ID: LOC, GHL_API_TOKEN: "t",
  PANEL_KV: { async get(k, t) { const v = kv.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); }, async list() { return { keys: [], list_complete: true }; }, async getWithMetadata(k) { return { value: kv.get(k) ?? null, metadata: null }; } } };
const tok = await panelSession(env, { app: "sales", sub: "u-rm1", email: "rm1@example.com", name: "RM One" });
async function add(lead) {
  const r = await worker.fetch(new Request("https://p/api/action", { method: "POST", headers: { "content-type": "application/json", "X-Panel-Session": tok }, body: JSON.stringify(Object.assign({ action: "newlead", pipeline: PL, stage: "s1" }, lead)) }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
let pass = 0, fail = 0; const ok = (c, m, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m + (x ? "  [" + x + "]" : "")); };

reset(); let r = await add({ name: "Wrong Name Typed", phone: "+919800000001" });
ok(r.status === 409 && /RM Two/.test(r.body.error || ""), "same phone as an existing lead is refused and names the RM", r.status + " " + (r.body.error || ""));
ok(contacts[0].name === "Existing Partner", "refused add leaves the existing contact's name untouched", "now: " + contacts[0].name);
ok(opps.length === 1, "no new lead created");
reset(); r = await add({ name: "Someone", phone: "+919800000099", arn: "arn-111" });
ok(r.status === 409, "same ARN (any case) is refused", r.status + " " + (r.body.error || ""));
ok(contacts.length === 1, "refused ARN add does not create a stray contact", contacts.length + " contacts");
reset(); r = await add({ name: "New Partner", phone: "+919800000055", arn: "ARN-999" });
ok(r.status === 200 && opps.length === 2, "a genuinely new lead is added", r.status + " " + JSON.stringify(r.body).slice(0, 120));
reset(); opps[0].status = "lost"; r = await add({ name: "Existing Partner", phone: "+919800000001" });
ok(r.status === 200, "a lost lead can be added again", r.status + " " + (r.body.error || ""));
// Claim by ARN (MFD list): same rule, nothing in GHL changes when the claim is refused
async function act(body) {
  const r = await worker.fetch(new Request("https://p/api/action", { method: "POST", headers: { "content-type": "application/json", "X-Panel-Session": tok }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
reset(); kv.set("mfd:22", JSON.stringify({ "222": { name: "Typed From MFD List", phone: "+919800000001", email: "", city: "Pune" } }));
r = await act({ action: "arnclaim", arn: "222", main: "222" });
ok(r.status === 409, "MFD claim for a contact already held by another RM is refused", r.status + " " + (r.body.error || ""));
ok(contacts[0].name === "Existing Partner" && contacts.length === 1 && opps.length === 1, "refused MFD claim leaves GHL untouched", contacts[0].name + ", " + contacts.length + " contacts");
reset(); kv.set("mfd:33", JSON.stringify({ "333": { name: "New Mfd", phone: "+919800000077", email: "", city: "Pune" } }));
r = await act({ action: "arnclaim", arn: "333", main: "333" });
ok(r.status === 200 && opps.length === 2 && opps[1].assignedTo === "u-rm1", "free MFD ARN is claimed by the RM", r.status + " " + (r.body.error || ""));
reset(); opps[0].name = "ARN-444"; opps[0].updatedAt = new Date().toISOString();
r = await act({ action: "arnlookup", arn: "444" });
ok(r.status === 200 && r.body.found && !r.body.phone, "lookup of another RM's lead does not reveal its phone", JSON.stringify(r.body).slice(0, 120));
// Map by ARN from the lead pool: typed details, mapping to another RM
reset(); r = await act({ action: "arnclaim", arn: "555", name: "Typed Partner" });
ok(r.status === 404, "an unknown ARN without a phone or email is refused", r.status + " " + (r.body.error || ""));
reset(); r = await act({ action: "arnclaim", arn: "555", name: "Typed Partner", phone: "+919800000088", city: "Indore" });
ok(r.status === 200 && opps.length === 2 && opps[1].assignedTo === "u-rm1" && contacts.some(c => c.name === "Typed Partner"), "an unknown ARN is added with the typed details", r.status + " " + (r.body.error || ""));
reset(); r = await act({ action: "arnclaim", arn: "556", name: "For Someone Else", phone: "+919800000089", to: "u-rm2" });
ok(r.status === 200 && opps[1].assignedTo === "u-rm1", "an RM cannot map a lead to someone else (it stays with them)", r.status + " " + (opps[1] && opps[1].assignedTo));
kv.set("cfg", JSON.stringify({ users: { "admin@example.com": { role: "admin" } } }));
const tokA = await panelSession(env, { app: "sales", sub: "u-admin", email: "admin@example.com", name: "Admin" });
async function actA(body) { const r2 = await worker.fetch(new Request("https://p/api/action", { method: "POST", headers: { "content-type": "application/json", "X-Panel-Session": tokA }, body: JSON.stringify(body) }), env, { waitUntil() {} }); return { status: r2.status, body: await r2.json().catch(() => ({})) }; }
reset(); kv.set("mfd:77", JSON.stringify({ "777": { name: "Mfd For Rm Two", phone: "+919800000090", email: "x@example.com", city: "Pune" } }));
r = await actA({ action: "arnlookup", arn: "777" });
ok(r.status === 200 && r.body.pool && r.body.email === "x@example.com" && r.body.city === "Pune", "lookup returns name, phone, email and city to fill the form", JSON.stringify(r.body).slice(0, 160));
r = await actA({ action: "arnclaim", arn: "777", to: "u-rm2" });
ok(r.status === 200 && opps[1].assignedTo === "u-rm2" && /mapped to you by Admin/.test(kv.get("notif:u-rm2") || ""), "admin maps an MFD ARN to an RM, who is notified", r.status + " " + (r.body.error || "") + " " + (opps[1] && opps[1].assignedTo));
console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
