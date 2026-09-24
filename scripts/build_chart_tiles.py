#!/usr/bin/env python3
"""Build XYZ tile pyramids (Web Mercator EPSG:3857, 256 px, standard XYZ y) from the georeferenced scans.

  charts   - GUNiO nautical charts 1:10 000-1:125 000, stacked by scale (most detailed on top), z9-15 over the
             whole chart coverage + z16 where 1:10 000 / 1:25 000 sheets exist
  genshtab - Soviet 1:100 000 topographic sheets, z9-14

Every output pixel is traced back to the ORIGINAL scan pixels through the georeferencing model
(Web Mercator -> WGS84 -> SK-42 -> chart polynomial / Gauss-Krueger homography -> scan pixel) and resampled
exactly once: cubic spline interpolation where the scan is finer than the tile, and supersampling + Lanczos-3
reduction (i.e. a Lanczos kernel scaled to the pixel footprint - antialiasing) where the tile is coarser than the
scan.  Everything outside the neat line (margins, scales) is transparent; title blocks / notes / source diagrams
inside the neat line (all on land) are painted with the sheet's own land tint; inside one scale tier each pixel
comes from the sheet it lies deepest in (seam in the middle of the overlap).  Between tiers the most detailed
sheet is on top only from the zoom where its soundings are legible (>= 8 px), otherwise it goes underneath.
Scans get a mild non-local-means denoise once (not a median: that erased the figures of the old overlays), tiles
a mild unsharp mask.  Only tiles that touch the chart coverage inside the project bbox (lat 59.85-60.80,
lon 30.90-33.40) are made.  index.json keeps layers written there by other builders.

  python scripts/build_chart_tiles.py charts   [--workers 8] [--zooms 9-16] [--fmt webp] [--q 88]
  python scripts/build_chart_tiles.py genshtab [--workers 8] [--zooms 9-14]
  python scripts/build_chart_tiles.py index    (rewrites site/tiles/index.json + *_tiles.txt from the files on disk)
  python scripts/build_chart_tiles.py test --tiles 14/9612/4747,15/19224/9494 --out research/raw/tiles_check/fmt

Inputs (not in the repo, see research/tiles_report.md): research/raw/charts2 (scans + georef/*.json),
research/raw/tiles_src (extra scans, their georef, prepared planar caches), research/raw/depth/genshtab.
"""
import argparse
import io
import json
import math
import os
import sys
import time
from functools import lru_cache
from multiprocessing import Pool

# one BLAS/OpenMP thread per process: the parallelism comes from the worker pool (otherwise N workers x 12 BLAS
# threads fight for the cores, and OpenBLAS commits a large buffer per thread in every process)
for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import numpy as np  # noqa: E402
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "research", "raw")
CH2 = os.path.join(RAW, "charts2")
TS = os.path.join(RAW, "tiles_src")
GS = os.path.join(RAW, "depth", "genshtab")
CACHE = os.path.join(TS, "cache")
SITE_TILES = os.path.join(ROOT, "site", "tiles")

R = 6378137.0
ORIGIN = math.pi * R
BBOX = {"S": 59.85, "N": 60.80, "W": 30.90, "E": 33.40}
TILE = 256
MARGIN = 8          # extra output pixels rendered around a tile (kernel support + unsharp mask), cropped
COARSE = 8          # the exact geo mapping is evaluated every COARSE output px and interpolated bilinearly
KRAS_E = math.sqrt(2 / 298.3 - (1 / 298.3) ** 2)

# ---------------------------------------------------------------- sources
# tier: scale class (0 = 1:125 000 ... 4 = 1:10 000). cutouts: scan-pixel rectangles (x0, y0, x1, y1) inside the neat
# line that are painted with the land tint around them (legends, emblems, an inset drawn over land at the wrong place).
# datum "proj": WGS84 -> SK-42 by PROJ (about 8.1" in longitude here) instead of the 7.5-7.6" printed on the sheet —
# the printed value put these sheets 8-9 m east of the satellite, canals and lights (research/alignment_report.md).
CHART_SOURCES = [
    # cutouts = title blocks, notes, 'схема использованных материалов', emblems drawn inside the neat line (on land)
    {"id": "23030", "key": "15", "tier": 0, "year": 1999, "cutouts": [(6090, 4180, 7600, 5550)]},
    {"id": "23031", "key": "22", "tier": 1, "year": 1999},
    {"id": "23034", "key": "08", "tier": 1, "year": 2000},
    {"id": "25069", "datum": "proj", "key": "16", "tier": 2, "year": 1997,
     "cutouts": [(3230, 4915, 4085, 5370), (3150, 5395, 4040, 5625), (3985, 4720, 4165, 4885),
                 (270, 5250, 530, 5570), (550, 5495, 905, 5605)]},
    {"id": "25068", "datum": "proj", "key": "18", "tier": 2, "year": 1998,
     "cutouts": [(2825, 3500, 3870, 4165), (2675, 3545, 2865, 3805), (4195, 3885, 4865, 4150)]},
    {"id": "25070", "datum": "proj", "key": "13", "tier": 2, "year": 1998,
     "cutouts": [(3190, 770, 4095, 1225), (3130, 1290, 4080, 1540), (3525, 1605, 4135, 1955)]},
    {"id": "25067", "datum": "proj", "key": "19", "tier": 2, "year": 1996,
     "cutouts": [(1240, 4895, 2200, 5520), (955, 4990, 1235, 5280), (2535, 5285, 3195, 5615)]},
    {"id": "25064", "datum": "proj", "key": "21", "tier": 2, "year": 1998, "cutouts": [(290, 4400, 1440, 5680)]},
    # 28079: the 1:10 000 inset 'Проход южнее острова Торпаков' (+ its title/scale bar) sits over the land south of
    # Сторожно - cut out here, it is placed at its true position as a separate 1:10 000 source (28079A).
    {"id": "28079", "datum": "proj", "key": "14", "tier": 3, "year": 1995,
     "cutouts": [(1495, 3336, 3270, 4162), (2005, 3148, 2765, 3322), (4690, 3085, 5620, 3612), (3262, 3500, 3940, 3700)]},
    {"id": "28071", "datum": "proj", "key": "30", "tier": 3, "year": 1993, "cutouts": [(3085, 5830, 4105, 6560)]},
    {"id": "28081", "key": "17", "tier": 4, "year": 1984, "cutouts": [(2805, 4515, 3760, 5295)]},
    # 300-dpi scan of the 1989 edition (sos-homepage.narod.ru), posterised to 6 flat colours: recoloured to the tints
    # of the neighbouring 28071 / 25067 scans so the sheet does not stand out
    {"id": "28070", "key": "20g", "tier": 4, "year": 1989,
     "cutouts": [(1400, 405, 3320, 1965), (250, 5600, 1740, 5990)],
     "recolor": {(255, 255, 255): (251, 251, 249), (153, 255, 255): (214, 233, 240), (255, 255, 153): (250, 246, 198),
                 (0, 0, 0): (28, 26, 28), (255, 51, 51): (214, 64, 64), (51, 255, 51): (70, 160, 90),
                 (255, 204, 51): (240, 175, 70)}},
    {"id": "28079A", "datum": "proj", "key": "14A", "tier": 4, "year": 1995, "optional": True, "same_image_as": "28079"},
]
SCALE_OF_TIER = {0: 125000, 1: 100000, 2: 50000, 3: 25000, 4: 10000}
DIGIT_MM = 2.0        # height of a sounding figure on the paper chart
MIN_DIGIT_PX = 8.0    # a tier is 'legible' at a zoom when its soundings are at least this tall on screen
# ... except the 1:25 000 sheets, on top from z13 (5 px figures): one sheet change fewer on the way in, and the
# 1:50 000 sheets they replace are the ones that sit 20-40 m off the shore (Осиновец, Свирская губа)
MIN_DIGIT_PX_TIER = {3: 5.0}
GENSHTAB_SOURCES = [
    {"id": "P-36-135,136", "key": "genshtab_P-36-135_136"},
    {"id": "P-36-137,138", "key": "genshtab_P-36-137_138"},
    {"id": "P-36-126", "key": "genshtab_P-36-126"},
    {"id": "O-36-3", "key": "genshtab_O-36-3"},
]
LAYERS = {
    "charts": {"name": "Навигационные карты ГУНиО (1:10 000–1:125 000)", "zmin": 9, "zmax": 15, "zdetail": 16,
               "detail_tiers": (3, 4),
               "attribution": "Навигационные карты ГУНиО МО № 23030, 23031, 23034, 25064, 25067–25070, 28070, 28071, "
                              "28079, 28081 (изд. 1984–2000; сканы ladoga-lake.ru, sos-homepage.narod.ru); глубины от "
                              "среднего многолетнего уровня, не для навигации"},
    "genshtab": {"name": "Топокарта Генштаба СССР 1:100 000", "zmin": 9, "zmax": 14, "zdetail": None,
                 "detail_tiers": (),
                 "attribution": "Топокарта Генштаба СССР 1:100 000, листы P-36-126, P-36-135,136, P-36-137,138, O-36-3 "
                                "(сканы maps.vlasenko.net)"},
}


def merc_v(lat_deg):
    """isometric latitude of the Krasovsky ellipsoid (the chart's Mercator ordinate)"""
    phi = np.radians(np.asarray(lat_deg, float))
    es = KRAS_E * np.sin(phi)
    return np.log(np.tan(np.pi / 4 + phi / 2) * ((1 - es) / (1 + es)) ** (KRAS_E / 2))


def _terms(u, v, order):
    return np.stack([(u ** i) * (v ** j) for i in range(order + 1) for j in range(order + 1 - i)], axis=-1)


class Source:
    """one georeferenced scan: geo mapping WGS84 -> scan pixel + frame (neat line) in SK-42 lon/lat"""

    def __init__(self, cfg, layer):
        self.cfg = cfg
        self.id = cfg["id"]
        self.tier = cfg.get("tier", 0)
        self.cutouts = cfg.get("cutouts", [])
        self.layer = layer
        self._arr = None
        if layer == "charts":
            gpath = os.path.join(CH2, "georef", cfg["key"] + ".json")
            if not os.path.exists(gpath):
                gpath = os.path.join(TS, "georef", cfg["key"] + ".json")
            g = json.load(open(gpath, encoding="utf-8"))
            self.g = g
            base = CH2 if os.path.dirname(gpath).startswith(os.path.join(CH2, "georef")) else TS
            self.image = os.path.join(base, g["file"])
            meta = json.load(open(os.path.join(CH2, "charts.json"), encoding="utf-8")).get(cfg["key"], {})
            self.meta = meta
            shift = g.get("wgs84_to_chart_lon_shift_sec", meta.get("wgs84_to_chart_lon_shift_sec"))
            self.shift_sec = None if cfg.get("datum") == "proj" else shift
            b = g["bounds_sk42"]
            self.frame = (b["W"], b["E"], b["S"], b["N"])
            self.mpp = g["m_per_px"]
            self.scale = g.get("scale") or meta.get("scale")
            self.title = g.get("title") or meta.get("title")
            self.order = g["order"]
            self.mu, self.sc = np.array(g["mu"]), np.array(g["sc"])
            self.cx, self.cy = np.array(g["cx"]), np.array(g["cy"])
        else:
            g = json.load(open(os.path.join(TS, "georef", cfg["key"] + ".json"), encoding="utf-8"))
            self.g = g
            self.image = os.path.join(TS, g["file"])
            s, w, n, e = g["bounds_sk42"]
            self.frame = (w, e, s, n)
            self.mpp = g["m_per_px"]
            self.scale = 100000
            self.title = g["sheet"]
            self.H = np.array(g["H_gk_to_px"])
            self.pmu, self.psc = np.array(g["poly_mu"]), np.array(g["poly_sc"])
            self.pcx, self.pcy = np.array(g["poly_cx"]), np.array(g["poly_cy"])
            self.porder = g["poly_order"]
            self.shift_sec = None
        self.bbox_wgs = self._frame_bbox_wgs()

    # -- datum / projection helpers (pyproj only where needed, transformers cached per process)
    @staticmethod
    @lru_cache(maxsize=None)
    def _tr(src, dst):
        from pyproj import Transformer
        return Transformer.from_crs(src, dst, always_xy=True)

    def wgs_to_sk(self, lon, lat):
        if self.shift_sec is not None:
            return lon + self.shift_sec / 3600.0, lat
        x, y = self._tr("EPSG:4326", "EPSG:4284").transform(lon, lat)
        return np.asarray(x), np.asarray(y)

    def sk_to_wgs(self, lon, lat):
        if self.shift_sec is not None:
            return lon - self.shift_sec / 3600.0, lat
        x, y = self._tr("EPSG:4284", "EPSG:4326").transform(lon, lat)
        return np.asarray(x), np.asarray(y)

    def _frame_bbox_wgs(self):
        W, E, S, N = self.frame
        t = np.linspace(0, 1, 41)
        lon = np.concatenate([W + t * (E - W), W + t * (E - W), np.full_like(t, W), np.full_like(t, E)])
        lat = np.concatenate([np.full_like(t, S), np.full_like(t, N), S + t * (N - S), S + t * (N - S)])
        x, y = self.sk_to_wgs(lon, lat)
        return float(np.min(y)), float(np.min(x)), float(np.max(y)), float(np.max(x))  # S, W, N, E

    def map(self, lon, lat):
        """WGS84 lon/lat arrays -> (scan x, scan y, SK-42 lon, SK-42 lat)"""
        lon_sk, lat_sk = self.wgs_to_sk(lon, lat)
        if self.layer == "charts":
            uv = np.stack([lon_sk, merc_v(lat_sk)], axis=-1)
            T = _terms(*np.moveaxis((uv - self.mu) / self.sc, -1, 0), self.order)
            return T @ self.cx, T @ self.cy, lon_sk, lat_sk
        E, N = self._tr("EPSG:4326", "EPSG:28406").transform(lon, lat)
        E, N = np.asarray(E), np.asarray(N)
        q = self.H[0, 0] * E + self.H[0, 1] * N + self.H[0, 2], self.H[1, 0] * E + self.H[1, 1] * N + self.H[1, 2], \
            self.H[2, 0] * E + self.H[2, 1] * N + self.H[2, 2]
        T = _terms((E - self.pmu[0]) / self.psc[0], (N - self.pmu[1]) / self.psc[1], self.porder)
        return q[0] / q[2] + T @ self.pcx, q[1] / q[2] + T @ self.pcy, lon_sk, lat_sk

    # -- pixels: planar uint8 cache (3, H, W), memory-mapped (shared page cache between workers)
    @property
    def cache_path(self):
        cid = self.cfg.get("same_image_as", self.id)
        return os.path.join(CACHE, f"{self.layer}_{cid.replace(',', '_')}.npy")

    def prepare(self):
        """planar uint8 copy of the scan. JPEG scans get a mild edge-preserving non-local-means denoise (h=5):
        it removes JPEG/paper grain in flat areas but keeps the strokes of the figures (a 3x3 median - used for the
        old overlays - rounds them off). Flat-colour GIF scans are only recoloured."""
        if os.path.exists(self.cache_path):
            return self.cache_path
        os.makedirs(CACHE, exist_ok=True)
        im = Image.open(self.image)
        flat = im.mode == "P"
        if flat and self.cfg.get("recolor"):
            pal = np.array(im.getpalette(), np.uint8).reshape(-1, 3)
            for old, new in self.cfg["recolor"].items():
                pal[(pal == np.array(old, np.uint8)).all(1)] = new
            im.putpalette(pal.ravel().tolist())
        a = np.asarray(im.convert("RGB"))
        if not flat and self.cfg.get("denoise", True):
            import cv2
            a = np.ascontiguousarray(a)
            out = np.empty_like(a)
            step = 2048  # in bands (memory), with overlap so the band seams are invisible
            for y0 in range(0, a.shape[0], step):
                ya, yb = max(0, y0 - 32), min(a.shape[0], y0 + step + 32)
                band = cv2.fastNlMeansDenoisingColored(a[ya:yb], None, 5, 5, 5, 15)
                out[y0:min(a.shape[0], y0 + step)] = band[y0 - ya:y0 - ya + min(step, a.shape[0] - y0)]
            a = out
        planar = np.ascontiguousarray(np.moveaxis(a, -1, 0))
        tmp = self.cache_path + ".tmp.npy"
        np.save(tmp, planar)
        os.replace(tmp, self.cache_path)
        return self.cache_path

    @property
    def arr(self):
        if self._arr is None:
            self._arr = np.load(self.cache_path, mmap_mode="r")
        return self._arr

    @property
    def fill_colors(self):
        """per cutout: the paper/land tint around it (median of a 12..40 px ring, 'ink' pixels ignored)"""
        if getattr(self, "_fill", None) is None:
            a = self.arr
            _, H, W = a.shape
            cols = []
            for (x0, y0, x1, y1) in self.cutouts:
                X0, Y0, X1, Y1 = max(0, x0 - 40), max(0, y0 - 40), min(W, x1 + 41), min(H, y1 + 41)
                win = np.asarray(a[:, Y0:Y1:2, X0:X1:2], np.float32).reshape(3, -1)
                yy, xx = np.mgrid[Y0:Y1:2, X0:X1:2]
                ring = ~((xx >= x0 - 12) & (xx <= x1 + 12) & (yy >= y0 - 12) & (yy <= y1 + 12)).ravel()
                v = win[:, ring]
                v = v[:, v.max(0) > 140]  # drop dark ink
                cols.append(tuple(float(c) for c in np.median(v, axis=1)) if v.size else (250.0, 246.0, 200.0))
            self._fill = cols
        return self._fill


def load_sources(layer):
    out = []
    for cfg in (CHART_SOURCES if layer == "charts" else GENSHTAB_SOURCES):
        try:
            out.append(Source(cfg, layer))
        except FileNotFoundError:
            if not cfg.get("optional"):
                raise
    return out


def _prep(args):
    layer, sid = args
    s = [x for x in load_sources(layer) if x.id == sid][0]
    t0 = time.time()
    s.prepare()
    return sid, time.time() - t0


def prepare_all(layer, workers=3):
    """build the planar (denoised) caches, a few scans in parallel (NLM is single-threaded; ~0.5 GB per scan)"""
    todo, seen = [], set()
    for s in load_sources(layer):
        if not os.path.exists(s.cache_path) and s.cache_path not in seen:
            todo.append((layer, s.id))
            seen.add(s.cache_path)
    if not todo:
        return
    with Pool(min(workers, len(todo))) as pool:
        for sid, dt in pool.imap_unordered(_prep, todo):
            print(f"  prepared {layer} {sid} in {dt:.0f} s", flush=True)


# ---------------------------------------------------------------- tile geometry
def tile_res(z):
    return 2 * ORIGIN / (TILE * 2 ** z)


def lon_to_tx(lon, z):
    return (lon + 180.0) / 360.0 * 2 ** z


def lat_to_ty(lat, z):
    la = math.radians(lat)
    return (1 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2 * 2 ** z


def tile_bounds(z, x, y):
    n = 2 ** z
    w = x / n * 360 - 180
    e = (x + 1) / n * 360 - 180
    nn = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return s, w, nn, e


def tiles_in(z, S, W, N, E):
    x0, x1 = int(math.floor(lon_to_tx(W, z))), int(math.floor(lon_to_tx(E, z) - 1e-9))
    y0, y1 = int(math.floor(lat_to_ty(N, z))), int(math.floor(lat_to_ty(S, z) - 1e-9))
    return [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def plan_tiles(sources, layer):
    L = LAYERS[layer]
    bb = (BBOX["S"], BBOX["W"], BBOX["N"], BBOX["E"])
    boxes = [s.bbox_wgs for s in sources]
    plan = []
    for z in range(L["zmin"], L["zmax"] + 1):
        for t in tiles_in(z, *bb):
            tb = tile_bounds(*t)
            if any(overlaps(tb, b) for b in boxes):
                plan.append(t)
    regions = []
    if L["zdetail"]:
        det = [s for s in sources if s.tier in L["detail_tiers"]]
        # merge overlapping / touching detail frames into rectangles (tile-aligned at zdetail)
        rects = [list(s.bbox_wgs) for s in det]
        merged = True
        while merged:
            merged = False
            for i in range(len(rects)):
                for j in range(i + 1, len(rects)):
                    a, b = rects[i], rects[j]
                    if a[0] <= b[2] + 0.002 and b[0] <= a[2] + 0.002 and a[1] <= b[3] + 0.004 and b[1] <= a[3] + 0.004:
                        rects[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                        rects.pop(j)
                        merged = True
                        break
                if merged:
                    break
        z = L["zdetail"]
        for r in rects:
            r = [max(r[0], bb[0]), max(r[1], bb[1]), min(r[2], bb[2]), min(r[3], bb[3])]
            ts = tiles_in(z, *r)
            plan.extend(ts)
            xs = [t[1] for t in ts]
            ys = [t[2] for t in ts]
            s_, w_, _, _ = tile_bounds(z, min(xs), max(ys))
            _, _, n_, e_ = tile_bounds(z, max(xs), min(ys))
            regions.append({"bounds": [[round(s_, 6), round(w_, 6)], [round(n_, 6), round(e_, 6)]],
                            "tiles": len(ts), "x": [min(xs), max(xs)], "y": [min(ys), max(ys)]})
    return plan, regions


# ---------------------------------------------------------------- resampling kernels
def lanczos(x, a=3):
    x = np.asarray(x, float)
    out = np.sinc(x) * np.sinc(x / a)
    out[np.abs(x) >= a] = 0
    return out


@lru_cache(maxsize=None)
def reduce_matrix(n_out, k):
    """(n_out x n_out*k) Lanczos-3 reduction by an integer factor k (rows normalised)"""
    j = np.arange(n_out * k)
    i = np.arange(n_out)
    t = ((j[None, :] + 0.5) / k - (i[:, None] + 0.5))
    Wm = lanczos(t)
    Wm /= Wm.sum(1, keepdims=True)
    return Wm.astype(np.float32)


@lru_cache(maxsize=None)
def interp_matrix(n_dense, k, n_out, step):
    """bilinear interpolation weights (n_dense x n_nodes) from coarse nodes (every `step` output px, from 0 to n_out)
    to supersampled centres ((q + 0.5) / k output px)"""
    nodes = n_out // step + 1
    pos = (np.arange(n_dense) + 0.5) / k / step
    i0 = np.clip(np.floor(pos).astype(int), 0, nodes - 2)
    w = pos - i0
    M = np.zeros((n_dense, nodes), np.float64)
    M[np.arange(n_dense), i0] = 1 - w
    M[np.arange(n_dense), i0 + 1] = w
    return M


def sample_rgb(src, px, py, order):
    """sample the planar uint8 source at float pixel coords (1-D arrays); returns (3, n) float32"""
    C, H, W = src.shape
    out = np.empty((3, px.size), np.float32)
    if px.size == 0:
        return out
    pad = 12
    x0 = max(int(np.floor(px.min())) - pad, 0)
    x1 = min(int(np.ceil(px.max())) + pad + 1, W)
    y0 = max(int(np.floor(py.min())) - pad, 0)
    y1 = min(int(np.ceil(py.max())) + pad + 1, H)
    if x1 <= x0 or y1 <= y0:
        out[:] = 255
        return out
    coords = np.stack([np.clip(py - y0, 0, y1 - y0 - 1), np.clip(px - x0, 0, x1 - x0 - 1)])
    for c in range(3):
        win = src[c, y0:y1, x0:x1]
        if order == 3:
            f = ndimage.spline_filter(np.asarray(win, np.float32), order=3, mode="mirror", output=np.float32)
            ndimage.map_coordinates(f, coords, output=out[c], order=3, mode="mirror", prefilter=False)
        else:
            ndimage.map_coordinates(np.asarray(win), coords, output=out[c], order=1, mode="nearest", prefilter=False)
    return out


# ---------------------------------------------------------------- tile rendering
class Renderer:
    def __init__(self, layer, usm=(0.9, 0.6, 2.0)):
        self.layer = layer
        self.sources = load_sources(layer)
        self.usm = usm  # (sigma px, amount, threshold in 0..255)

    def render(self, z, tx, ty):
        """returns float32 RGBA (256, 256, 4), straight alpha 0..1, RGB 0..255 - or None if empty"""
        N = TILE + 2 * MARGIN
        tb = tile_bounds(z, tx, ty)
        pad = MARGIN / TILE * (tb[3] - tb[1])
        tbm = (tb[0] - pad, tb[1] - pad, tb[2] + pad, tb[3] + pad)
        srcs = [s for s in self.sources if overlaps(tbm, s.bbox_wgs)]
        if not srcs:
            return None
        res = tile_res(z)
        gx0 = tx * TILE - MARGIN
        gy0 = ty * TILE - MARGIN
        nodes = N // COARSE + 1
        X = gx0 + np.arange(nodes) * COARSE
        Y = gy0 + np.arange(nodes) * COARSE
        lon1 = np.degrees((X * res - ORIGIN) / R)
        lat1 = np.degrees(np.arctan(np.sinh((ORIGIN - Y * res) / R)))
        LON, LAT = np.meshgrid(lon1, lat1)
        latc = (tb[0] + tb[2]) / 2
        ground = res * math.cos(math.radians(latc))
        acc = np.zeros((N, N, 4), np.float32)  # premultiplied RGB + alpha
        # composite top tier first ('under' operator == bottom-up 'over'); stop once the tile is fully covered
        for tier in reversed(self.tier_order({s.tier for s in srcs}, ground)):
            group = [s for s in srcs if s.tier == tier]
            layer = self._render_tier(group, LON, LAT, N, ground, acc[..., 3])
            if layer is None:
                continue
            acc = acc + layer * (1 - acc[..., 3:4])
            if acc[..., 3].min() >= 0.9999:
                break
        a = acc[..., 3]
        if a.max() < 0.5 / 255:
            return None
        rgb = np.where(a[..., None] > 1e-6, acc[..., :3] / np.maximum(a[..., None], 1e-6), 0)
        rgb = self._unsharp(rgb, a)
        out = np.concatenate([rgb, a[..., None]], axis=-1)[MARGIN:MARGIN + TILE, MARGIN:MARGIN + TILE]
        if out[..., 3].max() < 0.5 / 255:
            return None
        return out

    def tier_order(self, tiers, ground):
        """bottom -> top. Tiers whose soundings are legible at this zoom (>= MIN_DIGIT_PX) are stacked by scale with
        the most detailed on top; tiers still too small to read go underneath them (they only fill gaps), so e.g. at
        z14 the 1:50 000 sheet is shown over the 1:10 000 one, whose figures would be 4 px tall."""
        if self.layer != "charts":
            return sorted(tiers)

        def key(t):
            legible = DIGIT_MM / 1000 * SCALE_OF_TIER[t] / ground >= MIN_DIGIT_PX_TIER.get(t, MIN_DIGIT_PX)
            return (1, t) if legible else (0, -t)
        return sorted(tiers, key=key)

    def _render_tier(self, group, LON, LAT, N, ground, covered):
        # only where the tiers above have not already covered the tile (+ the Lanczos support)
        need = covered < 0.999
        if not need.any():
            return None
        if not need.all():
            need = ndimage.binary_dilation(need, iterations=4)
        nodes = LON.shape[0]
        idx = np.minimum(np.arange(nodes) * COARSE, N - 1)
        need_coarse = ndimage.binary_dilation(need[np.ix_(idx, idx)], iterations=1)
        coarse = []
        for s in group:
            px, py, lsk, bsk = s.map(LON, LAT)
            W_, E_, S_, N_ = s.frame
            inside = (lsk >= W_) & (lsk <= E_) & (bsk >= S_) & (bsk <= N_)
            inside = ndimage.binary_dilation(inside, iterations=1)
            if (inside & need_coarse).any():
                coarse.append((s, (px, py, lsk, bsk)))
        if not coarse:
            return None
        group = [c[0] for c in coarse]
        s_max = max(ground / s.mpp for s in group)
        k = 1 if s_max <= 1.0 else int(math.ceil(s_max - 1e-6))
        order = 3 if k <= 4 else 1
        n_dense = N * k
        Wm = interp_matrix(n_dense, k, N, COARSE)
        # exact mapping on the coarse grid -> (map quantity) @ Wm.T per source
        maps = [[np.asarray(q, np.float64) @ Wm.T for q in qs] for _, qs in coarse]  # (nodes x n_dense)
        need_cols = need[:, np.arange(n_dense) // k] if not need.all() else None
        Rk = reduce_matrix(N, k) if k > 1 else None
        colbuf = np.zeros((n_dense, N, 4), np.float32) if k > 1 else np.zeros((N, N, 4), np.float32)
        strip = max(8, (4096 * 64) // n_dense) if k > 1 else N
        any_px = False
        for r0 in range(0, n_dense, strip):
            r1 = min(n_dense, r0 + strip)
            Wr = Wm[r0:r1]
            best = np.full((r1 - r0, n_dense), -1.0)
            who = np.full((r1 - r0, n_dense), -1, np.int16)
            dense = []
            for i, s in enumerate(group):
                px, py, lsk, bsk = (Wr @ q for q in maps[i])
                W_, E_, S_, N_ = s.frame
                coslat = np.cos(np.radians(bsk))
                d = np.minimum(np.minimum((lsk - W_) * coslat, (E_ - lsk) * coslat), np.minimum(bsk - S_, N_ - bsk))
                cut = None
                for j, (cx0, cy0, cx1, cy1) in enumerate(s.cutouts):
                    inside_cut = (px >= cx0) & (px <= cx1) & (py >= cy0) & (py <= cy1)
                    if inside_cut.any():
                        if cut is None:
                            cut = np.full(px.shape, -1, np.int16)
                        cut[inside_cut] = j
                win = d > best
                best = np.where(win, d, best)
                who = np.where(win & (d > 0), i, who)
                dense.append((px, py, cut))
            if need_cols is not None:
                who = np.where(need_cols[np.arange(r0, r1) // k], who, -1)
            rows = np.zeros((r1 - r0, n_dense, 4), np.float32)
            for i, s in enumerate(group):
                m = who == i
                if not m.any():
                    continue
                any_px = True
                px, py, cut = dense[i]
                rgb = sample_rgb(s.arr, px[m], py[m], order)
                if cut is not None:  # legend blocks -> the sheet's own land tint around them
                    cm = cut[m]
                    for j, col in enumerate(s.fill_colors):
                        sel = cm == j
                        if sel.any():
                            for c in range(3):
                                rgb[c][sel] = col[c]
                for c in range(3):
                    rows[..., c][m] = rgb[c]
                rows[..., 3][m] = 1.0
            rows[..., :3] = np.clip(rows[..., :3], 0, 255) * rows[..., 3:4]
            if k > 1:  # reduce columns now (strip x N x 4), rows after all strips
                colbuf[r0:r1] = np.tensordot(rows, Rk, axes=([1], [1])).transpose(0, 2, 1)
            else:
                colbuf[r0:r1] = rows
        if not any_px:
            return None
        if k > 1:
            out = np.tensordot(Rk, colbuf, axes=([1], [0]))
        else:
            out = colbuf
        out[..., 3] = np.clip(out[..., 3], 0, 1)
        out[..., :3] = np.clip(out[..., :3], 0, 255 * out[..., 3:4])
        return out

    def _unsharp(self, rgb, a):
        sigma, amount, thr = self.usm
        if amount <= 0:
            return rgb
        wa = ndimage.gaussian_filter(a, sigma)
        out = np.empty_like(rgb)
        for c in range(3):
            bl = ndimage.gaussian_filter(rgb[..., c] * a, sigma) / np.maximum(wa, 1e-6)
            diff = rgb[..., c] - bl
            diff = np.where(np.abs(diff) > thr, diff, 0)
            out[..., c] = rgb[..., c] + amount * diff
        return np.clip(out, 0, 255)


# ---------------------------------------------------------------- encoding
def to_image(t):
    a8 = np.round(t[..., 3] * 255).astype(np.uint8)
    rgb8 = np.round(t[..., :3]).astype(np.uint8)
    if a8.min() == 255:
        return Image.fromarray(rgb8, "RGB")
    rgb8[a8 == 0] = 0
    return Image.fromarray(np.dstack([rgb8, a8]), "RGBA")


def encode(im, fmt, q):
    buf = io.BytesIO()
    if fmt == "webp":
        im.save(buf, "WEBP", quality=q, method=6, alpha_quality=100)
    elif fmt in ("png8", "webpll"):
        import imagequant
        colors = q if q <= 256 else 128
        pq = imagequant.quantize_pil_image(im.convert("RGBA"), dithering_level=0.0, max_colors=colors,
                                           min_quality=0, max_quality=100)
        if fmt == "png8":
            pq.save(buf, "PNG", optimize=True)
            try:
                import oxipng
                return oxipng.optimize_from_memory(buf.getvalue(), level=4)
            except Exception:
                pass
        else:
            pq.convert("RGBA" if im.mode == "RGBA" else "RGB").save(buf, "WEBP", lossless=True, quality=100, method=6)
    elif fmt == "png":
        im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------- workers
_R = None
_OPT = None


def _init(layer, opt):
    global _R, _OPT
    _R = Renderer(layer, usm=tuple(opt["usm"]))
    _OPT = opt


def _work(t):
    z, x, y = t
    try:
        out = _R.render(z, x, y)
    except Exception as e:  # keep going, report
        return (z, x, y, -1, repr(e))
    if out is None:
        return (z, x, y, 0, None)
    data = encode(to_image(out), _OPT["fmt"], _OPT["q"])
    ext = "png" if _OPT["fmt"] == "png8" else "webp"
    d = os.path.join(_OPT["outdir"], str(z), str(x))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"{y}.{ext}"), "wb") as f:
        f.write(data)
    return (z, x, y, len(data), None)


def build(layer, args):
    prepare_all(layer)
    sources = load_sources(layer)
    plan, regions = plan_tiles(sources, layer)
    zr = args.zooms
    if zr:
        a, b = (int(v) for v in zr.split("-"))
        plan = [t for t in plan if a <= t[0] <= b]
    plan = sorted(set(plan), key=lambda t: (t[0], t[1] // 8, t[2] // 8, t[1], t[2]))
    outdir = os.path.join(SITE_TILES, layer)
    opt = {"fmt": args.fmt, "q": args.q, "outdir": outdir, "usm": args.usm}
    print(f"{layer}: {len(sources)} sources, {len(plan)} candidate tiles; workers {args.workers}", flush=True)
    t0 = time.time()
    stats = {}
    errors = []
    done = 0
    with Pool(args.workers, initializer=_init, initargs=(layer, opt)) as pool:
        for z, x, y, n, err in pool.imap_unordered(_work, plan, chunksize=8):
            done += 1
            if n < 0:
                errors.append((z, x, y, err))
            elif n > 0:
                st = stats.setdefault(z, [0, 0])
                st[0] += 1
                st[1] += n
            if done % 2000 == 0:
                print(f"  {done}/{len(plan)} tiles, {time.time() - t0:.0f} s", flush=True)
    print(f"{layer}: done in {time.time() - t0:.0f} s; errors {len(errors)}", flush=True)
    for e in errors[:10]:
        print("  error", e)
    for z in sorted(stats):
        print(f"  z{z}: {stats[z][0]} tiles, {stats[z][1] / 1e6:.1f} MB")
    json.dump({"regions_detail": regions, "fmt": args.fmt, "q": args.q, "usm": args.usm},
              open(os.path.join(TS, f"_{layer}_build.json"), "w"), indent=1)
    write_index()


def write_index():
    """index.json + flat URL lists, from the tile files on disk"""
    layers = []
    for layer, L in LAYERS.items():
        d = os.path.join(SITE_TILES, layer)
        if not os.path.isdir(d):
            continue
        counts, sizes, urls, ext = {}, {}, [], "webp"
        S = W = 1e9
        N = E = -1e9
        for z in sorted(os.listdir(d), key=int):
            for x in os.listdir(os.path.join(d, z)):
                for f in os.listdir(os.path.join(d, z, x)):
                    y, ext = f.split(".")
                    counts[z] = counts.get(z, 0) + 1
                    sizes[z] = sizes.get(z, 0) + os.path.getsize(os.path.join(d, z, x, f))
                    urls.append(f"tiles/{layer}/{z}/{x}/{f}")
                    if int(z) == L["zmin"]:
                        s_, w_, n_, e_ = tile_bounds(int(z), int(x), int(y))
                        S, W, N, E = min(S, s_), min(W, w_), max(N, n_), max(E, e_)
        build = {}
        bp = os.path.join(TS, f"_{layer}_build.json")
        if os.path.exists(bp):
            build = json.load(open(bp))
        srcs = load_sources(layer)
        cover = [min(s.bbox_wgs[0] for s in srcs), min(s.bbox_wgs[1] for s in srcs),
                 max(s.bbox_wgs[2] for s in srcs), max(s.bbox_wgs[3] for s in srcs)]
        cover = [max(cover[0], BBOX["S"]), max(cover[1], BBOX["W"]), min(cover[2], BBOX["N"]), min(cover[3], BBOX["E"])]
        zmax_native = max(int(z) for z in counts)
        entry = {
            "id": layer, "name": L["name"], "url": f"tiles/{layer}/{{z}}/{{x}}/{{y}}.{ext}",
            "minZoom": L["zmin"], "maxZoom": 19, "maxNativeZoom": L["zmax"],
            "bounds": [[round(cover[0], 5), round(cover[1], 5)], [round(cover[2], 5), round(cover[3], 5)]],
            "tile_extent": [[round(S, 5), round(W, 5)], [round(N, 5), round(E, 5)]],
            "attribution": L["attribution"], "format": ext, "tileSize": TILE,
            "tiles_count_by_zoom": {z: counts[z] for z in sorted(counts, key=int)},
            "bytes_by_zoom": {z: sizes[z] for z in sorted(sizes, key=int)},
            "total_tiles": sum(counts.values()), "total_bytes": sum(sizes.values()),
            "list": f"tiles/{layer}_tiles.txt",
        }
        if L["zdetail"] and str(L["zdetail"]) in counts:
            zd = str(L["zdetail"])
            have = {tuple(int(p) for p in (u.split("/")[3], u.split("/")[4].split(".")[0])) for u in urls
                    if u.split("/")[2] == zd}
            for r in build.get("regions_detail", []):
                r["tiles"] = sum(1 for (x, y) in have if r["x"][0] <= x <= r["x"][1] and r["y"][0] <= y <= r["y"][1])
            entry["detail"] = {"zoom": L["zdetail"], "maxNativeZoom": zmax_native,
                               # tile-aligned rectangles, shrunk by ~0.1 m so Leaflet never asks for the neighbours
                               "regions": [{**r, "bounds": [[round(r["bounds"][0][0] + 1e-6, 7), round(r["bounds"][0][1] + 1e-6, 7)],
                                                            [round(r["bounds"][1][0] - 1e-6, 7), round(r["bounds"][1][1] - 1e-6, 7)]]}
                                           for r in build.get("regions_detail", [])],
                               "note": "z16 tiles exist only inside these rectangles (1:10 000 / 1:25 000 sheets); "
                                       "elsewhere use z15 (maxNativeZoom 15)"}
        entry["sources"] = [{"id": s.id, "title": s.title, "scale": s.scale, "year": s.cfg.get("year"),
                             "m_per_px": round(s.mpp, 2), "tier": s.tier,
                             "frame_wgs84": [[round(s.bbox_wgs[0], 5), round(s.bbox_wgs[1], 5)],
                                             [round(s.bbox_wgs[2], 5), round(s.bbox_wgs[3], 5)]]} for s in srcs]
        layers.append(entry)
        with open(os.path.join(SITE_TILES, f"{layer}_tiles.txt"), "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(sorted(urls, key=lambda u: [int(p) if p.isdigit() else p for p in u.replace('.', '/').split('/')])) + "\n")
    # keep layers written into the same index by other builders (e.g. a 'depth' layer), replace only ours
    ip = os.path.join(SITE_TILES, "index.json")
    if os.path.exists(ip):
        try:
            old = json.load(open(ip, encoding="utf-8"))
            ours = {l["id"] for l in layers}
            layers += [l for l in old.get("layers", []) if l.get("id") not in ours and l.get("id") not in LAYERS]
        except (ValueError, KeyError):
            pass
    idx = {"generated": time.strftime("%Y-%m-%d"), "tile_scheme": "XYZ (Google/OSM), EPSG:3857, 256 px",
           "layers": layers}
    json.dump(idx, open(os.path.join(SITE_TILES, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for l in layers:
        print(f"index: {l.get('id')}: {l.get('total_tiles', '?')} tiles, {(l.get('total_bytes') or 0) / 1e6:.1f} MB")


def test(args):
    """render given tiles with several encodings for comparison (no site output)"""
    layer = args.layer
    prepare_all(layer)
    r = Renderer(layer, usm=tuple(args.usm))
    os.makedirs(args.out, exist_ok=True)
    for spec in args.tiles.split(","):
        z, x, y = (int(v) for v in spec.split("/"))
        t0 = time.time()
        out = r.render(z, x, y)
        dt = time.time() - t0
        if out is None:
            print(spec, "empty")
            continue
        im = to_image(out)
        im.save(os.path.join(args.out, f"{z}_{x}_{y}_raw.png"))
        line = [f"{spec} {dt:.2f}s"]
        for fmt, q in (("webp", 85), ("webp", 90), ("png8", 64), ("png8", 128), ("webpll", 64), ("webpll", 128)):
            data = encode(im, fmt, q)
            ext = "png" if fmt == "png8" else "webp"
            with open(os.path.join(args.out, f"{z}_{x}_{y}_{fmt}{q}.{ext}"), "wb") as f:
                f.write(data)
            line.append(f"{fmt}{q}={len(data) / 1024:.1f}K")
        print("  ".join(line), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["charts", "genshtab", "index", "test", "prepare"])
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 4))
    ap.add_argument("--zooms", default=None)
    ap.add_argument("--fmt", default="webp", choices=["webp", "png8", "webpll"])
    ap.add_argument("--q", type=int, default=88)
    ap.add_argument("--usm", type=float, nargs=3, default=[0.9, 0.6, 2.0])
    ap.add_argument("--layer", default="charts")
    ap.add_argument("--tiles", default="")
    ap.add_argument("--out", default=os.path.join(RAW, "tiles_check", "fmt"))
    args = ap.parse_args()
    if args.what in ("charts", "genshtab"):
        build(args.what, args)
    elif args.what == "index":
        write_index()
    elif args.what == "prepare":
        for layer in ("charts", "genshtab"):
            prepare_all(layer, workers=args.workers)
    else:
        test(args)


if __name__ == "__main__":
    main()
