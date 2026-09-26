// src/lib/vendor/qrcode.js — a small QR Code encoder (byte mode only) that returns an SVG string.
// Used by the Fix Kit (src/lib/fix-kit.js) for the "leave us a Google review" QR code.
//
// Pure JavaScript: no Node APIs, no canvas, no DOM, so it runs in the Workers runtime, in node --test
// and in a browser. Byte mode (UTF-8) only, versions 1-40, error correction L/M/Q/H (default M),
// mask picked by the standard penalty rules unless one is forced (tests compare fixed masks against
// an independent encoder).
//
// The algorithm and the error-correction tables follow Project Nayuki's "QR Code generator library"
// (https://www.nayuki.io/page/qr-code-generator-library), trimmed to what we need and rewritten in
// this repo's style. Its license:
//
//   Copyright (c) Project Nayuki. (MIT License)
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
//   and associated documentation files (the "Software"), to deal in the Software without
//   restriction, including without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
//   Software is furnished to do so, subject to the following conditions:
//   - The above copyright notice and this permission notice shall be included in all copies or
//     substantial portions of the Software.
//   - The Software is provided "as is", without warranty of any kind, express or implied,
//     including but not limited to the warranties of merchantability, fitness for a particular
//     purpose and noninfringement. In no event shall the authors or copyright holders be liable
//     for any claim, damages or other liability, whether in an action of contract, tort or
//     otherwise, arising from, out of or in connection with the Software or the use or other
//     dealings in the Software.

/** Error-correction levels: ord = table row, fmt = the 2 bits in the format information. */
const ECL = { L: { ord: 0, fmt: 1 }, M: { ord: 1, fmt: 0 }, Q: { ord: 2, fmt: 3 }, H: { ord: 3, fmt: 2 } };

// Per level (L, M, Q, H) and version (index 1-40): error-correction codewords per block ...
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// ... and the number of blocks.
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

/** Modules left for data + ECC after the function patterns, in bits. */
function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const numDataCodewords = (ver, e) =>
  Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e.ord][ver] * NUM_ERROR_CORRECTION_BLOCKS[e.ord][ver];

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(2^8), polynomial 0x11D
// ---------------------------------------------------------------------------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// ---------------------------------------------------------------------------
// the symbol
// ---------------------------------------------------------------------------
function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function newSymbol(ver) {
  const size = ver * 4 + 17;
  const grid = () => Array.from({ length: size }, () => new Array(size).fill(false));
  return { ver, size, modules: grid(), isFunc: grid() };
}

function setFunc(s, x, y, dark) {
  s.modules[y][x] = dark;
  s.isFunc[y][x] = true;
}

function drawFormatBits(s, e, mask) {
  const data = (e.fmt << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const n = s.size;
  for (let i = 0; i <= 5; i++) setFunc(s, 8, i, getBit(bits, i));
  setFunc(s, 8, 7, getBit(bits, 6));
  setFunc(s, 8, 8, getBit(bits, 7));
  setFunc(s, 7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) setFunc(s, 14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i++) setFunc(s, n - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) setFunc(s, 8, n - 15 + i, getBit(bits, i));
  setFunc(s, 8, n - 8, true); // the dark module
}

function drawVersion(s) {
  if (s.ver < 7) return;
  let rem = s.ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (s.ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = getBit(bits, i);
    const a = s.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunc(s, a, b, bit);
    setFunc(s, b, a, bit);
  }
}

function drawFunctionPatterns(s, e) {
  const n = s.size;
  for (let i = 0; i < n; i++) {
    setFunc(s, 6, i, i % 2 === 0);
    setFunc(s, i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < n && y >= 0 && y < n) setFunc(s, x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const pos = alignmentPositions(s.ver, n);
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFunc(s, pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(s, e, 0); // placeholder, redrawn once the mask is chosen
  drawVersion(s);
}

/** Data codewords → data + ECC, split into blocks and interleaved. */
function addEccAndInterleave(data, ver, e) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e.ord][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e.ord][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function drawCodewords(s, data) {
  const n = s.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!s.isFunc[y][x] && i < data.length * 8) {
          s.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** XOR a mask over the data modules (applying it twice undoes it). */
function applyMask(s, mask) {
  const f = MASKS[mask];
  for (let y = 0; y < s.size; y++) {
    for (let x = 0; x < s.size; x++) if (!s.isFunc[y][x] && f(x, y)) s.modules[y][x] = !s.modules[y][x];
  }
}

/** The standard penalty score (ISO/IEC 18004 section 7.8.3): lower is easier to scan. */
function penalty(s) {
  const n = s.size;
  const m = s.modules;
  let score = 0;
  const line = (get) => {
    let runColor = null;
    let run = 0;
    const bits = [];
    for (let i = 0; i < n; i++) {
      const c = get(i);
      bits.push(c ? 1 : 0);
      if (c === runColor) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else { runColor = c; run = 1; }
    }
    // Finder-like 1:1:3:1:1 with 4 light modules on one side (light beyond the edge counts).
    const at = (i) => (i < 0 || i >= n ? 0 : bits[i]);
    for (let i = -4; i < n; i++) {
      const core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
      if (!core) continue;
      const before = !at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4);
      const after = !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10);
      if (before || after) score += 40;
    }
  };
  for (let y = 0; y < n; y++) line((x) => m[y][x]);
  for (let x = 0; x < n; x++) line((y) => m[y][x]);
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * Text → QR matrix. opts: { ecl: 'L'|'M'|'Q'|'H' (default 'M'), mask: 0-7 (default: best),
 * minVersion (default 1) }. → { version, size, mask, modules: boolean[][] } (modules[y][x], true = dark).
 * Throws if the text doesn't fit in version 40.
 */
export function qrMatrix(text, opts = {}) {
  const e = ECL[opts.ecl || 'M'];
  if (!e) throw new Error(`qrMatrix: unknown error-correction level ${opts.ecl}`);
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = Math.max(1, opts.minVersion || 1);
  for (; ver <= 40; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    if (bytes.length < 2 ** countBits && 4 + countBits + bytes.length * 8 <= numDataCodewords(ver, e) * 8) break;
  }
  if (ver > 40) throw new Error('qrMatrix: text too long for a QR code');

  // Bit stream: mode (byte = 0100), count, data, terminator, pad to a byte, pad codewords.
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0x4, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = numDataCodewords(ver, e) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const s = newSymbol(ver);
  drawFunctionPatterns(s, e);
  drawCodewords(s, addEccAndInterleave(data, ver, e));

  let mask = opts.mask;
  if (mask == null) {
    let best = Infinity;
    for (let k = 0; k < 8; k++) {
      applyMask(s, k);
      drawFormatBits(s, e, k);
      const p = penalty(s);
      if (p < best) { best = p; mask = k; }
      applyMask(s, k);
    }
  }
  if (!(mask >= 0 && mask <= 7)) throw new Error('qrMatrix: mask must be 0-7');
  applyMask(s, mask);
  drawFormatBits(s, e, mask);
  return { version: ver, size: s.size, mask, modules: s.modules };
}

/**
 * Text → a standalone SVG QR code. opts: qrMatrix's, plus border (quiet zone in modules, default 4),
 * px (width/height attribute, default 512) and title (accessible name).
 */
export function qrSvg(text, opts = {}) {
  const { size, modules } = qrMatrix(text, opts);
  const border = opts.border ?? 4;
  const px = opts.px ?? 512;
  const dim = size + border * 2;
  // One path: each run of dark modules in a row is one rectangle.
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      let len = 1;
      while (x + len < size && modules[y][x + len]) len++;
      d += `M${x + border} ${y + border}h${len}v1h-${len}z`;
      x += len - 1;
    }
  }
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const title = opts.title ? `<title>${esc(opts.title)}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img">${title}`
    + `<rect width="100%" height="100%" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>\n`;
}
