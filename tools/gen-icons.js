'use strict';
// Dependency-free PNG icon generator for the PWA (zlib + CRC32 only).
// Dark cybersecurity bg (#0B0D12), purple shield (#8B5CF6), cyan accent (#00C2FF).
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

const BG = [11, 13, 18, 255];       // #0B0D12
const SURFACE = [19, 31, 43, 255];  // #131720
const SHIELD = [139, 92, 246, 255]; // #8B5CF6
const CYAN = [0, 194, 255, 255];    // #00C2FF
const WHITE = [244, 245, 247, 255]; // #F4F5F7

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, c) => {
    const i = (y * size + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  };
  const bg = SURFACE;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, bg);

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
        const edge = ax > hw - Math.max(1, size * 0.018);
        const band = y > top + size * 0.10 && y < top + size * 0.175 && ax <= hw - size * 0.10;
        put(x, y, edge ? WHITE : band ? CYAN : SHIELD);
      }
    }
  }
  return png(size, size, px);
}

const outDir = path.join(__dirname, '..', 'public');
for (const size of [192, 512, 180]) {
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  fs.writeFileSync(path.join(outDir, name), drawIcon(size));
  console.log('wrote', name);
}
