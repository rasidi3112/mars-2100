// Rebuilds the globe textures in public/textures/mars/ from public-domain NASA/USGS data.
//
//   node scripts/build-mars-textures.mjs <viking-colour.jpg> <megt90n000eb.img>
//
// Sources (download them yourself; they are not kept in the repository):
// - Colour: USGS Astrogeology, "Mars Viking Colorized Global Mosaic 232m" (NASA Ames, Viking MDIM 2.1),
//   ancillary file mars_viking_mdim21_clrmosaic_1km.jpg (36.7 MB, 21339 × 10670, simple cylindrical,
//   180°W at the left edge). https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m
// - Relief: NASA PDS Geosciences Node, MGS MOLA MEGDR megt90n000eb.img (33.2 MB): 5760 × 2880 big-endian
//   int16 metres above the areoid, 16 px/degree, 0°E at the left edge, first line at the north pole.
//   https://pds-geosciences.wustl.edu/missions/mgs/megdr.html
//
// Output, for 4096 × 2048 (desktop) and 2048 × 1024 (phones):
// - mars-color-<4k|2k>.jpg: the colour mosaic, resized (macOS `sips`).
// - mars-normal-<4k|2k>.jpg: tangent-space normal map (OpenGL convention: red = east, green = north),
//   slopes exaggerated EXAGGERATION times so craters and volcanoes read on a small globe.
// The app says so in `approach.footnote` and `sources.intro`; change those texts if you change it.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

const EXAGGERATION = 4;
const [colourPath, molaPath] = process.argv.slice(2);
if (!colourPath || !molaPath) {
  console.error('Usage: node scripts/build-mars-textures.mjs <viking-colour.jpg> <megt90n000eb.img>');
  process.exit(2);
}
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures', 'mars');
const sips = (...args) => execFileSync('sips', args, { stdio: 'pipe' });

const SW = 5760, SH = 2880, PPD = 16, RADIUS = 3396000;
const raw = readFileSync(molaPath);
if (raw.length !== SW * SH * 2) throw new Error(`Expected ${SW * SH * 2} bytes in the MOLA file, got ${raw.length}`);
const mola = new Float32Array(SW * SH);
for (let i = 0; i < SW * SH; i++) mola[i] = raw.readInt16BE(i * 2);

// Height at a planetocentric latitude/longitude (degrees, east positive), bilinear, wrapping in longitude.
function heightAt(lat, lon) {
  const s = (((lon % 360) + 360) % 360) * PPD - 0.5;
  const l = Math.min(SH - 1, Math.max(0, (90 - lat) * PPD - 0.5));
  const s0 = Math.floor(s), l0 = Math.floor(l), fs = s - s0, fl = l - l0;
  const l1 = Math.min(SH - 1, l0 + 1);
  const at = (row, col) => mola[row * SW + (((col % SW) + SW) % SW)];
  return (at(l0, s0) * (1 - fs) + at(l0, s0 + 1) * fs) * (1 - fl) + (at(l1, s0) * (1 - fs) + at(l1, s0 + 1) * fs) * fl;
}

function png(width, height, rgb) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function normalMap(W) {
  const H = W / 2, K = 4;
  // Heights averaged over each output pixel (K × K samples) so the smaller map does not alias.
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) sum += heightAt(90 - ((y + (j + 0.5) / K) * 180) / H, -180 + ((x + (i + 0.5) / K) * 360) / W);
    h[y * W + x] = sum / (K * K);
  }
  const dLon = ((360 / W) * Math.PI) / 180, dLat = ((180 / H) * Math.PI) / 180;
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const lat = ((90 - ((y + 0.5) * 180) / H) * Math.PI) / 180;
    const cos = Math.max(Math.cos(lat), 0.02);
    // East–west spacing collapses near the poles: fade the relief to flat within 5° of them.
    const fade = Math.min(1, Math.max(0, (Math.PI / 2 - Math.abs(lat)) / ((5 * Math.PI) / 180)));
    for (let x = 0; x < W; x++) {
      const slopeEast = (h[y * W + ((x + 1) % W)] - h[y * W + ((x - 1 + W) % W)]) / (2 * RADIUS * cos * dLon);
      const slopeNorth = (h[Math.max(0, y - 1) * W + x] - h[Math.min(H - 1, y + 1) * W + x]) / (2 * RADIUS * dLat);
      let nx = -EXAGGERATION * slopeEast * fade, ny = -EXAGGERATION * slopeNorth * fade, nz = 1;
      const length = Math.hypot(nx, ny, nz);
      nx /= length; ny /= length; nz /= length;
      const o = (y * W + x) * 3;
      rgb[o] = Math.round((nx * 0.5 + 0.5) * 255);
      rgb[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgb[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }
  return png(W, H, rgb);
}

// Known elevations must come out right, or the longitude shift / orientation is wrong.
const checks = [['InSight landing site', 4.5, 135.6, -2613, 150], ['Olympus Mons summit area', 18.65, -133.8, 21000, 1500]];
for (const [name, lat, lon, expected, tolerance] of checks) {
  const value = heightAt(lat, lon);
  if (Math.abs(value - expected) > tolerance) throw new Error(`${name}: ${Math.round(value)} m, expected about ${expected} m`);
}

const work = mkdtempSync(join(tmpdir(), 'mars-textures-'));
try {
  for (const [label, W] of [['4k', 4096], ['2k', 2048]]) {
    sips('-z', String(W / 2), String(W), '-s', 'format', 'jpeg', '-s', 'formatOptions', '84', colourPath, '--out', join(OUT, `mars-color-${label}.jpg`));
    const normalPng = join(work, `normal-${label}.png`);
    writeFileSync(normalPng, normalMap(W));
    sips('-s', 'format', 'jpeg', '-s', 'formatOptions', '94', normalPng, '--out', join(OUT, `mars-normal-${label}.jpg`));
    console.log(`wrote mars-color-${label}.jpg and mars-normal-${label}.jpg`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
