#!/usr/bin/env python3
"""Rebuilds the Earth textures in public/textures/earth/ from NASA imagery.

    python3 scripts/build-earth-textures.py [work-dir]

Needs Python 3.9+, Pillow and numpy (pip install pillow numpy) and network access to
gibs.earthdata.nasa.gov. Downloads are cached in the work directory (default: .earth-cache/,
which is git-ignored), so a second run does not fetch them again.

Everything comes from NASA's Global Imagery Browse Services (GIBS), the public WMS endpoint
https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi (no key needed):

- BlueMarble_ShadedRelief_Bathymetry: Blue Marble: Next Generation with shaded relief and ocean
  depth (NASA Earth Observatory, MODIS, 500 m). Day side of the globe and the wide launch maps.
- VIIRS_Black_Marble (2016): Suomi NPP night lights composite. Night side of the globe.
- VIIRS_SNPP_CorrectedReflectance_TrueColor (one day, CLOUD_DATE): a real day of weather seen by
  Suomi NPP. Only its bright, colourless pixels are kept, as a cloud cover map.
- Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual (2000): Landsat 7 annual composite
  (NASA/USGS WELD, 30 m). The ground around NASA Kennedy Space Center's Launch Complex 39B.

Output (all equirectangular, north up; the globe maps start at 180°W like the Mars maps):
- earth-color-<4k|2k>.jpg        day colour
- earth-night-<2k|1k>.jpg        night lights
- earth-clouds-<4k|2k>.jpg       cloud cover, white = cloud (MODELLED from one observed day)
- launch-near-<2k|1k>.jpg        Landsat, NEAR box around the pad
- launch-mid-<2k|1k>.jpg         Blue Marble, MID box (Florida)
- launch-far-<2k|1k>.jpg         Blue Marble, FAR box (western Atlantic)
The boxes are repeated in src/scene/earthData.ts; change both together.
"""

import io
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'textures' / 'earth'
WORK = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.earth-cache'
WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'

# NASA Kennedy Space Center, Launch Complex 39B (pad centre).
PAD_LAT, PAD_LON = 28.6272, -80.6208
CLOUD_DATE = '2021-03-20'  # equinox: both poles are lit

# (south, west, north, east) in degrees. Keep in sync with src/scene/earthData.ts.
NEAR = (PAD_LAT - 0.2, PAD_LON - 0.2278, PAD_LAT + 0.2, PAD_LON + 0.2278)
MID = (PAD_LAT - 3.0, PAD_LON - 3.4, PAD_LAT + 3.0, PAD_LON + 3.4)
FAR = (8.0, -100.0, 48.0, -52.0)


def fetch(name, layer, box, width, height, time_value=None, fmt='image/jpeg'):
    """One WMS GetMap request, cached on disk. box = (south, west, north, east)."""
    WORK.mkdir(parents=True, exist_ok=True)
    path = WORK / name
    if path.exists() and path.stat().st_size > 2000:
        return Image.open(path).convert('RGB')
    params = {
        'SERVICE': 'WMS', 'REQUEST': 'GetMap', 'VERSION': '1.3.0', 'CRS': 'EPSG:4326', 'STYLES': '',
        'LAYERS': layer, 'FORMAT': fmt, 'WIDTH': width, 'HEIGHT': height,
        # WMS 1.3.0 with EPSG:4326 orders the box as minLat, minLon, maxLat, maxLon.
        'BBOX': ','.join(f'{v:.6f}' for v in box),
    }
    if time_value:
        params['TIME'] = time_value
    url = WMS + '?' + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'earth-texture-build'}), timeout=180) as response:
                data = response.read()
            image = Image.open(io.BytesIO(data))
            image.load()
            path.write_bytes(data)
            print(f'  fetched {name} ({len(data) // 1024} KB)')
            return image.convert('RGB')
        except Exception as error:  # noqa: BLE001 - retry any network or decode error
            print(f'  retry {name}: {error}')
            time.sleep(2 ** attempt * 2)
    raise SystemExit(f'Could not fetch {name} from GIBS')


def fetch_tiled(name, layer, box, width, height, time_value=None, tile=2048):
    """Large maps are requested in tiles of at most `tile` pixels and stitched."""
    south, west, north, east = box
    canvas = Image.new('RGB', (width, height))
    for ty in range(0, height, tile):
        for tx in range(0, width, tile):
            w, h = min(tile, width - tx), min(tile, height - ty)
            sub = (
                north - (ty + h) / height * (north - south), west + tx / width * (east - west),
                north - ty / height * (north - south), west + (tx + w) / width * (east - west),
            )
            canvas.paste(fetch(f'{name}-{tx}-{ty}.jpg', layer, sub, w, h, time_value), (tx, ty))
    return canvas


def save(image, name, quality=86):
    OUT.mkdir(parents=True, exist_ok=True)
    image.save(OUT / name, 'JPEG', quality=quality, optimize=True, progressive=True)
    print(f'wrote {name}: {image.size[0]}x{image.size[1]}, {(OUT / name).stat().st_size // 1024} KB')


def sizes(image, stem, widths, quality=86):
    for label, width in widths:
        height = round(width * image.size[1] / image.size[0])
        save(image if image.size[0] == width else image.resize((width, height), Image.LANCZOS), f'{stem}-{label}.jpg', quality)


def build_globe():
    world = (-90, -180, 90, 180)
    print('Day colour (Blue Marble)')
    day = fetch_tiled('day', 'BlueMarble_ShadedRelief_Bathymetry', world, 4096, 2048)
    sizes(day, 'earth-color', [('4k', 4096), ('2k', 2048)], 88)

    print('Night lights (Black Marble 2016)')
    night = fetch_tiled('night', 'VIIRS_Black_Marble', world, 4096, 2048, '2016-01-01')
    sizes(night.resize((2048, 1024), Image.LANCZOS), 'earth-night', [('2k', 2048), ('1k', 1024)], 84)

    print(f'Cloud cover (VIIRS true colour, {CLOUD_DATE})')
    viirs = np.asarray(fetch_tiled('viirs', 'VIIRS_SNPP_CorrectedReflectance_TrueColor', world, 4096, 2048, CLOUD_DATE), dtype=np.float32) / 255
    ground = np.asarray(day, dtype=np.float32) / 255
    low = viirs.min(axis=2)
    high = viirs.max(axis=2)
    # Cloud is bright and colourless. Bright sand keeps its colour, and the ground's own
    # brightness (ice, snow, desert) is taken off so it is not counted as cloud.
    grey = 1 - np.clip((high - low) / np.maximum(high, 1e-3) * 2.4, 0, 1)
    cover = np.clip((low - 0.3 - 0.55 * np.clip(ground.min(axis=2) - 0.25, 0, 1)) / 0.5, 0, 1) * grey
    cover = cover * cover * (3 - 2 * cover)
    # No data near the unlit pole edges and between swaths: fade those to a soft overcast.
    missing = (high < 0.02).astype(np.float32)
    missing = np.asarray(Image.fromarray((missing * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(10)), dtype=np.float32) / 255
    soft = np.asarray(Image.fromarray((cover * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(48)), dtype=np.float32) / 255
    cover = cover * (1 - missing) + np.maximum(soft, 0.35) * missing
    clouds = Image.fromarray((np.clip(cover, 0, 1) * 255).astype(np.uint8), 'L')
    sizes(clouds, 'earth-clouds', [('4k', 4096), ('2k', 2048)], 78)


def build_launch_maps():
    print('Launch coast (Landsat WELD 2000, Blue Marble)')
    near = fetch_tiled('near', 'Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual', NEAR, 2048, 2048, '2000-12-01', tile=1024)
    sizes(near, 'launch-near', [('2k', 2048), ('1k', 1024)], 88)
    mid = fetch_tiled('mid', 'BlueMarble_ShadedRelief_Bathymetry', MID, 2048, 2048, tile=1024)
    sizes(mid, 'launch-mid', [('2k', 2048), ('1k', 1024)], 86)
    far = fetch_tiled('far', 'BlueMarble_ShadedRelief_Bathymetry', FAR, 2048, 2048, tile=1024)
    sizes(far, 'launch-far', [('2k', 2048), ('1k', 1024)], 86)


if __name__ == '__main__':
    build_globe()
    build_launch_maps()
    print('Done. Textures are in', OUT)
