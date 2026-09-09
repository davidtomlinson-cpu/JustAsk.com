// One-off icon generator — writes flat brand-colour PNGs at every size the
// manifest/head tags need, with no image-library dependency (hand-rolled
// PNG encoder via zlib). Swap public/icons/icon-source.svg for real artwork
// later and re-export properly; these are placeholders so the PWA installs
// cleanly out of the box.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData));
  return Buffer.concat([len, typeData, crc]);
}

// Simple two-tone icon: brand-gradient-ish flat purple square with a
// lighter rounded "page" motif — good enough as an installable-app
// placeholder, not meant as final artwork.
function makePng(size) {
  const bg = [79, 70, 229]; // #4F46E5
  const fg = [238, 240, 253]; // light page shape
  const raw = Buffer.alloc(size * (1 + size * 4));
  const margin = Math.round(size * 0.22);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const inPage = x > margin && x < size - margin && y > margin * 0.8 && y < size - margin * 0.8;
      const [r, g, b] = inPage ? fg : bg;
      const off = rowStart + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 32, 152, 167, 180, 192, 384, 512];
for (const size of sizes) {
  fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), makePng(size));
}
fs.writeFileSync(path.join(OUT_DIR, 'icon-maskable-512.png'), makePng(512));
console.log('Icons written to', OUT_DIR);
