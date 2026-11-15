"""Build data/basemap.json, the static basemap drawn by js/map.js.

Usage (from anywhere; standard library only):
    python tools/build_basemap.py

What it produces:
  - terrain: mean elevation over each STEP-degree cell of the extent below, quantized to
    QUANTUM_M and stored as one character of ALPHABET per cell, row-major from the NW corner
    (lat1, lon0) going east then south.
  - borders: land boundary lines clipped to the extent, as polylines of "lon*100,lat*100" points.
  - labels: country names and their positions.

Sources:
  - Elevation: AWS Open Data terrain tiles (Terrarium encoding, zoom 8, ~430 m pixels),
    https://registry.opendata.aws/terrain-tiles/ — no rate limit. Tiles are cached in tools/.tiles/.
  - Borders: Natural Earth 1:10m admin-0 land boundary lines (natural-earth-vector on GitHub).

To change the map, edit the extent or LABELS below and rerun. The page sizes the map from the
extent's aspect ratio, so a wider extent makes the map shorter on screen.
"""
import datetime
import json
import math
import os
import struct
import sys
import time
import urllib.request
import zlib

# ---- settings ---------------------------------------------------------------------------------
LON0, LON1, LAT0, LAT1, STEP = 5.0, 13.4, 43.7, 47.9, 0.05   # Western Alps to the Dolomites
ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
QUANTUM_M = 80
LABELS = [["FRANCE", 5.6, 44.9], ["ITALIA", 10.2, 44.6], ["SCHWEIZ", 8.2, 46.85],
          ["DEUTSCHLAND", 10.9, 47.78], ["ÖSTERREICH", 12.4, 47.42]]
ZOOM = 8
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
BORDERS_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
               "geojson/ne_10m_admin_0_boundary_lines_land.geojson")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILE_DIR = os.path.join(ROOT, "tools", ".tiles")
OUT = os.path.join(ROOT, "data", "basemap.json")


def fetch_json(url, tries=8):
    for t in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # network hiccup: back off and retry
            print("retry", t, e, file=sys.stderr)
            time.sleep(3 * (t + 1))
    raise SystemExit("failed to fetch " + url)


# ---- elevation: Terrarium PNG tiles -------------------------------------------------------------
def decode_terrarium_png(data):
    """Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) -> rows of elevations in metres."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat = 8, b""
    while pos < len(data):
        ln, = struct.unpack(">I", data[pos:pos + 4])
        typ, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and interlace == 0 and ctype in (2, 6), "unsupported PNG format"
        elif typ == b"IDAT":
            idat += body
    bpp = 3 if ctype == 2 else 4
    raw, stride = zlib.decompress(idat), w * bpp
    rows, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        flt, line = raw[p], bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        for x in range(stride):  # undo the per-row PNG filter
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if flt == 1:
                line[x] = (line[x] + a) & 255
            elif flt == 2:
                line[x] = (line[x] + b) & 255
            elif flt == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif flt == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        # Terrarium: height = R*256 + G + B/256 - 32768
        rows.append([line[i] * 256 + line[i + 1] + line[i + 2] / 256 - 32768 for i in range(0, stride, bpp)])
        prev = line
    return rows


_tiles = {}


def tile(tx, ty):
    if (tx, ty) not in _tiles:
        os.makedirs(TILE_DIR, exist_ok=True)
        fn = os.path.join(TILE_DIR, "%d_%d_%d.png" % (ZOOM, tx, ty))
        if not os.path.exists(fn):
            urllib.request.urlretrieve(TILE_URL.format(z=ZOOM, x=tx, y=ty), fn)
        with open(fn, "rb") as f:
            _tiles[(tx, ty)] = decode_terrarium_png(f.read())
    return _tiles[(tx, ty)]


def to_pixel(lon, lat):
    """Web Mercator global pixel coordinates at ZOOM."""
    n = 2 ** ZOOM * 256
    lat_r = math.radians(lat)
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n


def elevation_at_pixel(xp, yp):
    xi, yi = int(xp), int(yp)
    return tile(xi // 256, yi // 256)[yi % 256][xi % 256]


def cell_mean(lat, lon):
    """Mean elevation over the STEP x STEP cell centred on (lat, lon); sea floor clamped to 0."""
    x0, y0 = to_pixel(lon - STEP / 2, lat + STEP / 2)
    x1, y1 = to_pixel(lon + STEP / 2, lat - STEP / 2)
    vals = [elevation_at_pixel(x, y) for x in range(int(x0), int(x1) + 1) for y in range(int(y0), int(y1) + 1)]
    return max(0, sum(vals) / len(vals))


# ---- borders ------------------------------------------------------------------------------------
def clipped_borders():
    """Boundary polylines, split wherever they leave the extent, rounded to 0.01 deg."""
    inside = lambda lo, la: LON0 <= lo <= LON1 and LAT0 <= la <= LAT1
    lines = []
    for f in fetch_json(BORDERS_URL)["features"]:
        g = f["geometry"]
        for part in (g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]):
            run = []
            for lo, la in part:
                if inside(lo, la):
                    pt = (round(lo * 100), round(la * 100))
                    if not run or run[-1] != pt:
                        run.append(pt)
                else:
                    if len(run) > 1:
                        lines.append(run)
                    run = []
            if len(run) > 1:
                lines.append(run)
    return lines


def main():
    nx, ny = round((LON1 - LON0) / STEP) + 1, round((LAT1 - LAT0) / STEP) + 1
    elev = [cell_mean(round(LAT1 - j * STEP, 4), round(LON0 + i * STEP, 4)) for j in range(ny) for i in range(nx)]
    terrain = "".join(ALPHABET[max(0, min(len(ALPHABET) - 1, round(e / QUANTUM_M)))] for e in elev)
    lines = clipped_borders()
    out = {
        "description": "Static basemap for index.html, built by tools/build_basemap.py. "
                       "terrain.q: one char per grid point, row-major from NW corner (lat1, lon0) going east then south; "
                       f"height = index in alphabet * {QUANTUM_M} m. Source: AWS Open Data terrain tiles (Terrarium, zoom {ZOOM}), "
                       f"mean over each {STEP} deg cell, fetched {datetime.date.today().isoformat()}. "
                       "borders: Natural Earth 1:10m land boundary lines (natural-earth-vector), clipped to the extent, "
                       "polylines of 'lon*100,lat*100' points separated by spaces, lines separated by '|'.",
        "lon0": LON0, "lon1": LON1, "lat0": LAT0, "lat1": LAT1, "step": STEP, "nx": nx, "ny": ny,
        "alphabet": ALPHABET, "quantum_m": QUANTUM_M, "terrain": terrain,
        "borders": "|".join(" ".join("%d,%d" % p for p in ln) for ln in lines),
        "labels": LABELS,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {OUT}: {nx}x{ny} grid, {len(lines)} border lines, max cell mean {max(elev):.0f} m")


if __name__ == "__main__":
    main()
