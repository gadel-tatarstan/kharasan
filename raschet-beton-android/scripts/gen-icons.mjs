import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/icons');

const table = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, painter) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const px = painter(x + 0.5, y + 0.5, size);
      const o = y * stride + 1 + x * 4;
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
      raw[o + 3] = px[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgb = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const insidePoly = (px, py, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const insideRounded = (x, y, size, r) => {
  if (r <= 0) return true;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return Math.hypot(x - cx, y - cy) <= r;
};

const TOP = rgb('#ffb27a');
const LEFT = rgb('#e05f18');
const RIGHT = rgb('#b8460f');
const BG = rgb('#0f1620');
const ACCENT_BG = rgb('#ff7a2f');

function painter({ bg, scale = 1, radius = 0.22, cubeColor = true }) {
  const cube = (s) => {
    const m = (x, y) => [(0.5 + (x - 0.5) / scale) * s, (0.5 + (y - 0.5) / scale) * s];
    return [
      { color: TOP, pts: [m(0.5, 0.2), m(0.84, 0.38), m(0.5, 0.56), m(0.16, 0.38)] },
      { color: LEFT, pts: [m(0.16, 0.38), m(0.5, 0.56), m(0.5, 0.84), m(0.16, 0.66)] },
      { color: RIGHT, pts: [m(0.5, 0.56), m(0.84, 0.38), m(0.84, 0.66), m(0.5, 0.84)] },
    ];
  };
  return (x, y, size) => {
    if (!insideRounded(x, y, size, radius * size)) return [0, 0, 0, 0];
    let color = bg;
    if (cubeColor) {
      for (const face of cube(size)) {
        if (insidePoly(x, y, face.pts)) color = face.color;
      }
    }
    return [...color, 255];
  };
}

mkdirSync(outDir, { recursive: true });

const files = [
  ['icon-192.png', 192, { bg: BG }],
  ['icon-512.png', 512, { bg: BG }],
  ['maskable-512.png', 512, { bg: ACCENT_BG, scale: 0.72, radius: 0, cubeSafe: true }],
  ['apple-touch-icon.png', 180, { bg: BG, radius: 0.001 }],
];

for (const [name, size, cfg] of files) {
  const png = encodePng(size, painter(cfg));
  writeFileSync(resolve(outDir, name), png);
  console.log(`wrote ${name} (${size}px, ${(png.length / 1024).toFixed(1)} kB)`);
}
