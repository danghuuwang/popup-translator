// One-off icon generator. Builds 16/32/48/128 PNGs with a black rounded
// square background and a white "A" letter, plus a "→" hint, encoded
// with zlib deflate (no extra deps).

const fs = require("node:fs");
const zlib = require("node:zlib");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([typeBuf, data]));
  crc.writeUInt32BE(crcVal >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/** 5x7 font glyph for the letter "A" (1 = on, 0 = off). */
const A_GLYPH = [
  [0, 0, 1, 0, 0],
  [0, 1, 1, 1, 0],
  [1, 0, 0, 0, 1],
  [1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
];

const ARROW_GLYPH = [
  [1, 0, 0, 0, 1],
  [1, 1, 0, 0, 1],
  [0, 1, 1, 0, 1],
  [0, 0, 1, 1, 1],
  [0, 1, 1, 0, 1],
  [1, 1, 0, 0, 1],
  [1, 0, 0, 0, 1],
];

function paintGlyph(buf, w, scale, ox, oy, glyph, color) {
  for (let y = 0; y < glyph.length; y++) {
    for (let x = 0; x < glyph[0].length; x++) {
      if (!glyph[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ox + x * scale + dx;
          const py = oy + y * scale + dy;
          if (px < 0 || py < 0 || px >= w || py >= w) continue;
          const idx = (py * w + px) * 4;
          buf[idx] = color[0];
          buf[idx + 1] = color[1];
          buf[idx + 2] = color[2];
          buf[idx + 3] = 255;
        }
      }
    }
  }
}

function inRoundedRect(x, y, w, r) {
  if (x < r && y < r) return (r - x) ** 2 + (r - y) ** 2 <= r * r;
  if (x >= w - r && y < r) return (x - (w - 1 - r)) ** 2 + (r - y) ** 2 <= r * r;
  if (x < r && y >= w - r) return (r - x) ** 2 + (y - (w - 1 - r)) ** 2 <= r * r;
  if (x >= w - r && y >= w - r) return (x - (w - 1 - r)) ** 2 + (y - (w - 1 - r)) ** 2 <= r * r;
  return true;
}

function makePng(size) {
  const r = Math.floor(size * 0.22);
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = inRoundedRect(x, y, size, r);
      const idx = (y * size + x) * 4;
      if (!inside) {
        data[idx + 3] = 0;
        continue;
      }
      data[idx] = 17;
      data[idx + 1] = 17;
      data[idx + 2] = 17;
      data[idx + 3] = 255;
    }
  }
  const white = [250, 250, 250];
  const aScale = Math.max(2, Math.floor(size / 12));
  const aW = 5 * aScale;
  const aH = 7 * aScale;
  const aX = Math.floor((size - aW) / 2);
  const aY = Math.floor(size * 0.18);
  paintGlyph(data, size, aScale, aX, aY, A_GLYPH, white);

  const arrScale = Math.max(1, Math.floor(size / 22));
  const arrW = 5 * arrScale;
  const arrH = 7 * arrScale;
  const arrX = Math.floor((size - arrW) / 2);
  const arrY = Math.floor(size * 0.72);
  paintGlyph(data, size, arrScale, arrX, arrY, ARROW_GLYPH, [200, 200, 200]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    data.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = "src/icons";
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(`${outDir}/icon_${size}.png`, makePng(size));
  console.log(`wrote icon_${size}.png (${size}x${size})`);
}
