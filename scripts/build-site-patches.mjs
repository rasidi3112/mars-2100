// Builds the sharper map patches shown around each landing site during entry
// (public/textures/mars/site-<id>-<color|normal>-<2k|1k>.jpg), from public-domain NASA/USGS data.
//
//   node scripts/build-site-patches.mjs --urls
//       prints the USGS map-service requests for the three colour crops (save each as site-<id>.jpg)
//   node scripts/build-site-patches.mjs <crops-dir> <megt90n000gb.img> <megt00n000gb.img>
//
// Sources:
// - Colour: USGS Astrogeology WMS, layer MDIM21_color (the same Viking MDIM 2.1 colourised mosaic as the
//   globe), cropped to each patch at 2048 × 2048. https://planetarymaps.usgs.gov/
// - Relief: NASA PDS MGS MOLA MEGDR at 64 px/degree, tiles megt90n000gb.img (90°N–0°) and megt00n000gb.img
//   (0°–90°S), both 0–180°E, 5760 × 11520 big-endian int16 metres.
//   https://pds-geosciences.wustl.edu/missions/mgs/megdr.html
// Patch bounds come from src/scene/sitePatches.ts, the same code the app uses to place them.
// Relief slopes are exaggerated ×4, like the globe (see scripts/build-mars-textures.mjs).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { SITES } = await import(join(ROOT, 'src', 'mission', 'sites.ts'));
const { patchAround } = await import(join(ROOT, 'src', 'scene', 'sitePatches.ts'));
const EXAGGERATION = 4;
const OUT = join(ROOT, 'public', 'textures', 'mars');

if (process.argv[2] === '--urls') {
  for (const site of SITES) {
    const p = patchAround(site.lat, site.lon);
    console.log(`site-${site.id}.jpg  https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mars/mars_simp_cyl.map&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=MDIM21_color&STYLES=&SRS=EPSG:4326&BBOX=${[p.west, p.south, p.east, p.north].join(',')}&WIDTH=2048&HEIGHT=2048&FORMAT=image/jpeg`);
  }
  process.exit(0);
}
const [cropsDir, northPath, southPath] = process.argv.slice(2);
if (!cropsDir || !northPath || !southPath) {
  console.error('Usage: node scripts/build-site-patches.mjs <crops-dir> <megt90n000gb.img> <megt00n000gb.img>  (or --urls)');
  process.exit(2);
}

// Both MOLA tiles as one grid: 11520 lines from 90°N to 90°S, 11520 samples from 0° to 180°E.
const LINES = 5760, SAMPLES = 11520, PPD = 64, RADIUS = 3396000;
const tiles = [northPath, southPath].map((path) => {
  const raw = readFileSync(path);
  if (raw.length !== LINES * SAMPLES * 2) throw new Error(`${path}: expected ${LINES * SAMPLES * 2} bytes, got ${raw.length}`);
  return raw;
});
const sample = (line, col) => {
  const l = Math.min(2 * LINES - 1, Math.max(0, line)), c = Math.min(SAMPLES - 1, Math.max(0, col));
  return tiles[l < LINES ? 0 : 1].readInt16BE(((l % LINES) * SAMPLES + c) * 2);
};
function heightAt(lat, lon) {
  if (lon < 0 || lon >= 180) throw new Error(`longitude ${lon} is outside the 0–180°E tiles`);
  const s = lon * PPD - 0.5, l = (90 - lat) * PPD - 0.5;
  const s0 = Math.floor(s), l0 = Math.floor(l), fs = s - s0, fl = l - l0;
  return (sample(l0, s0) * (1 - fs) + sample(l0, s0 + 1) * fs) * (1 - fl) + (sample(l0 + 1, s0) * (1 - fs) + sample(l0 + 1, s0 + 1) * fs) * fl;
}

// Known elevation (InSight landed at about −2,613 m), checked before anything is written.
const insight = heightAt(4.5, 135.6);
if (Math.abs(insight + 2613) > 150) throw new Error(`InSight site reads ${Math.round(insight)} m; the tiles are not read correctly`);

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

// Tangent-space normal map over the patch (red = east, green = north), like the globe's.
function normalMap(patch, size) {
  const K = 2;
  const latAt = (y) => patch.north - ((y + 0.5) / size) * (patch.north - patch.south);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) {
      sum += heightAt(patch.north - ((y + (j + 0.5) / K) / size) * (patch.north - patch.south), patch.west + ((x + (i + 0.5) / K) / size) * (patch.east - patch.west));
    }
    h[y * size + x] = sum / (K * K);
  }
  const dLon = (((patch.east - patch.west) / size) * Math.PI) / 180, dLat = (((patch.north - patch.south) / size) * Math.PI) / 180;
  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    const cos = Math.cos((latAt(y) * Math.PI) / 180);
    for (let x = 0; x < size; x++) {
      const e = h[y * size + Math.min(size - 1, x + 1)], w = h[y * size + Math.max(0, x - 1)];
      const n = h[Math.max(0, y - 1) * size + x], s = h[Math.min(size - 1, y + 1) * size + x];
      const spanX = (Math.min(size - 1, x + 1) - Math.max(0, x - 1)) * RADIUS * cos * dLon;
      const spanY = (Math.min(size - 1, y + 1) - Math.max(0, y - 1)) * RADIUS * dLat;
      let nx = (-EXAGGERATION * (e - w)) / spanX, ny = (-EXAGGERATION * (n - s)) / spanY, nz = 1;
      const length = Math.hypot(nx, ny, nz);
      nx /= length; ny /= length; nz /= length;
      const o = (y * size + x) * 3;
      rgb[o] = Math.round((nx * 0.5 + 0.5) * 255);
      rgb[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgb[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }
  return png(size, size, rgb);
}

const sips = (...args) => execFileSync('sips', args, { stdio: 'pipe' });
const work = mkdtempSync(join(tmpdir(), 'site-patches-'));
try {
  for (const site of SITES) {
    const patch = patchAround(site.lat, site.lon);
    const crop = join(cropsDir, `site-${site.id}.jpg`);
    for (const [label, size] of [['2k', 2048], ['1k', 1024]]) {
      sips('-z', String(size), String(size), '-s', 'format', 'jpeg', '-s', 'formatOptions', '84', crop, '--out', join(OUT, `site-${site.id}-color-${label}.jpg`));
      const normalPng = join(work, `normal-${site.id}-${label}.png`);
      writeFileSync(normalPng, normalMap(patch, size));
      sips('-s', 'format', 'jpeg', '-s', 'formatOptions', '94', normalPng, '--out', join(OUT, `site-${site.id}-normal-${label}.jpg`));
    }
    console.log(`wrote site-${site.id} patches (${patch.south.toFixed(2)}…${patch.north.toFixed(2)}°N, ${patch.west.toFixed(2)}…${patch.east.toFixed(2)}°E)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
