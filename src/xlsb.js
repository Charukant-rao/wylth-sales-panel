// Minimal reader for Excel binary workbooks (.xlsb, BIFF12) – just enough to walk the rows of one sheet.
// Shared strings are decoded lazily (offset table + buffer) so a 200k-row AMFI list stays well under the
// Function's memory: only the strings in the wanted columns are ever turned into JS strings.
import zlib from "node:zlib";

export function unzipParts(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip-based Excel file");
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28),
      xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42),
      name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!wanted(name)) continue;
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
  }
  return out;
}

// BIFF12 record stream: [type varint][size varint][payload]
function* records(b) {
  let p = 0;
  while (p < b.length) {
    let t = b[p++]; if (t & 0x80) t = (t & 0x7f) | ((b[p++] & 0x7f) << 7);
    let size = 0, shift = 0;
    for (let i = 0; i < 4; i++) { const x = b[p++]; size |= (x & 0x7f) << shift; shift += 7; if (!(x & 0x80)) break; }
    yield [t, p, size]; p += size;
  }
}
const wide = (b, p) => { const n = b.readUInt32LE(p); return b.toString("utf16le", p + 4, p + 4 + n * 2); };
function rk(v) {
  let n;
  if (v & 2) n = v >> 2; else { const d = Buffer.alloc(8); d.writeUInt32LE((v & 0xfffffffc) >>> 0, 4); n = d.readDoubleLE(0); }
  return v & 1 ? n / 100 : n;
}

// Opens a workbook; returns { sheetNames, rows(sheetName|index, maxCol) → iterator of arrays }
export function openXlsb(buf) {
  // every part needed later is unpacked now, so the caller can drop the (large) zip buffer straight away
  const parts = unzipParts(buf, n => n === "xl/workbook.bin" || n === "xl/_rels/workbook.bin.rels" || n === "xl/sharedStrings.bin" || /^xl\/worksheets\/[^/]+\.bin$/.test(n));
  const wb = parts["xl/workbook.bin"], rels = (parts["xl/_rels/workbook.bin.rels"] || Buffer.alloc(0)).toString("utf8");
  if (!wb) throw new Error("not an .xlsb workbook");
  const sheets = [];
  for (const [t, p] of records(wb)) if (t === 156) { // BrtBundleSh: hsState(4) iTabID(4) strRelID(XLNullableWideString) strName
    let q = p + 8; const rn = wb.readUInt32LE(q), rid = rn === 0xffffffff ? "" : wide(wb, q); q += 4 + (rn === 0xffffffff ? 0 : rn * 2);
    sheets.push({ name: wide(wb, q), rid });
  }
  const target = s => {
    const tag = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(x => x.includes('Id="' + s.rid + '"')) || "";
    const t = (tag.match(/\bTarget="([^"]*)"/) || [])[1] || "worksheets/sheet1.bin";
    return t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
  };
  // shared strings: remember where each item starts, decode on demand
  const sst = parts["xl/sharedStrings.bin"] || Buffer.alloc(0), offs = [];
  for (const [t, p] of records(sst)) if (t === 19) offs.push(p + 1); // BrtSSTItem: flags(1) then XLWideString
  const str = i => (i >= 0 && i < offs.length ? wide(sst, offs[i]) : "");
  delete parts["xl/workbook.bin"];
  function* rows(which, maxCol = 64) {
    const s = typeof which === "number" ? sheets[which] : sheets.find(x => x.name.trim().toLowerCase() === String(which).trim().toLowerCase()) || sheets[0];
    if (!s) return;
    const name = target(s), sh = parts[name];
    if (!sh) throw new Error("sheet not found: " + s.name);
    let cur = null, rw = -1;
    for (const [t, p] of records(sh)) {
      if (t === 0) { if (cur) yield cur; rw = sh.readUInt32LE(p); cur = []; continue; } // BrtRowHdr
      if (t < 1 || t > 11 || !cur) continue;
      const col = sh.readUInt32LE(p); if (col >= maxCol) continue; const v = p + 8;
      cur[col] = t === 2 ? rk(sh.readUInt32LE(v)) : t === 5 || t === 9 ? sh.readDoubleLE(v) : t === 7 ? str(sh.readUInt32LE(v))
        : t === 6 || t === 8 ? wide(sh, v) : t === 4 || t === 10 ? !!sh[v] : null;
    }
    if (cur) yield cur;
  }
  return { sheetNames: sheets.map(s => s.name), rows };
}
