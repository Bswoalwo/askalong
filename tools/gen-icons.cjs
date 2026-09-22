/**
 * 随问 AskAlong · 图标生成脚本(零依赖,Node 内置 zlib 手写 PNG 编码)
 * 图案:靛紫渐变圆角方块 + 白色对话气泡 + 三个紫点。
 * 运行:node tools/gen-icons.cjs
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------------- PNG 编码 ---------------- */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 图案绘制 ---------------- */

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, x - (x1 - r), 0);
  const dy = Math.max(y0 + r - y, y - (y1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(px, py, a, b, c) {
  const sign = (o1, o2, o3) => (o1[0] - o3[0]) * (o2[1] - o3[1]) - (o2[0] - o3[0]) * (o1[1] - o3[1]);
  const d1 = sign(a, b, [px, py]), d2 = sign(b, c, [px, py]), d3 = sign(c, a, [px, py]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// 归一化坐标(0..1)下定义形状,方便任意尺寸渲染
const SHAPE = {
  bg: { x0: 0.03, y0: 0.03, x1: 0.97, y1: 0.97, r: 0.225 },
  bubble: { x0: 0.22, y0: 0.27, x1: 0.78, y1: 0.66, r: 0.13 },
  tail: [[0.28, 0.62], [0.41, 0.62], [0.28, 0.80]],
  dots: [
    { cx: 0.375, cy: 0.465, r: 0.045 },
    { cx: 0.5, cy: 0.465, r: 0.045 },
    { cx: 0.625, cy: 0.465, r: 0.045 }
  ]
};

const GRAD_FROM = [99, 102, 241];  // #6366f1
const GRAD_TO = [168, 85, 247];    // #a855f7
const DOT_COLOR = [109, 40, 217];  // #6d28d9

function sample(u, v, size) {
  const x = u * size, y = v * size;
  const { bg, bubble, tail, dots } = SHAPE;

  if (!inRoundedRect(u, v, bg.x0, bg.y0, bg.x1, bg.y1, bg.r)) return [0, 0, 0, 0];

  const t = Math.min(1, Math.max(0, (u + v) / 2));
  const grad = [
    lerp(GRAD_FROM[0], GRAD_TO[0], t),
    lerp(GRAD_FROM[1], GRAD_TO[1], t),
    lerp(GRAD_FROM[2], GRAD_TO[2], t)
  ];

  if (inRoundedRect(u, v, bubble.x0, bubble.y0, bubble.x1, bubble.y1, bubble.r)) {
    for (const d of dots) {
      if ((x - d.cx * size) ** 2 + (y - d.cy * size) ** 2 <= (d.r * size) ** 2) return [...DOT_COLOR, 255];
    }
    return [255, 255, 255, 255];
  }
  if (inTriangle(u, v, ...tail)) return [255, 255, 255, 255];

  return [...grad, 255];
}

function renderIcon(size, ss) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (px + (sx + 0.5) / ss) / size;
          const v = (py + (sy + 0.5) / ss) / size;
          const c = sample(u, v, size);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = ss * ss;
      const o = (py * size + px) * 4;
      rgba[o] = Math.round(r / n);
      rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n);
      rgba[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const [size, ss] of [[16, 6], [48, 4], [128, 3]]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), renderIcon(size, ss));
  console.log(`icon${size}.png done`);
}
