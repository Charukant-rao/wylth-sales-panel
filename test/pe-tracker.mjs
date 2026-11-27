// Partner Engagement tracker: xlsx reader, Azure SAS download + cache, and the search hook in the page.
import fs from "node:fs";
import vm from "node:vm";
import { parseTracker, loadTracker, peLookup, _resetForTests } from "../src/pe-tracker.js";
import { makeEnv, handle } from "../src/core.js";
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };
const buf = fs.readFileSync(new URL("./fixtures/pe-tracker.xlsx", import.meta.url));
const m = parseTracker(buf);
ok(m.size === 2, "reads only the Partner Master sheet (" + m.size + " partners)");
ok(JSON.stringify(m.get("12345")) === JSON.stringify({ arn: "12345", partner: "Test Partner & Co", salesRm: "Asha", primarySrm: "Ravi", secondarySrm: "Meera", peRm: "Riya" }), "row mapped, XML entities decoded");
ok(m.get("777") && m.get("777").primarySrm === "" && m.get("777").peRm === "Ankita", "leading zeros dropped, 0 means blank");
ok(!m.has("11111"), "other sheets ignored");
// download through the container SAS, cached
_resetForTests(); let calls = 0, seen = "";
const env = { TRACKER_CONTAINER_SAS_URL: "https://acct.blob.core.windows.net/list?sp=r&sig=abc" };
const fake = async u => { calls++; seen = String(u); return new Response(buf); };
await loadTracker(env, fake); await loadTracker(env, fake);
ok(calls === 1, "tracker cached between lookups");
ok(seen === "https://acct.blob.core.windows.net/list/Partner_Engagement_Master_Tracker.xlsx?sp=r&sig=abc", "blob URL built from the container SAS");
ok((await peLookup(env, "ARN-12345")).peRm === "Riya" && await peLookup(env, "99999") === null, "lookup by ARN in any spelling");
_resetForTests(); ok(await peLookup({}, "12345") === null, "no SAS setting: lookup quietly returns nothing");
ok(typeof makeEnv({}).PE_LOOKUP === "function", "panel env exposes PE_LOOKUP");
// the page still parses with the search hook added
const kv = { async get() { return null; }, async getWithMetadata() { return { value: null, metadata: null }; }, async put() {}, async delete() {} };
const page = await handle(makeEnv(kv), "GET", "https://example.azurewebsites.net/", new Headers(), null);
const html = page.body.toString("utf8"), scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
let compiled = true; for (const s of scripts) { try { new vm.Script(s); } catch (e) { compiled = false; console.log(e.message); } }
ok(scripts.length > 0 && compiled, "page scripts compile (" + scripts.length + ")");
ok(html.includes('action:"pelookup"') && html.includes("Partner Engagement tracker"), "search box hook is in the page");
console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
