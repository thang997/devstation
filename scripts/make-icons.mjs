// Sinh icon DevStation: nền tối bo góc + dấu nhắc terminal ">_" (xanh dương + xanh lá).
// Chạy: node scripts/make-icons.mjs
// Ghi ra src-tauri/icons/icon.ico (16..256, PNG nhúng) và public/favicon.png (256).
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SS = 4; // supersample để khử răng cưa

const ACCENT = [79, 140, 255];
const GREEN = [63, 185, 80];

/* ── Hình học (toạ độ chuẩn hoá 0..1) ─────────── */

const roundRect = (x, y, r) => {
  // Khoảng cách có dấu tới hình chữ nhật bo góc phủ kín 0..1 (tâm ở 0.5).
  const qx = Math.abs(x - 0.5) - (0.5 - r);
  const qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const capsule = (x, y, ax, ay, bx, by, w) => {
  // Khoảng cách tới đoạn thẳng AB, trừ nửa độ dày.
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  return Math.hypot(pax - bax * t, pay - bay * t) - w;
};

// Ẩn số pixel: khử răng cưa bằng cách lấy trung bình SS×SS mẫu, nên ở đây chỉ cần cắt cứng.
const hit = (d) => (d <= 0 ? 1 : 0);

/** Vẽ icon ở độ phân giải S (đã supersample), trả mảng RGBA 8-bit. */
function render(S) {
  const N = S * SS;
  const buf = new Float64Array(N * N * 4); // RGBA, đã nhân trước alpha
  const chevron = [
    [0.27, 0.285, 0.585, 0.5],
    [0.585, 0.5, 0.27, 0.715],
  ];
  const bar = [0.635, 0.715, 0.8, 0.715];

  for (let py = 0; py < N; py++) {
    const y = (py + 0.5) / N;
    for (let px = 0; px < N; px++) {
      const x = (px + 0.5) / N;
      const i = (py * N + px) * 4;

      // Vẽ chồng theo thứ tự nền → ">" → "_" (source-over, màu đã nhân alpha).
      const over = (r, g, b, a) => {
        if (a <= 0) return;
        const da = buf[i + 3];
        const na = a + da * (1 - a);
        buf[i] = (r * a + buf[i] * (1 - a));
        buf[i + 1] = (g * a + buf[i + 1] * (1 - a));
        buf[i + 2] = (b * a + buf[i + 2] * (1 - a));
        buf[i + 3] = na;
      };

      // Nền: gradient dọc #2b2d31 → #15161a, bo góc 22%.
      const t = y;
      over(
        (0x2b + (0x15 - 0x2b) * t) / 255,
        (0x2d + (0x16 - 0x2d) * t) / 255,
        (0x31 + (0x1a - 0x31) * t) / 255,
        hit(roundRect(x, y, 0.22)),
      );

      // Dấu nhắc ">" — hai nét dày, đầu tròn, sáng hơn ở trên.
      let a = 0;
      for (const [ax, ay, bx, by] of chevron) a = Math.max(a, hit(capsule(x, y, ax, ay, bx, by, 0.075)));
      const k = 0.88 + 0.12 * (1 - y);
      over((ACCENT[0] * k) / 255, (ACCENT[1] * k) / 255, (ACCENT[2] * k) / 255, a);

      // Dấu gạch dưới "_" màu xanh lá.
      over(GREEN[0] / 255, GREEN[1] / 255, GREEN[2] / 255, hit(capsule(x, y, bar[0], bar[1], bar[2], bar[3], 0.055)));
    }
  }

  // Thu nhỏ SS×SS (cộng alpha đã nhân trước) → S×S.
  const out = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const o = (y * S + x) * 4;
      if (a > 0) {
        out[o] = Math.round((r / a) * 255);
        out[o + 1] = Math.round((g / a) * 255);
        out[o + 2] = Math.round((b / a) * 255);
      }
      out[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return out;
}

/* ── PNG ──────────────────────────────────────── */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function png(S, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10,11,12 = 0 (deflate, không filter, không interlace)
  const raw = Buffer.alloc(S * (S * 4 + 1)); // mỗi dòng có 1 byte filter = 0
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── ICO (các entry là PNG nhúng, Windows Vista+ đọc được) ── */

function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // 1 = icon
  head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = head.length + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.data)]);
}

/* ── ICNS (macOS; mỗi entry là PNG nhúng, macOS 10.7+ đọc được) ── */

function icns(entries) {
  // entries: [{ type: "ic07", data }]. Mỗi entry: type (4) + length (4, tính cả 8 byte) + data.
  const parts = [];
  for (const { type, data } of entries) {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    parts.push(head, data);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/* ── Ghi file ─────────────────────────────────── */

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = SIZES.map((size) => ({ size, data: png(size, render(size)) }));

const out = (name) => join(ROOT, "src-tauri/icons", name);
mkdirSync(join(ROOT, "src-tauri/icons"), { recursive: true });

// Windows
writeFileSync(out("icon.ico"), ico(entries));
writeFileSync(join(ROOT, "public/favicon.png"), entries.at(-1).data);

// Linux (Tauri đọc bộ PNG chuẩn này)
const pngAt = (size) => png(size, render(size));
writeFileSync(out("32x32.png"), pngAt(32));
writeFileSync(out("128x128.png"), pngAt(128));
writeFileSync(out("128x128@2x.png"), pngAt(256));
writeFileSync(out("icon.png"), pngAt(512));

// macOS (.icns nhúng PNG, đủ kích thước cho Dock/Retina)
writeFileSync(
  out("icon.icns"),
  icns([
    { type: "ic07", data: pngAt(128) }, // 128×128
    { type: "ic08", data: pngAt(256) }, // 256×256
    { type: "ic09", data: pngAt(512) }, // 512×512
  ]),
);

console.log(`Đã ghi icon.ico (${SIZES.join(", ")}), PNG 32/128/256/512, icon.icns, public/favicon.png`);
