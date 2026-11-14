import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/**
 * 외부 이미지 라이브러리 없이 PWA 아이콘 PNG를 생성한다.
 * 512/192/180 크기의 보라색 배경 + 흰 말풍선 아이콘.
 */
const VIOLET = [124, 58, 237];
const WHITE = [255, 255, 255];
const SCALE = 2;

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const clampX = Math.max(left + radius, Math.min(right - radius, x));
  const clampY = Math.max(top + radius, Math.min(bottom - radius, y));
  const dx = x - clampX;
  const dy = y - clampY;
  return dx * dx + dy * dy <= radius * radius;
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const sign = (x1, y1, x2, y2, x3, y3) =>
    (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function paint(size) {
  const big = size * SCALE;
  const pixels = Buffer.alloc(big * big * 3);
  const set = (x, y, color) => {
    const offset = (y * big + x) * 3;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
  };

  const bubble = {
    left: big * 0.25,
    right: big * 0.75,
    top: big * 0.29,
    bottom: big * 0.62,
    radius: big * 0.09,
  };
  const dots = [
    [big * 0.38, big * 0.455],
    [big * 0.5, big * 0.455],
    [big * 0.62, big * 0.455],
  ];

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      let color = VIOLET;
      const inBubble = insideRoundedRect(
        x,
        y,
        bubble.left,
        bubble.top,
        bubble.right,
        bubble.bottom,
        bubble.radius,
      );
      const inTail = insideTriangle(
        x,
        y,
        big * 0.34,
        big * 0.58,
        big * 0.3,
        big * 0.72,
        big * 0.46,
        big * 0.62,
      );
      if (inBubble || inTail) color = WHITE;
      for (const [cx, cy] of dots) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= (big * 0.033) ** 2) color = VIOLET;
      }
      set(x, y, color);
    }
  }

  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0];
      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          const offset = ((y * SCALE + sy) * big + (x * SCALE + sx)) * 3;
          totals[0] += pixels[offset];
          totals[1] += pixels[offset + 1];
          totals[2] += pixels[offset + 2];
        }
      }
      const offset = (y * size + x) * 3;
      rgb[offset] = Math.round(totals[0] / (SCALE * SCALE));
      rgb[offset + 1] = Math.round(totals[1] / (SCALE * SCALE));
      rgb[offset + 2] = Math.round(totals[2] / (SCALE * SCALE));
    }
  }
  return encodePng(size, size, rgb);
}

for (const [size, file] of [
  [512, "client/public/icon-512.png"],
  [192, "client/public/icon-192.png"],
  [180, "client/public/apple-touch-icon.png"],
]) {
  writeFileSync(file, paint(size));
  console.log(`[icons] ${file}`);
}
