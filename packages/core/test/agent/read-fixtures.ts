// Shared fixture builders for the multimodal-read tests (T1): a hand-rolled PNG encoder (no image
// library dependency — mirrors the product code's own "no new image dep" choice for the image
// path). Deliberately tiny/uncompressed — just enough to be a real, sips-readable file.

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
