'use strict';
// Dependency-free PNG icon generator for the PWA (zlib + CRC32 only).
// Brand: gradient shield (#8fa3ef -> #2c3e50) with a white S on dark navy.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const BG = [11, 14, 20, 255];        // #0b0e14 app background
const SHIELD_TOP = [143, 163, 239];   // #8fa3ef
const SHIELD_BOT = [44, 62, 80];     // #2c3e50
const WHITE = [255, 255, 255, 255];

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, BG);

  const cx = size / 2, S = size;
  const top = 0.24 * S, mid = 0.60 * S, bot = 0.80 * S;
  const halfW = 0.24 * S, halfWTop = 0.20 * S;
  for (let y = 0; y < size; y++) {
    if (y < top || y > bot) continue;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      let hw;
      if (y <= mid) hw = halfWTop + ((halfW - halfWTop) * (y - top)) / (mid - top);
      else hw = halfW * (1 - (y - mid) / (bot - mid));
      const ax = Math.abs(dx);
      if (ax <= hw) {
        const t = (y - top) / (bot - top);
        put(x, y, [lerp(SHIELD_TOP[0], SHIELD_BOT[0], t), lerp(SHIELD_TOP[1], SHIELD_BOT[1], t), lerp(SHIELD_TOP[2], SHIELD_BOT[2], t)]);
      }
    }
  }

  // blocky white S centered in the shield
  const x1 = 0.37 * S, x2 = 0.63 * S, t = 0.05 * S;
  const bars = [0.40 * S, 0.50 * S, 0.60 * S];
  const rect = (rx, ry, rw, rh) => {
    for (let y = Math.round(ry); y < Math.round(ry + rh); y++)
      for (let x = Math.round(rx); x < Math.round(rx + rw); x++) put(x, y, WHITE);
  };
  rect(x1, bars[0], x2 - x1, t);            // top bar
  rect(x1, bars[0], t, bars[2] + t - bars[0]); // left vertical
  rect(x1, bars[1], x2 - x1, t);            // middle bar
  rect(x2 - t, bars[1], t, bars[2] + t - bars[1]); // right vertical
  rect(x1, bars[2], x2 - x1, t);            // bottom bar
  return png(size, size, px);
}

const outDir = path.join(__dirname, '..', 'public');
for (const size of [192, 512, 180]) {
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  fs.writeFileSync(path.join(outDir, name), drawIcon(size));
  console.log('wrote', name);
}
