// Genera los íconos PNG de la PWA (192 y 512 px) sin dependencias: una billetera
// blanca sobre un degradado índigo-violeta, con antialiasing por supermuestreo.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../apps/wallet-app/public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// ¿El punto (x, y) en [0,1] está dentro de un rectángulo redondeado?
const inRound = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function shade(x, y, maskable) {
  // Fondo: el ícono "maskable" llena todo; el normal es un cuadrado redondeado.
  const inside = maskable || inRound(x, y, 0, 0, 1, 1, 0.22);
  if (!inside) return [0, 0, 0, 0];
  const t = (x + y) / 2;
  const bg = [79 + (124 - 79) * t, 70 + (58 - 70) * t, 229 + (237 - 229) * t];
  const s = maskable ? 0.8 : 1; // zona segura del ícono maskable
  const u = 0.5 + (x - 0.5) / s;
  const v = 0.5 + (y - 0.5) / s;
  // Billetera: cuerpo, solapa y botón.
  const body = inRound(u, v, 0.2, 0.3, 0.8, 0.74, 0.07);
  const flap = inRound(u, v, 0.56, 0.44, 0.86, 0.6, 0.06);
  const dot = (u - 0.66) ** 2 + (v - 0.52) ** 2 <= 0.028 ** 2;
  const top = inRound(u, v, 0.26, 0.24, 0.7, 0.34, 0.04);
  if (dot) return [...bg, 255];
  if (flap) return [235, 233, 255, 255];
  if (body) return [255, 255, 255, 255];
  if (top) return [199, 196, 255, 255];
  return [...bg, 255];
}

function png(size, maskable) {
  const SS = 4; // supermuestreo para bordes suaves
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, maskable);
          acc[0] += c[0] * c[3];
          acc[1] += c[1] * c[3];
          acc[2] += c[2] * c[3];
          acc[3] += c[3];
        }
      }
      const a = acc[3] / (SS * SS);
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      raw[o + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      raw[o + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      raw[o + 3] = Math.round(a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`icon-${size}.png`, OUT), png(size, false));
  writeFileSync(new URL(`maskable-${size}.png`, OUT), png(size, true));
}
console.log('Íconos generados en apps/wallet-app/public/icons');
