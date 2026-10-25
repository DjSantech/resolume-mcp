// Imágenes mínimas válidas para el simulador: miniaturas PNG y capturas JPEG, generadas sin dependencias.

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** PNG RGB con un degradado horizontal del color dado hacia negro. */
export function gradientPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // sin filtro
    for (let x = 0; x < width; x++) {
      const k = 1 - (x / width) * 0.7;
      raw[row + 1 + x * 3] = Math.round(rgb[0] * k);
      raw[row + 2 + x * 3] = Math.round(rgb[1] * k);
      raw[row + 3 + x * 3] = Math.round(rgb[2] * k);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * JPEG baseline en escala de grises de un solo tono. Cada bloque 8×8 solo lleva coeficiente DC,
 * así que basta con dos tablas Huffman mínimas.
 */
export function solidJpeg(width: number, height: number, gray: number): Buffer {
  const dc = 8 * (Math.max(0, Math.min(255, Math.round(gray))) - 128);
  const cat = dc === 0 ? 0 : Math.floor(Math.log2(Math.abs(dc))) + 1;

  const seg = (marker: number, data: number[]) => {
    const len = data.length + 2;
    return [0xff, marker, len >> 8, len & 0xff, ...data];
  };
  const bits16 = (counts: Record<number, number>) => Array.from({ length: 16 }, (_, i) => counts[i + 1] ?? 0);

  // DC: categoría 0 → "0"; categoría del primer bloque → "10". AC: solo EOB → "0".
  const dcTable = cat === 0 ? [0x00, ...bits16({ 1: 1 }), 0] : [0x00, ...bits16({ 1: 1, 2: 1 }), 0, cat];
  const acTable = [0x10, ...bits16({ 1: 1 }), 0x00];

  // Datos de entropía.
  let bitStr = "";
  if (cat > 0) {
    const v = dc > 0 ? dc : dc + (1 << cat) - 1;
    bitStr += "10" + v.toString(2).padStart(cat, "0") + "0";
  } else {
    bitStr += "00";
  }
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  bitStr += "00".repeat(blocks - 1);
  while (bitStr.length % 8) bitStr += "1";
  const scan: number[] = [];
  for (let i = 0; i < bitStr.length; i += 8) {
    const b = parseInt(bitStr.slice(i, i + 8), 2);
    scan.push(b);
    if (b === 0xff) scan.push(0x00);
  }

  return Buffer.from([
    0xff, 0xd8,
    ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    ...seg(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
    ...seg(0xc0, [0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]),
    ...seg(0xc4, dcTable),
    ...seg(0xc4, acTable),
    ...seg(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    ...scan,
    0xff, 0xd9,
  ]);
}

/** Color estable a partir de un id (para que cada clip tenga su miniatura). */
export function colorFor(id: number): [number, number, number] {
  const h = (id * 47) % 360;
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)) * 0.75));
  };
  return [f(5), f(3), f(1)];
}
