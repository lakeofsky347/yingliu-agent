import { deflateSync, inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 4, 'ascii');
  const crcInput = Buffer.concat([head.subarray(4, 8), Buffer.from(body)]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([head, Buffer.from(body), tail]);
}

/** Decode non-interlaced 8-bit PNG (grayscale, RGB, gray+alpha, RGBA) into packed RGBA bytes. */
export function decodePngRgba(bytes: Uint8Array): DecodedPng | null {
  const b = Buffer.from(bytes);
  if (b.length < 45 || b.readUInt32BE(0) !== 0x89504e47) return null;
  let p = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const chunks: Buffer[] = [];
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p);
    if (p + 12 + len > b.length) return null;
    const type = b.toString('ascii', p + 4, p + 8);
    const body = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]!; color = body[9]!; interlace = body[12]!;
    } else if (type === 'IDAT') chunks.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels || depth !== 8 || interlace !== 0 || width < 1 || height < 1 || width * height > 24_000_000) return null;
  const stride = width * channels;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height }); } catch { return null; }
  if (raw.length < (stride + 1) * height) return null;

  const rgba = new Uint8Array(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels]! : 0;
      const up = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      const pred = filter === 1 ? a : filter === 2 ? up : filter === 3 ? (a + up) >> 1 : filter === 4 ? (() => {
        const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      })() : 0;
      line[x] = (line[x]! + pred) & 255;
    }
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4, src = x * channels;
      if (channels === 4) {
        rgba[dst] = line[src]!; rgba[dst + 1] = line[src + 1]!; rgba[dst + 2] = line[src + 2]!; rgba[dst + 3] = line[src + 3]!;
      } else if (channels === 3) {
        rgba[dst] = line[src]!; rgba[dst + 1] = line[src + 1]!; rgba[dst + 2] = line[src + 2]!; rgba[dst + 3] = 255;
      } else if (channels === 2) {
        rgba[dst] = line[src]!; rgba[dst + 1] = line[src]!; rgba[dst + 2] = line[src]!; rgba[dst + 3] = line[src + 1]!;
      } else {
        rgba[dst] = line[src]!; rgba[dst + 1] = line[src]!; rgba[dst + 2] = line[src]!; rgba[dst + 3] = 255;
      }
    }
    prev = line;
  }
  return { width, height, rgba };
}

/** Encode packed RGBA bytes into a deterministic standard 8-bit PNG. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines[y * (stride + 1)] = 0;
    scanlines.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = deflateSync(scanlines, { level: 6 });
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array(0)),
  ]));
}

/** Stitch an ordered sequence of PNG frames into a compact grid contact sheet with sequence progress bars for temporal VLM inspection. */
export function buildContactSheetPng(
  frames: Uint8Array[],
  options: { tileWidth?: number; tileHeight?: number; columns?: number } = {},
): { bytes: Uint8Array; width: number; height: number; validTiles: number } | null {
  const decoded = frames.map(decodePngRgba).filter((item): item is DecodedPng => item !== null);
  if (!decoded.length) return null;
  const cols = Math.max(1, Math.min(decoded.length, options.columns ?? (decoded.length <= 4 ? 2 : 3)));
  const rows = Math.ceil(decoded.length / cols);
  const pad = 8, header = 10;
  const tileW = options.tileWidth ?? 420;
  const aspect = decoded[0]!.height / Math.max(1, decoded[0]!.width);
  const tileH = options.tileHeight ?? Math.max(120, Math.round(tileW * aspect));
  const outW = cols * tileW + (cols + 1) * pad;
  const outH = rows * (tileH + header) + (rows + 1) * pad;
  const out = new Uint8Array(outW * outH * 4);
  for (let i = 0; i < outW * outH; i++) {
    out[i * 4] = 20; out[i * 4 + 1] = 22; out[i * 4 + 2] = 28; out[i * 4 + 3] = 255;
  }

  decoded.forEach((img, idx) => {
    const col = idx % cols, row = Math.floor(idx / cols);
    const ox = pad + col * (tileW + pad);
    const oy = pad + row * (tileH + header + pad);
    const progressW = Math.max(12, Math.round(((idx + 1) / decoded.length) * tileW));
    for (let y = 0; y < header - 2; y++) {
      for (let x = 0; x < tileW; x++) {
        const p = ((oy + y) * outW + (ox + x)) * 4;
        const active = x < progressW;
        out[p] = active ? 56 : 50;
        out[p + 1] = active ? 189 : 55;
        out[p + 2] = active ? 248 : 68;
        out[p + 3] = 255;
      }
    }
    for (let y = 0; y < tileH; y++) {
      const sy = Math.min(img.height - 1, Math.floor((y / tileH) * img.height));
      for (let x = 0; x < tileW; x++) {
        const sx = Math.min(img.width - 1, Math.floor((x / tileW) * img.width));
        const sp = (sy * img.width + sx) * 4;
        const dp = ((oy + header + y) * outW + (ox + x)) * 4;
        out[dp] = img.rgba[sp]!;
        out[dp + 1] = img.rgba[sp + 1]!;
        out[dp + 2] = img.rgba[sp + 2]!;
        out[dp + 3] = 255;
      }
    }
  });

  return { bytes: encodeRgbaPng(outW, outH, out), width: outW, height: outH, validTiles: decoded.length };
}
