// Partner Engagement Master Tracker → ARN lookup for the panel's search.
// The tracker (.xlsx) lives in Azure Blob Storage; the app setting TRACKER_CONTAINER_SAS_URL is a
// read-only container SAS (…/list?sp=r&…) and TRACKER_BLOB names the file
// (default Partner_Engagement_Master_Tracker.xlsx). Only the "Partner Master" sheet is read:
//   A ARN Code | B Partner Name | D Sales RM | E Prm SRM | F Sec SRM | G PE RM
// No extra packages: a small reader for the zip + sheet XML, so either the full workbook or a
// one-sheet copy works. Kept in memory for 10 minutes; a failed refresh keeps the last good copy.
import zlib from "node:zlib";

const TTL = 10 * 60 * 1000;
let cache = { at: 0, map: null, err: null };

export const normArn = v => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
const clean = v => { const s = String(v ?? "").trim(); return s === "0" ? "" : s; };
const unxml = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");

// ---- zip ----
function unzip(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("tracker is not an .xlsx file");
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28),
      xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42),
      name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!wanted(name)) continue;
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + csize);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
  }
  return out;
}

const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

export function parseTracker(buf) {
  const meta = unzip(buf, n => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml");
  const wb = meta["xl/workbook.xml"] || "", rels = meta["xl/_rels/workbook.xml.rels"] || "";
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => ({ name: unxml((m[0].match(/\bname="([^"]*)"/) || [])[1] || ""), rid: (m[0].match(/\br:id="([^"]*)"/) || [])[1] }));
  const sheet = sheets.find(s => s.name.trim().toLowerCase() === "partner master") || sheets[0];
  if (!sheet) throw new Error("tracker has no sheets");
  const relTag = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(t => t.includes('Id="' + sheet.rid + '"')) || "";
  let target = (relTag.match(/\bTarget="([^"]*)"/) || [])[1] || "worksheets/sheet1.xml";
  target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  const xml = unzip(buf, n => n === target)[target];
  if (!xml) throw new Error("tracker sheet not found: " + sheet.name);
  const ss = [...(meta["xl/sharedStrings.xml"] || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unxml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
  const map = new Map();
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || "", ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      if (!ref) continue;
      const i = colIndex(ref); if (i > 6) continue;
      const type = (attrs.match(/\bt="([^"]*)"/) || [])[1], v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      cells[i] = type === "s" ? ss[+v] : type === "inlineStr" ? unxml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")) : v != null ? unxml(v) : "";
    }
    const arn = normArn(cells[0]);
    if (!arn || !/arn/i.test(String(cells[0]))) continue; // skips the header row and blank lines
    map.set(arn, { arn, partner: clean(cells[1]), salesRm: clean(cells[3]), primarySrm: clean(cells[4]), secondarySrm: clean(cells[5]), peRm: clean(cells[6]) });
  }
  return map;
}

export async function loadTracker(env, fetchImpl = fetch) {
  if (cache.map && Date.now() - cache.at < TTL) return cache.map;
  const sas = env.TRACKER_CONTAINER_SAS_URL;
  if (!sas) return null;
  try {
    const u = new URL(sas);
    u.pathname = u.pathname.replace(/\/+$/, "") + "/" + encodeURIComponent(env.TRACKER_BLOB || "Partner_Engagement_Master_Tracker.xlsx");
    const r = await fetchImpl(u);
    if (!r.ok) throw new Error("tracker download failed: " + r.status);
    cache = { at: Date.now(), map: parseTracker(Buffer.from(await r.arrayBuffer())), err: null };
  } catch (e) {
    cache = { at: Date.now() - TTL + 60000, map: cache.map, err: String(e.message || e) }; // retry in a minute
    if (!cache.map) throw e;
  }
  return cache.map;
}

// arn (any spelling: "ARN-89393", "89393") → { arn, partner, salesRm, primarySrm, secondarySrm, peRm } or null
export async function peLookup(env, arn) {
  const map = await loadTracker(env).catch(() => null), k = normArn(arn);
  return map && k ? map.get(k) || null : null;
}

export const _resetForTests = () => { cache = { at: 0, map: null, err: null }; };
