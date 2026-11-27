// AMFI Distributor List (.xlsb or .xlsx in Azure Blob) → the panel's MFD list (KV keys mfd:00…mfd:99).
// The MFD list is what Claim by ARN, the lead pool and "Fill missing cities" read. Admins used to load it
// by hand 3,000 rows at a time; now the 5-minute timer checks the blob's ETag and re-imports only when the
// file changed. Settings: TRACKER_CONTAINER_SAS_URL (read-only container SAS, shared with the PE tracker)
// and DISTRIBUTOR_BLOB (file name, default "Distributor List-12-Oct.xlsb").
// Records keep the existing shape { name, phone, email, city, state, pin }; blanks never wipe a value that
// is already there (e.g. a state typed in by an admin).
import { openXlsb } from "./xlsb.js";
import zlib from "node:zlib";

const DEFAULT_BLOB = "Distributor List-12-Oct.xlsb";
const LOCK_MS = 15 * 60 * 1000;

export function blobUrl(env, name) {
  const u = new URL(env.TRACKER_CONTAINER_SAS_URL);
  u.pathname = u.pathname.replace(/\/+$/, "") + "/" + encodeURIComponent(name);
  return u;
}

const txt = v => {
  if (v == null || v === false) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  let s = String(v).trim().replace(/^'+/, "").trim();
  return /^[-.\s]*$/.test(s) ? "" : s; // "-", "." and blanks mean nothing
};

// Rows → Map(arn → record). Columns are found by their header names, so a reordered file still works.
export function distributorRecords(rowIter) {
  const out = new Map(); let col = null;
  for (const r of rowIter) {
    if (!col) {
      const h = r.map(x => String(x ?? "").trim().toLowerCase().replace(/[^a-z]/g, ""));
      const find = (...names) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
      const arn = find("arnnumber", "arn", "arncode");
      if (arn < 0) continue; // still above the header row
      col = { arn, name: find("arnholdername", "name"), city: find("city"), pin: find("pin", "pincode"), state: find("state"),
        phone: find("telephonenumbero", "mobile", "phone", "telephonenumberr"), phone2: find("telephonenumberr"), email: find("email") };
      continue;
    }
    const a = r[col.arn];
    if (typeof a === "string" && /[a-z]/i.test(a) && !/^\s*arn/i.test(a)) continue; // OD… codes are not ARNs
    const arn = String(typeof a === "number" ? Math.trunc(a) : a ?? "").replace(/\D/g, "").replace(/^0+/, "");
    if (arn.length < 3) continue;
    const get = i => (i >= 0 ? txt(r[i]) : "");
    out.set(arn, {
      name: get(col.name).slice(0, 120), phone: (get(col.phone) || get(col.phone2)).slice(0, 60), email: get(col.email).toLowerCase().slice(0, 160),
      city: get(col.city).slice(0, 60), state: get(col.state).slice(0, 60), pin: get(col.pin).slice(0, 12)
    });
  }
  return out;
}

// .xlsb → streamed rows of the first sheet; .xlsx → rows of xl/worksheets/sheet1.xml (columns A–AF)
function rowsOf(buf, name) {
  return /\.xlsb$/i.test(name) ? openXlsb(buf).rows(0, 32) : xlsxFirstSheetRows(buf);
}
function xlsxFirstSheetRows(buf) {
  const z = {}; let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not an Excel file");
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42), name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name !== "xl/sharedStrings.xml" && name !== "xl/worksheets/sheet1.xml") continue;
    const s = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), d = buf.subarray(s, s + csize);
    z[name] = (method === 8 ? zlib.inflateRawSync(d) : d).toString("utf8");
  }
  const un = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const ss = [...(z["xl/sharedStrings.xml"] || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => un([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
  const rows = [];
  for (const rm of (z["xl/worksheets/sheet1.xml"] || "").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (cm[1].match(/\br="([A-Z]+)\d+"/) || [])[1]; if (!ref) continue;
      let i = 0; for (const ch of ref) i = i * 26 + ch.charCodeAt(0) - 64; i--; if (i > 31) continue;
      const t = (cm[1].match(/\bt="([^"]*)"/) || [])[1], v = ((cm[2] || "").match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      cells[i] = t === "s" ? ss[+v] : t === "inlineStr" ? un([...(cm[2] || "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join("")) : t === "str" ? un(v || "") : v != null && v !== "" && !isNaN(+v) ? +v : v != null ? un(v) : null;
    }
    rows.push(cells);
  }
  return rows;
}

// Writes records into the 100 MFD buckets, merging so blanks never erase existing values.
export async function writeBuckets(store, recs) {
  const by = {};
  for (const [arn, r] of recs) (by[arn.slice(-2).padStart(2, "0")] ||= {})[arn] = r;
  let n = 0;
  for (const [bk, mm] of Object.entries(by)) {
    const cur = await store.get("mfd:" + bk, "json") || {};
    for (const [arn, r] of Object.entries(mm)) {
      const was = cur[arn] || {}, merged = Object.assign({}, was);
      for (const [k, v] of Object.entries(r)) if (v) merged[k] = v;
      cur[arn] = merged; n++;
    }
    await store.put("mfd:" + bk, JSON.stringify(cur));
  }
  return n;
}

// Called from the 5-minute timer. Cheap when nothing changed: one HEAD request.
export async function syncDistributors(env, log = () => {}, fetchImpl = fetch) {
  if (!env.TRACKER_CONTAINER_SAS_URL) return { skipped: "no TRACKER_CONTAINER_SAS_URL" };
  const name = env.DISTRIBUTOR_BLOB || DEFAULT_BLOB, url = blobUrl(env, name), st = env.PANEL_KV;
  const head = await fetchImpl(url, { method: "HEAD" });
  if (head.status === 404) return { skipped: "no file " + name };
  if (!head.ok) throw new Error("distributor list check failed: " + head.status);
  const etag = head.headers.get("etag") || head.headers.get("last-modified") || "";
  const was = await st.get("mfdsrc", "json") || {};
  if (was.etag === etag && was.blob === name && !was.error) return { unchanged: true, rows: was.rows };
  if (was.busy && Date.now() - was.busy < LOCK_MS) return { skipped: "import already running" };
  // crash guard: a lock left behind means an earlier run of this same file died (e.g. out of memory).
  // After two such runs stop retrying until a new file is uploaded, so the panel can't crash-loop.
  const sameTry = was.tryEtag === etag && was.tryBlob === name;
  if (sameTry && was.gaveUp) return { skipped: "gave up on this file: " + was.error };
  if (sameTry && was.busy && (was.tries || 0) >= 2) {
    await st.put("mfdsrc", JSON.stringify(Object.assign({}, was, { busy: 0, gaveUp: true, error: "import stopped part-way twice (likely out of memory); upload a new file or raise the Function's instance memory", errAt: Date.now() })));
    return { skipped: "gave up on this file after two failed runs" };
  }
  const lock = { busy: Date.now(), tryEtag: etag, tryBlob: name, tries: (sameTry ? was.tries || 0 : 0) + 1 };
  await st.put("mfdsrc", JSON.stringify(Object.assign({}, was, lock)));
  try {
    const t0 = Date.now(), r = await fetchImpl(url);
    if (!r.ok) throw new Error("distributor list download failed: " + r.status);
    let buf = Buffer.from(await r.arrayBuffer());
    const it = rowsOf(buf, name); buf = null; // parts are unpacked; let the zip go
    const recs = distributorRecords(it);
    const min = +(env.DISTRIBUTOR_MIN_ROWS || 100); // guards against importing the wrong file
    if (recs.size < min) throw new Error("only " + recs.size + " ARNs found, nothing imported");
    const n = await writeBuckets(st, recs);
    const out = { blob: name, etag, rows: n, at: Date.now(), ms: Date.now() - t0 };
    await st.put("mfdsrc", JSON.stringify(out)); log("distributor list imported", out);
    return out;
  } catch (e) {
    // an ordinary error (bad download, wrong file) is retried on the next run; only crashes count toward the guard
    await st.put("mfdsrc", JSON.stringify({ blob: name, etag: was.etag || "", rows: was.rows || 0, at: was.at || 0, error: String(e.message || e).slice(0, 300), errAt: Date.now(), tryEtag: etag, tryBlob: name, tries: 0 }));
    throw e;
  }
}
