#!/usr/bin/env node
// Generates placeholder app/tray icons (PNG) without external tools.
// Replace build/icon.png (1024x1024) with real artwork before the event.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
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
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Rounded square, blue gradient, white check mark.
function appIcon(u, v) {
  const r = 0.2;
  const dx = Math.max(0, Math.abs(u - 0.5) - (0.5 - r) + 0.04);
  const dy = Math.max(0, Math.abs(v - 0.5) - (0.5 - r) + 0.04);
  if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0];
  const onLine = (ax, ay, bx, by, w) => {
    const t = Math.max(
      0,
      Math.min(
        1,
        ((u - ax) * (bx - ax) + (v - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2),
      ),
    );
    return Math.hypot(u - (ax + t * (bx - ax)), v - (ay + t * (by - ay))) < w;
  };
  if (onLine(0.28, 0.52, 0.44, 0.68, 0.055) || onLine(0.44, 0.68, 0.74, 0.34, 0.055))
    return [255, 255, 255, 255];
  return [Math.round(20 + 30 * v), Math.round(110 + 60 * (1 - v)), Math.round(220 + 30 * u), 255];
}

// Tray: solid dot (template-friendly on macOS), plus colored state variants.
const dot = (rgb) => (u, v) => (Math.hypot(u - 0.5, v - 0.5) < 0.42 ? [...rgb, 255] : [0, 0, 0, 0]);

const out = (p, buf) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
};
out(resolve(root, 'build/icon.png'), png(1024, appIcon));
out(resolve(root, 'resources/icon.png'), png(256, appIcon));
out(resolve(root, 'resources/trayTemplate.png'), png(16, dot([0, 0, 0])));
out(resolve(root, 'resources/trayTemplate@2x.png'), png(32, dot([0, 0, 0])));
out(resolve(root, 'resources/tray-ok.png'), png(32, dot([34, 160, 90])));
out(resolve(root, 'resources/tray-warn.png'), png(32, dot([230, 160, 20])));
out(resolve(root, 'resources/tray-bad.png'), png(32, dot([220, 50, 50])));
console.log('icons written');
