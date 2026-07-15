// Shared fixture builders for the multimodal-read tests (T1/T2): a hand-rolled PNG encoder (no
// image library dependency — mirrors the product code's own "no new image dep" choice) and a
// hand-built minimal PDF writer (objects/xref/trailer written by hand, no PDF-authoring library).
// Both are deliberately tiny/uncompressed — just enough to be real, sips/unpdf-readable files.

import { deflateSync } from "node:zlib";

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, Buffer.from(data), crcBuf]);
}

/** Builds a minimal valid 8-bit RGB PNG of the given size. `noisy: true` fills it with random
 *  per-pixel bytes (incompressible — used to produce a large FILE SIZE at small dimensions, to
 *  test the "recompress because of size, not dimensions" branch without needing a 1600px+ image). */
export function makePng(width: number, height: number, opts?: { rgb?: [number, number, number]; noisy?: boolean }): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = pngChunk("IHDR", ihdrData);

  const rgb = opts?.rgb ?? [200, 60, 60];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let off = 0;
  for (let y = 0; y < height; y++) {
    raw[off++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      if (opts?.noisy) {
        raw[off++] = Math.floor(Math.random() * 256);
        raw[off++] = Math.floor(Math.random() * 256);
        raw[off++] = Math.floor(Math.random() * 256);
      } else {
        raw[off++] = rgb[0];
        raw[off++] = rgb[1];
        raw[off++] = rgb[2];
      }
    }
  }
  const idat = pngChunk("IDAT", deflateSync(raw, opts?.noisy ? { level: 0 } : undefined));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

/** Builds a minimal valid PDF with one page per entry in `pageTexts` (each rendered as a single
 *  `Tj` text-show operator in a Helvetica content stream — no compression, no xref STREAM, just
 *  the classic object/xref-table/trailer shape every PDF reader (incl. pdf.js/unpdf) accepts). An
 *  empty string produces a page with NO text operators at all (simulates a scanned/image-only
 *  page for the "no extractable text" test). */
export function makePdf(pageTexts: string[]): Buffer {
  const n = pageTexts.length;
  // Object numbering: 1=Catalog, 2=Pages, 3..(2+n)=Page objects, (3+n)..(2+2n)=Content streams,
  // (3+2n)=Font.
  const pageObjNum = (i: number) => 3 + i;
  const contentObjNum = (i: number) => 3 + n + i;
  const fontObjNum = 3 + 2 * n;
  const total = fontObjNum;

  const objs: string[] = [];
  const kids = Array.from({ length: n }, (_, i) => `${pageObjNum(i)} 0 R`).join(" ");
  objs[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objs[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`;
  for (let i = 0; i < n; i++) {
    objs[pageObjNum(i)] =
      `${pageObjNum(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentObjNum(i)} 0 R >>\nendobj\n`;
  }
  for (let i = 0; i < n; i++) {
    const text = pageTexts[i]!;
    const content = text.length ? `BT /F1 18 Tf 72 700 Td (${escapePdfText(text)}) Tj ET` : "";
    objs[contentObjNum(i)] = `${contentObjNum(i)} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
  }
  objs[fontObjNum] = `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= total; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += objs[i];
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function escapePdfText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
