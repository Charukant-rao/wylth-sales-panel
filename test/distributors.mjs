// AMFI Distributor List import: .xlsb reader, column mapping, MFD buckets, ETag-based re-import.
// Builds a tiny made-up .xlsb in memory (no real distributor data in the repo).
import zlib from "node:zlib";
import { openXlsb } from "../src/xlsb.js";
import { distributorRecords, writeBuckets, syncDistributors } from "../src/distributors.js";
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

// ---- tiny BIFF12 writer ----
const vint = n => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const rec = (type, payload) => Buffer.concat([Buffer.from(type < 128 ? [type] : [(type & 0x7f) | 0x80, type >> 7]), Buffer.from(vint(payload.length)), payload]);
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const wide = s => Buffer.concat([u32(s.length), Buffer.from(s, "utf16le")]);
const f64 = n => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
function zip(files) {
  const locals = [], central = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name), crc = zlib.crc32(data), comp = zlib.deflateRawSync(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); central.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const strings = ["ARN number", "ARNHolderName", "City", "Pin", "TelephoneNumber_O", "Email", "Asha Investments", "Pune", "'+919800000001", "ASHA@EXAMPLE.COM", "Ravi Advisors", "Nagpur", "'-", "OD100200", "Meera Rao"];
const isst = s => strings.indexOf(s);
const cellS = (c, s) => rec(7, Buffer.concat([u32(c), u32(0), u32(isst(s))]));
const cellN = (c, n) => rec(5, Buffer.concat([u32(c), u32(0), f64(n)]));
const cellRk = (c, n) => rec(2, Buffer.concat([u32(c), u32(0), u32((n << 2) | 2)]));
const row = r => rec(0, Buffer.concat([u32(r), Buffer.alloc(13)]));
const sheet = Buffer.concat([
  row(0), ...["ARN number", "ARNHolderName", "City", "Pin", "TelephoneNumber_O", "Email"].map((h, i) => cellS(i, h)),
  row(1), cellN(0, 12345), cellS(1, "Asha Investments"), cellS(2, "Pune"), cellN(3, 411001), cellS(4, "'+919800000001"), cellS(5, "ASHA@EXAMPLE.COM"),
  row(2), cellRk(0, 777), cellS(1, "Ravi Advisors"), cellS(2, "Nagpur"), cellS(4, "'-"),
  row(3), cellS(0, "OD100200"), cellS(1, "Meera Rao"),
]);
const sst = Buffer.concat(strings.map(s => rec(19, Buffer.concat([Buffer.from([0]), wide(s)]))));
const wb = Buffer.concat([rec(156, Buffer.concat([u32(0), u32(1), wide("rId1"), wide("Sheet1")])), rec(156, Buffer.concat([u32(0), u32(2), wide("rId2"), wide("Code")]))]);
const rels = Buffer.from('<Relationships><Relationship Id="rId2" Target="worksheets/sheet2.bin"/><Relationship Id="rId1" Target="worksheets/sheet1.bin"/></Relationships>');
const xlsb = zip({ "xl/workbook.bin": wb, "xl/_rels/workbook.bin.rels": rels, "xl/sharedStrings.bin": sst, "xl/worksheets/sheet1.bin": sheet, "xl/worksheets/sheet2.bin": row(0) });

// ---- reader ----
const w = openXlsb(xlsb), rows = [...w.rows(0, 32)];
ok(w.sheetNames.join() === "Sheet1,Code", "sheet names read");
ok(rows.length === 4 && rows[1][0] === 12345 && rows[1][1] === "Asha Investments" && rows[2][0] === 777, "cells: shared strings, doubles and RK numbers");
const recs = distributorRecords(rows);
ok(recs.size === 2 && !recs.has("100200"), "header found by name, OD codes skipped (" + recs.size + ")");
ok(JSON.stringify(recs.get("12345")) === JSON.stringify({ name: "Asha Investments", phone: "+919800000001", email: "asha@example.com", city: "Pune", state: "", pin: "411001" }), "record cleaned (quote prefix, lower-case email)");
ok(recs.get("777").phone === "", "'-' placeholder becomes blank");

// ---- buckets merge ----
const mem = new Map(), kv = { async get(k, t) { const v = mem.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { mem.set(k, v); }, async delete(k) { mem.delete(k); } };
mem.set("mfd:45", JSON.stringify({ 12345: { name: "Old", state: "Maharashtra", city: "" } }));
ok(await writeBuckets(kv, recs) === 2, "two ARNs written");
const b45 = JSON.parse(mem.get("mfd:45"));
ok(b45["12345"].name === "Asha Investments" && b45["12345"].state === "Maharashtra", "new values win, blanks keep the old state");
ok(JSON.parse(mem.get("mfd:77"))["777"].city === "Nagpur", "bucket by last two digits");

// ---- timer sync: imports once, then only when the ETag changes ----
let etag = '"v1"', gets = 0;
const fake = async (u, o = {}) => { if (o.method === "HEAD") return new Response(null, { status: 200, headers: { etag } }); gets++; return new Response(xlsb); };
const env = { PANEL_KV: kv, TRACKER_CONTAINER_SAS_URL: "https://acct.blob.core.windows.net/list?sp=r&sig=x", DISTRIBUTOR_MIN_ROWS: "1" };
ok(await syncDistributors(Object.assign({}, env, { DISTRIBUTOR_MIN_ROWS: "" }), () => {}, async (u, o = {}) => o.method === "HEAD" ? new Response(null, { headers: { etag: '"x"' } }) : new Response(xlsb)).then(() => false, e => /only 2 ARNs/.test(e.message)), "too few rows: refuses to import");
mem.delete("mfdsrc");
const s1 = await syncDistributors(env, () => {}, fake);
ok(s1.rows === 2 && s1.blob === "Distributor List-12-Oct.xlsb" && gets === 1, "first run imports");
ok((await syncDistributors(env, () => {}, fake)).unchanged === true && gets === 1, "unchanged file is not downloaded again");
etag = '"v2"'; await syncDistributors(env, () => {}, fake); ok(gets === 2, "new upload re-imports");
ok((await syncDistributors({ PANEL_KV: kv }, () => {}, fake)).skipped, "no SAS setting: skipped");
const miss = await syncDistributors(env, () => {}, async () => new Response(null, { status: 404 }));
ok(miss.skipped && miss.skipped.startsWith("no file"), "missing file: skipped, nothing changed");
// crash guard: a run that died leaves its lock behind; after two such runs of one file, stop retrying
etag = '"v3"'; const crashed = { blob: "Distributor List-12-Oct.xlsb", etag: '"v2"', rows: 2, busy: Date.now() - 20 * 60 * 1000, tryEtag: '"v3"', tryBlob: "Distributor List-12-Oct.xlsb", tries: 2 };
mem.set("mfdsrc", JSON.stringify(crashed)); gets = 0;
const g1 = await syncDistributors(env, () => {}, fake);
ok(g1.skipped && gets === 0 && JSON.parse(mem.get("mfdsrc")).gaveUp, "two crashed runs: gives up, no download");
ok((await syncDistributors(env, () => {}, fake)).skipped && gets === 0, "stays given up for the same file");
etag = '"v4"'; const g2 = await syncDistributors(env, () => {}, fake);
ok(g2.rows === 2 && gets === 1, "a new upload is imported again");
console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
