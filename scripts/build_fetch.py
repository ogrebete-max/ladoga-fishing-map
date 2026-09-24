"""Build site/data/fetch.json: wind-wave fetch table for the south of Lake Ladoga.

For every water cell of an adaptive grid over the project bbox (2.2 / 1.1 / 0.55 km) and each of 16 wind
directions (the direction the wind comes FROM) the table stores
  * the fetch F, km: SPM-1984 averaged fetch = arithmetic mean of 9 radials at 3-degree steps within +-12 degrees
    of the wind direction, each radial marched upwind over water until it meets land (islands included), capped
    at 150 km;
  * the representative depth d, m: mean depth along the first min(F, 20 km) of those radials (length-weighted,
    pooled over the 9 radials), from the chart datum (long-term mean lake level, as in the depth model).
The client (scripts/fetch_wave.js) feeds F, d and the forecast wind to the SPM-1984 shallow-water formulas.

Inputs
  * water: OpenStreetMap (ODbL, (c) OpenStreetMap contributors) -- the whole Lake Ladoga multipolygon
    (outer ring + 2 164 islands) and rivers / canals / bays in the bbox, fetched once from Overpass and cached
    in research/raw/waves/; the site's depth model (site/data/depth_grid.json + site/data/depth/*.json) is
    checked against it and fills water the fresh OSM lacks (outside islands);
  * depth: the site's depth model (GUNiO chart soundings, 25/50 m) where it has data; elsewhere in the lake
    GLDB v2 (Choulga et al., CC BY; research/raw/depth/gldb_ladoga_depth_dm.npy, 30"); rivers/canals without
    data get a default depth.
Ray marching is done on a 50 m UTM-36N raster of the whole lake with distance-transform ("sphere tracing") steps.

Usage:  python scripts/build_fetch.py                     downloads missing OSM files once, writes site/data/fetch.json
        python scripts/build_fetch.py --cache DIR         keeps mask / depth / ray arrays in DIR for quick re-runs
        python scripts/build_fetch.py --places roses.json fetch roses of reference places (table vs direct rays)
        python scripts/build_fetch.py --validate val.json compares with Open-Meteo MFWAM / ECWAM, Lotsia, ERA5 climate
        node scripts/fetch_wave.test.js                   checks the JS client against fetch.json and this file
Raw downloads (OSM, Open-Meteo): env LADOGA_RAW_WAVES or the first research/raw/waves found upwards from the repo.
"""
import argparse
import base64
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "site" / "data"
UA = "ladoga-fishing-map-research/1.0"

# project bbox and output grid (row 0 = north, as in the depth model)
OUT_S, OUT_N, OUT_W, OUT_E = 59.85, 60.81, 30.90, 33.42
DLAT0, DLON0, LEVELS = 0.02, 0.04, 3          # level 0 = 0.02 x 0.04 deg (~2.2 km), level 2 = 0.005 x 0.01 (~0.55 km)
NDIR = 16
FETCH_CAP_KM = 150.0
DEPTH_WINDOW_KM = 20.0
DEPTH_SAMPLE_M = 500.0
RADIALS_SPM84 = [-12, -9, -6, -3, 0, 3, 6, 9, 12]  # degrees, SPM 1984 / CEM restricted-fetch rule
ANG_STEP = 1.5                                    # ray bundle step, degrees (240 rays per point)
RES = 50.0                                        # ray-marching raster, m (UTM 36N)
RASTER_LL = (29.70, 59.78, 33.55, 61.86)          # lon/lat extent of the raster (whole lake + project bbox)
DEFAULT_DEPTH = {"river": 5.0, "canal": 3.0, "other": 2.0}
# 6-bit codes (one base64url character per value)
B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
F_MIN, F_MAX = 0.05, FETCH_CAP_KM      # km:  F = F_MIN * (F_MAX/F_MIN)^(v/63)
D_MIN, D_MAX = 0.3, 120.0              # m:   d = D_MIN * (D_MAX/D_MIN)^(v/63)

T_LL2UTM = Transformer.from_crs(4326, 32636, always_xy=True)
T_UTM2LL = Transformer.from_crs(32636, 4326, always_xy=True)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def find_raw():
    env = os.environ.get("LADOGA_RAW_WAVES")
    if env:
        p = Path(env)
        p.mkdir(parents=True, exist_ok=True)
        return p
    for p in [ROOT, *ROOT.parents]:
        cand = p / "research" / "raw" / "waves"
        if cand.is_dir():
            return cand
    p = ROOT / "research" / "raw" / "waves"
    p.mkdir(parents=True, exist_ok=True)
    return p


RAW = find_raw()


# ----------------------------------------------------------------------------------------------- downloads
def overpass(query, out_path, timeout=200):
    import requests
    eps = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter"]
    for ep in eps:
        try:
            r = requests.post(ep, data={"data": query}, headers={"User-Agent": UA}, timeout=(15, timeout))
        except Exception as e:  # noqa: BLE001
            log("overpass", ep, repr(e)[:120])
            time.sleep(2)
            continue
        if r.status_code == 200 and r.text.lstrip().startswith("{"):
            d = r.json()
            if d.get("elements"):
                d.update(_endpoint=ep, _query=query, _fetched=time.strftime("%Y-%m-%d %H:%M:%S"))
                json.dump(d, open(out_path, "w", encoding="utf-8"), ensure_ascii=False)
                return d
        log("overpass", ep, r.status_code, r.text[:120])
        time.sleep(2)
    raise RuntimeError("Overpass failed: " + str(out_path))


def load_lake_relation():
    cached = sorted(RAW.glob("osm_ladoga_rel*.json"))
    if cached:
        return json.load(open(cached[-1], encoding="utf-8"))
    log("downloading the Lake Ladoga multipolygon (Overpass, once)")
    q = '[out:json][timeout:170];rel["natural"="water"]["wikidata"="Q15288"];out body geom qt;'
    tmp = RAW / "osm_ladoga_rel_tmp.json"
    d = overpass(q, tmp)
    rid = d["elements"][0]["id"]
    tmp.replace(RAW / f"osm_ladoga_rel{rid}.json")
    return d


def load_bbox_water():
    p = RAW / "osm_water_rivers_bbox.json"
    if p.exists():
        return json.load(open(p, encoding="utf-8"))
    log("downloading rivers / canals / bays in the bbox (Overpass, once)")
    bb = "59.80,30.80,60.85,33.50"
    x = "^(lake|pond|reservoir|basin|wastewater|fishpond)$"
    q = f"""[out:json][timeout:170];
(
  way["natural"="water"]["water"!~"{x}"]({bb});
  relation["natural"="water"]["water"!~"{x}"]({bb});
  way["waterway"="riverbank"]({bb});
  relation["waterway"="riverbank"]({bb});
  way["waterway"~"^(river|canal)$"]({bb});
);
out body geom({bb}) qt;"""
    return overpass(q, p)


# ----------------------------------------------------------------------------------------------- raster grid
class Grid:
    def __init__(self):
        lo0, la0, lo1, la1 = RASTER_LL
        t = np.linspace(0, 1, 200)
        los = np.r_[lo0 + (lo1 - lo0) * t, np.full_like(t, lo1), lo1 - (lo1 - lo0) * t, np.full_like(t, lo0)]
        las = np.r_[np.full_like(t, la0), la0 + (la1 - la0) * t, np.full_like(t, la1), la1 - (la1 - la0) * t]
        x, y = T_LL2UTM.transform(los, las)
        self.X0 = math.floor(x.min() / 1000) * 1000.0
        self.X1 = math.ceil(x.max() / 1000) * 1000.0
        self.Y0 = math.floor(y.min() / 1000) * 1000.0
        self.Y1 = math.ceil(y.max() / 1000) * 1000.0
        self.nx = int(round((self.X1 - self.X0) / RES))
        self.ny = int(round((self.Y1 - self.Y0) / RES))

    def ll2px(self, lon, lat):
        """continuous pixel coords: pixel (i, j) spans col j..j+1, row i..i+1"""
        x, y = T_LL2UTM.transform(np.asarray(lon, float), np.asarray(lat, float))
        return (x - self.X0) / RES, (self.Y1 - y) / RES

    def px2ll(self, col, row):
        x = self.X0 + np.asarray(col, float) * RES
        y = self.Y1 - np.asarray(row, float) * RES
        return T_UTM2LL.transform(x, y)

    def centers_ll(self, rows, cols):
        return self.px2ll(np.asarray(cols) + 0.5, np.asarray(rows) + 0.5)


def runs_of(e):
    """coordinate runs of an Overpass element (None nodes = clipped by the bbox)"""
    def split(geom):
        out, cur = [], []
        for p in geom or []:
            if p is None:
                if len(cur) > 1:
                    out.append(cur)
                cur = []
            else:
                cur.append((p["lon"], p["lat"]))
        if len(cur) > 1:
            out.append(cur)
        return out
    if e["type"] == "way":
        return {"outer": split(e.get("geometry"))}
    res = {"outer": [], "inner": []}
    for m in e.get("members", []):
        if m.get("type") == "way":
            res["inner" if m.get("role") == "inner" else "outer"] += split(m.get("geometry"))
    return res


def rings_from_runs(runs):
    """merge runs into rings; open pieces (clipped at the query bbox) are closed with a straight segment"""
    from shapely.geometry import LineString
    from shapely.ops import linemerge
    if not runs:
        return []
    merged = linemerge([LineString(r) for r in runs if len(r) > 1])
    geoms = [merged] if merged.geom_type == "LineString" else list(merged.geoms)
    out = []
    for g in geoms:
        c = np.asarray(g.coords)
        if len(c) >= 3:
            out.append(c)
    return out


def draw_rings(grid, rings, shape_hw, off=(0, 0), outline_width=0):
    """rasterise rings (lon/lat arrays) into a bool array; even-odd composition by the caller"""
    h, w = shape_hw
    img = Image.new("1", (w, h), 0)
    d = ImageDraw.Draw(img)
    for rg in rings:
        c, r = grid.ll2px(rg[:, 0], rg[:, 1])
        pts = list(zip((c - 0.5 - off[1]).tolist(), (r - 0.5 - off[0]).tolist()))
        if len(pts) >= 3:
            d.polygon(pts, fill=1, outline=1)
            if outline_width > 1:
                d.line(pts + [pts[0]], fill=1, width=outline_width)
    return np.array(img, dtype=bool)


def draw_lines(grid, lines, shape_hw, width=1):
    h, w = shape_hw
    img = Image.new("1", (w, h), 0)
    d = ImageDraw.Draw(img)
    for ln in lines:
        c, r = grid.ll2px(ln[:, 0], ln[:, 1])
        d.line(list(zip((c - 0.5).tolist(), (r - 0.5).tolist())), fill=1, width=width)
    return np.array(img, dtype=bool)


def rasterise_element(grid, e, target):
    """even-odd fill of one OSM polygon element into target (windowed)"""
    rr = runs_of(e)
    outer = rings_from_runs(rr.get("outer", []))
    inner = rings_from_runs(rr.get("inner", []))
    if not outer:
        return 0
    allpts = np.concatenate(outer)
    c, r = grid.ll2px(allpts[:, 0], allpts[:, 1])
    c0, c1 = max(0, int(c.min()) - 2), min(grid.nx, int(c.max()) + 3)
    r0, r1 = max(0, int(r.min()) - 2), min(grid.ny, int(r.max()) + 3)
    if c1 <= c0 or r1 <= r0:
        return 0
    m = draw_rings(grid, outer, (r1 - r0, c1 - c0), off=(r0, c0))
    if inner:
        m &= ~draw_rings(grid, inner, (r1 - r0, c1 - c0), off=(r0, c0))
    target[r0:r1, c0:c1] |= m
    return int(m.sum())


# ----------------------------------------------------------------------------------------------- depth model
def load_depth_model():
    idx = json.load(open(DATA / "depth_grid.json", encoding="utf-8"))
    grids = []
    for f in sorted(idx["files"], key=lambda f: f["priority"]):
        g = json.load(open(DATA / f["file"].replace("data/", ""), encoding="utf-8"))
        u = np.frombuffer(base64.b64decode(g["data"]), dtype="<u2").reshape(g["ny"], g["nx"])
        g["u"] = u
        del g["data"]
        grids.append(g)
    return idx, grids


def depth_model_at(grids, lon, lat):
    """bilinear depth (m, chart datum) with the app's lookup rule; NaN outside the model"""
    lon = np.asarray(lon, float)
    lat = np.asarray(lat, float)
    out = np.full(lon.shape, np.nan)
    for g in grids:
        (S, W), (N, E) = g["bounds"]
        sel = np.isnan(out) & (lat >= S) & (lat <= N) & (lon >= W) & (lon <= E)
        if not sel.any():
            continue
        fx = (lon[sel] - W) / g["dlon"] - 0.5
        fy = (N - lat[sel]) / g["dlat"] - 0.5
        x0 = np.floor(fx).astype(int)
        y0 = np.floor(fy).astype(int)
        tx, ty = fx - x0, fy - y0
        s = np.zeros(fx.shape)
        w = np.zeros(fx.shape)
        for dy, dx, k in ((0, 0, (1 - tx) * (1 - ty)), (0, 1, tx * (1 - ty)), (1, 0, (1 - tx) * ty), (1, 1, tx * ty)):
            y, x = y0 + dy, x0 + dx
            ok = (y >= 0) & (x >= 0) & (y < g["ny"]) & (x < g["nx"])
            v = np.full(fx.shape, g["nodata"], dtype=np.int64)
            v[ok] = g["u"][y[ok], x[ok]]
            ok &= v != g["nodata"]
            s += np.where(ok, k * v / g["scale"], 0.0)
            w += np.where(ok, k, 0.0)
        val = np.where(w > 0.05, s / np.maximum(w, 1e-9), np.nan)
        tmp = out[sel]
        tmp[:] = val
        out[sel] = tmp
    return out


def gldb_loader():
    for p in [RAW.parent / "depth", *[q / "research" / "raw" / "depth" for q in [ROOT, *ROOT.parents]]]:
        if (p / "gldb_ladoga_depth_dm.npy").exists():
            meta = json.load(open(p / "gldb_ladoga_meta.json", encoding="utf-8"))
            dep = np.load(p / "gldb_ladoga_depth_dm.npy").astype(float) / 10.0
            st = np.load(p / "gldb_ladoga_status.npy")
            return meta, dep, st
    raise FileNotFoundError("GLDB window research/raw/depth/gldb_ladoga_*.npy not found")


# ----------------------------------------------------------------------------------------------- stage 1: mask
def build_mask(grid, cache):
    if cache and (cache / "mask.npz").exists():
        z = np.load(cache / "mask.npz")
        log("mask from cache")
        return {k: z[k] for k in z.files}
    shape = (grid.ny, grid.nx)
    log("raster", shape, "px of", RES, "m;", round(grid.nx * grid.ny / 1e6, 1), "Mpx")
    lake_rel = load_lake_relation()["elements"][0]
    rr = runs_of(lake_rel)
    outer = rings_from_runs(rr["outer"])
    inner = rings_from_runs(rr["inner"])
    log("lake: outer rings", len(outer), "islands", len(inner))
    lake = draw_rings(grid, outer, shape)
    islands = draw_rings(grid, inner, shape)
    shore = draw_lines(grid, outer, shape, width=2)
    lake &= ~islands
    lake &= ~shore
    water_osm = load_bbox_water()
    river = np.zeros(shape, bool)
    canal = np.zeros(shape, bool)
    other = np.zeros(shape, bool)
    canal_lines = []
    lake_id = lake_rel["id"]
    for e in water_osm["elements"]:
        if e["id"] == lake_id and e["type"] == "relation":
            continue
        t = e.get("tags", {})
        wtr, ww, nat = t.get("water", ""), t.get("waterway", ""), t.get("natural", "")
        if ww in ("river", "canal") and nat != "water":
            if ww == "canal":
                for r_ in runs_of(e)["outer"]:
                    canal_lines.append(np.asarray(r_))
            continue
        if wtr == "canal" or ww == "canal":
            rasterise_element(grid, e, canal)
        elif wtr in ("river", "oxbow", "riverbank", "stream") or ww == "riverbank":
            rasterise_element(grid, e, river)
        elif nat == "water":
            rasterise_element(grid, e, other)
    if canal_lines:
        canal |= draw_lines(grid, canal_lines, shape, width=1)
    log("osm px: lake", int(lake.sum()), "river", int(river.sum()), "canal", int(canal.sum()), "other", int(other.sum()))
    # pass 1: what is connected to the lake at all
    allw = lake | river | canal | other
    allw &= ~islands | river
    lab, n = ndimage.label(allw | shore & ~islands, structure=np.ones((3, 3)))
    ids = np.unique(lab[lake])
    conn1 = np.isin(lab, ids[ids > 0])
    other_c = other & conn1
    river_c = river & conn1
    # pass 2: the shore line is a barrier except at river mouths / bays, so canals behind a dam stay separate
    open_zone = ndimage.binary_dilation(river_c | other_c, iterations=3)
    barrier = shore & ~open_zone
    water = (lake | river_c | other_c | (canal & conn1)) & ~barrier
    water |= shore & open_zone & ~islands
    # depth-model water (site grids): add what fresh OSM lacks, but never on islands / shore barrier
    idx, grids = load_depth_model()
    rows, cols = np.nonzero(conn1 | ndimage.binary_dilation(water, iterations=6))
    lon, lat = grid.centers_ll(rows, cols)
    dm = depth_model_at(grids, lon, lat)
    dmw = np.zeros(shape, bool)
    dmw[rows, cols] = ~np.isnan(dm)
    isl_d = ndimage.binary_dilation(islands, iterations=1)
    add = dmw & ~water & ~isl_d & ~barrier
    in_frames = np.zeros(shape, bool)
    for g in grids:
        (S, W), (N, E) = g["bounds"]
        c_, r_ = grid.ll2px(np.array([W, E, E, W]), np.array([S, S, N, N]))
        in_frames[max(0, int(r_.min())):int(r_.max()) + 1, max(0, int(c_.min())):int(c_.max()) + 1] = True
    stats = {
        "depthmodel_water_px": int(dmw.sum()),
        "osm_water_px_in_depthmodel_bounds": int((water & in_frames).sum()),
        "both_px": int((dmw & water).sum()),
        "depthmodel_only_px": int((dmw & ~water).sum()),
        "depthmodel_only_on_islands_px": int((dmw & ~water & isl_d).sum()),
        "added_px": int(add.sum()),
    }
    water |= add
    # keep water components (after barriers) that contain OSM water connected to the lake in pass 1;
    # isolated ponds / lakes become land for the rays and get no cells
    lab2, _ = ndimage.label(water, structure=np.ones((3, 3)))
    seed = np.unique(lab2[water & conn1 & ~add])
    kept = np.isin(lab2, seed[seed > 0])
    near_river = ndimage.binary_dilation(river_c | other_c, iterations=4)
    cls = np.zeros(shape, np.uint8)            # 0 land, 1 lake, 2 river / bay, 3 canal
    cls[kept & canal] = 3
    cls[kept & (river_c | other_c | (add & near_river))] = 2
    cls[kept & (lake | (add & ~near_river))] = 1
    cls[kept & (cls == 0)] = 2                 # opened shore pixels at river mouths
    log("kept water px", int(kept.sum()), "lake", int((cls == 1).sum()), "river/bay", int((cls == 2).sum()),
        "canal", int((cls == 3).sum()), stats)
    out = {"cls": cls, "islands": islands, "dm_stats": np.array(json.dumps(stats))}
    if cache:
        np.savez_compressed(cache / "mask.npz", **out)
    return out


def build_depth(grid, cls, cache):
    if cache and (cache / "depth.npy").exists():
        log("depth from cache")
        return np.load(cache / "depth.npy")
    _, grids = load_depth_model()
    dep = np.full(cls.shape, np.nan, np.float32)
    rows, cols = np.nonzero(cls > 0)
    lon, lat = grid.centers_ll(rows, cols)
    d = depth_model_at(grids, lon, lat)
    src = np.where(np.isnan(d), 0, 1).astype(np.uint8)
    # GLDB for the lake where the depth model has no data
    meta, gd, gs = gldb_loader()
    res = meta["res_deg"]
    valid = gs == 3
    _, (ii, jj) = ndimage.distance_transform_edt(~valid, return_indices=True)
    gi = np.clip(((meta["north_edge_lat"] - lat) / res).astype(int), 0, gd.shape[0] - 1)
    gj = np.clip(((lon - meta["west_edge_lon"]) / res).astype(int), 0, gd.shape[1] - 1)
    gval = gd[ii[gi, gj], jj[gi, gj]]
    c = cls[rows, cols]
    use_g = np.isnan(d) & (c == 1)
    d[use_g] = gval[use_g]
    src[use_g] = 2
    for k, name in ((2, "river"), (3, "canal")):
        m = np.isnan(d) & (c == k)
        d[m] = DEFAULT_DEPTH[name]
        src[m] = 3
    d = np.clip(d, 0.2, 250.0)
    dep[rows, cols] = d
    log("depth px: model", int((src == 1).sum()), "GLDB", int((src == 2).sum()), "default", int((src == 3).sum()))
    if cache:
        np.save(cache / "depth.npy", dep)
    return dep


# ----------------------------------------------------------------------------------------------- stage 2: rays
G = 9.81


def spm(U, F_km, d):
    """SPM-1984 shallow-water fetch-limited wind sea (Hs m, Ts s); numpy-vectorised"""
    U = np.asarray(U, float)
    UA = 0.71 * U ** 1.23
    F = np.asarray(F_km, float) * 1000.0
    d = np.maximum(np.asarray(d, float), 0.1)
    a = 0.530 * (G * d / UA ** 2) ** 0.75
    b = 0.833 * (G * d / UA ** 2) ** 0.375
    ta, tb = np.tanh(a), np.tanh(b)
    hs = 0.283 * ta * np.tanh(0.00565 * np.sqrt(G * F / UA ** 2) / ta) * UA ** 2 / G
    ts = 7.54 * tb * np.tanh(0.0379 * np.cbrt(G * F / UA ** 2) / tb) * UA / G
    return hs, ts


def _rep_points(rows, cols, cid, ncell):
    """per group (cid): centroid of its pixels, snapped to the nearest pixel of the group"""
    n = np.bincount(cid, minlength=ncell).astype(float)
    mr = np.bincount(cid, weights=rows, minlength=ncell) / np.maximum(n, 1)
    mc = np.bincount(cid, weights=cols, minlength=ncell) / np.maximum(n, 1)
    d2 = (rows - mr[cid]) ** 2 + (cols - mc[cid]) ** 2
    order = np.lexsort((d2, cid))
    cid_o = cid[order]
    first = order[np.r_[True, cid_o[1:] != cid_o[:-1]]]
    return cid[first], rows[first], cols[first]


def level2_cells(grid, cls):
    """Representative point of every level-2 cell (0.005 x 0.01 deg) that holds kept water.
    Class priority lake > river/bay > canal: a cell touching the open lake gets the lake's exposure; the point is
    the centroid of that class's pixels in the cell, snapped to the nearest such pixel.
    Mixed cells (lake + river/canal water) also get an 'alt' point in their river/canal water and a 4 x 4 sub-cell
    mask (~140 m): bit set = the sub-cell holds river/canal water and no lake water."""
    dl2, dn2 = DLAT0 / 2 ** (LEVELS - 1), DLON0 / 2 ** (LEVELS - 1)
    ny2 = int(round((OUT_N - OUT_S) / dl2))
    nx2 = int(round((OUT_E - OUT_W) / dn2))
    ncell = ny2 * nx2
    c_, r_ = grid.ll2px(np.array([OUT_W, OUT_E, OUT_E, OUT_W]), np.array([OUT_S, OUT_S, OUT_N, OUT_N]))
    r0, r1 = max(0, int(r_.min()) - 2), min(grid.ny, int(r_.max()) + 3)
    c0, c1 = max(0, int(c_.min()) - 2), min(grid.nx, int(c_.max()) + 3)
    rows, cols = np.nonzero(cls[r0:r1, c0:c1])
    rows = rows + r0
    cols = cols + c0
    lon, lat = grid.centers_ll(rows, cols)
    fi = (OUT_N - lat) / dl2
    fj = (lon - OUT_W) / dn2
    ci = np.floor(fi).astype(np.int64)
    cj = np.floor(fj).astype(np.int64)
    ok = (ci >= 0) & (cj >= 0) & (ci < ny2) & (cj < nx2)
    rows, cols, ci, cj, fi, fj = rows[ok], cols[ok], ci[ok], cj[ok], fi[ok], fj[ok]
    k = cls[rows, cols].astype(np.int64)
    cid = ci * nx2 + cj
    nall = np.bincount(cid, minlength=ncell)
    best = np.full(ncell, 9, np.int64)
    np.minimum.at(best, cid, k)
    sel = k == best[cid]
    cells, rr, cc = _rep_points(rows[sel], cols[sel], cid[sel], ncell)
    out = {"cid": cells, "row": rr, "col": cc, "cls": best[cells].astype(np.uint8), "npx": nall[cells],
           "ny2": ny2, "nx2": nx2}
    alt = (k >= 2) & (best[cid] == 1)
    si = np.clip(np.floor((fi - ci) * 4).astype(np.int64), 0, 3)
    sj = np.clip(np.floor((fj - cj) * 4).astype(np.int64), 0, 3)
    sub = cid * 16 + si * 4 + sj
    has_lake = np.zeros(ncell * 16, bool)
    has_lake[sub[k == 1]] = True
    has_alt = np.zeros(ncell * 16, bool)
    has_alt[sub[alt]] = True
    bits = (has_alt & ~has_lake).reshape(ncell, 16)
    mask = (bits.astype(np.int64) << np.arange(16)).sum(1)
    acells, ar, ac = _rep_points(rows[alt], cols[alt], cid[alt], ncell)
    keep = mask[acells] > 0
    out.update(alt_cid=acells[keep], alt_row=ar[keep], alt_col=ac[keep], alt_mask=mask[acells][keep])
    log("level-2 cells with water:", len(cells), "of", ncell, {int(v): int((out["cls"] == v).sum()) for v in (1, 2, 3)},
        "mixed lake + river/canal:", int(len(acells)), "with separable sub-cells:", int(keep.sum()))
    return out


def march(edt, ox, oy, dx, dy, tmax):
    """distance (px) from (ox, oy) along (dx, dy) to the first land pixel; sphere tracing on the EDT"""
    H, W = edt.shape
    t = np.zeros(ox.shape, np.float32)
    L = np.full(ox.shape, tmax, np.float32)
    act = np.arange(ox.size)
    while act.size:
        tt = t[act]
        x = ox[act] + tt * dx[act]
        y = oy[act] + tt * dy[act]
        j = np.floor(x).astype(np.int32)
        i = np.floor(y).astype(np.int32)
        inb = (i >= 0) & (j >= 0) & (i < H) & (j < W)
        e = np.zeros(act.size, np.float32)
        e[inb] = edt[i[inb], j[inb]]
        stop = e <= 0
        L[act[stop]] = tt[stop]
        tn = tt + np.maximum(e - 1.5, 0.5)
        t[act] = tn
        act = act[~stop & (tn < tmax)]
    return L


def dir_indices(offsets_deg):
    A = int(round(360 / ANG_STEP))
    per = int(round(360 / NDIR / ANG_STEP))
    return np.array([[(per * k + int(round(o / ANG_STEP))) % A for o in offsets_deg] for k in range(NDIR)])


def cast_points(grid, cls, dep, rows_f, cols_f, chunk=400):
    """rays from points given in continuous pixel coords; returns fetch (km) variants and mean depth"""
    water = cls > 0
    edt = ndimage.distance_transform_edt(water).astype(np.float32)
    A = int(round(360 / ANG_STEP))
    ang = np.deg2rad(np.arange(A) * ANG_STEP)
    lon, lat = grid.px2ll(cols_f, rows_f)
    x0, y0 = T_LL2UTM.transform(lon, lat)
    x1, y1 = T_LL2UTM.transform(lon, np.asarray(lat) + 0.01)
    north = np.arctan2(x1 - x0, y1 - y0)            # grid bearing of true north
    tmax = FETCH_CAP_KM * 1000 / RES
    wpx = DEPTH_WINDOW_KM * 1000 / RES
    i84 = dir_indices(RADIALS_SPM84)                 # (16, 9)
    sav_off = np.arange(-42, 43, 6)
    isav = dir_indices(sav_off)                       # (16, 15)
    wsav = np.cos(np.deg2rad(sav_off))
    i1 = dir_indices([0])[:, 0]
    N = len(rows_f)
    res = {"F84": np.zeros((N, NDIR), np.float32), "Fsav": np.zeros((N, NDIR), np.float32),
           "F1": np.zeros((N, NDIR), np.float32), "D": np.zeros((N, NDIR), np.float32),
           "D1": np.zeros((N, NDIR), np.float32), "L": np.zeros((N, A), np.float32)}
    nmax = int(DEPTH_WINDOW_KM * 1000 / DEPTH_SAMPLE_M)
    msamp = np.arange(nmax, dtype=np.float32)
    t0 = time.time()
    for s in range(0, N, chunk):
        sl = slice(s, min(N, s + chunk))
        n = sl.stop - sl.start
        beta = ang[None, :] + north[sl, None]
        dx = np.sin(beta).astype(np.float32)
        dy = (-np.cos(beta)).astype(np.float32)
        ox = np.repeat(np.asarray(cols_f[sl], np.float32), A)
        oy = np.repeat(np.asarray(rows_f[sl], np.float32), A)
        L = march(edt, ox, oy, dx.ravel(), dy.ravel(), tmax).reshape(n, A)
        res["L"][sl] = L
        Lkm = L * RES / 1000.0
        res["F84"][sl] = Lkm[:, i84].mean(axis=2)
        res["Fsav"][sl] = (Lkm[:, isav] * wsav ** 2).sum(axis=2) / wsav.sum()
        res["F1"][sl] = Lkm[:, i1]
        # depth along the 9 radials, first min(L, 20 km), samples every 500 m (at least one)
        Lr = np.minimum(L[:, i84], wpx)                                  # (n,16,9) px
        ns = np.clip(np.ceil(Lr * RES / DEPTH_SAMPLE_M), 1, nmax)
        sp = (msamp + 0.5)[None, None, None, :] / ns[..., None] * Lr[..., None]   # (n,16,9,m)
        valid = msamp[None, None, None, :] < ns[..., None]
        dxr, dyr = dx[:, i84], dy[:, i84]
        xs = np.asarray(cols_f[sl], np.float32)[:, None, None, None] + sp * dxr[..., None]
        ys = np.asarray(rows_f[sl], np.float32)[:, None, None, None] + sp * dyr[..., None]
        jj = np.clip(np.floor(xs).astype(np.int32), 0, dep.shape[1] - 1)
        ii = np.clip(np.floor(ys).astype(np.int32), 0, dep.shape[0] - 1)
        v = dep[ii, jj]
        ok = valid & ~np.isnan(v)
        v = np.where(ok, v, 0)
        res["D"][sl] = v.sum(axis=(2, 3)) / np.maximum(ok.sum(axis=(2, 3)), 1)
        res["D1"][sl] = v[:, :, 4, :].sum(axis=2) / np.maximum(ok[:, :, 4, :].sum(axis=2), 1)
        if (s // chunk) % 10 == 0:
            log(f"rays {sl.stop}/{N} points, {time.time() - t0:.0f} s")
    return res


# ----------------------------------------------------------------------------------------------- stage 3: tree
TOL_REL, TOL_ABS = 0.17, 0.05  # a node is one leaf if Hs(8 and 15 m/s) of each of its 0.55 km cells is within this
ISO_KM = 2.0                   # sheltered water (every direction's fetch <= 2 km): one isotropic, conservative value
DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
# node codes
NONE, FULL, SPLIT, ISO, MIX_ISO, MIX_FULL = 0, 1, 2, 3, 4, 5


def code6(vals, vmin, vmax):
    v = np.round(63 * np.log(np.clip(np.asarray(vals, float), vmin, vmax) / vmin) / np.log(vmax / vmin))
    return np.clip(v, 0, 63).astype(int)


def decode6(v, vmin, vmax):
    return vmin * (vmax / vmin) ** (np.asarray(v, float) / 63.0)


def build_tree(F2, D2, mix, tol_rel=TOL_REL, tol_abs=TOL_ABS, iso_km=ISO_KM):
    """Quadtree over the output grid. F2, D2: (ny2, nx2, 16), NaN where there is no water;
    mix: {(r2, c2): (mask16, F_alt[16], D_alt[16])} for cells mixing lake and river/canal water.
    Leaves: FULL (16 fetch + 16 depth), ISO (one fetch + one depth for all directions: every cell of the node has
    fetch <= iso_km -> largest fetch and depth, conservative), MIX_* (level-2 cell: lake record + 4x4 sub-cell mask +
    record of the river/canal water, ISO or FULL). A node above level 2 is a FULL leaf when Hs at 8 and 15 m/s from
    the mean F, d of its cells stays within tol_rel*Hs + tol_abs of every cell's own Hs and it holds no mixed cell."""
    L = LEVELS
    ny0, nx0 = F2.shape[0] >> (L - 1), F2.shape[1] >> (L - 1)
    codes, full, iso, mixes = [], [], [], []
    mixgrid = np.zeros(F2.shape[:2], bool)
    for (r2, c2) in mix:
        mixgrid[r2, c2] = True

    def ok(cF, cD, pF, pD):
        for U in (8.0, 15.0):
            hc, _ = spm(U, cF, cD)
            hp, _ = spm(U, pF, pD)
            if np.any(np.abs(hc - hp) > tol_rel * hp + tol_abs):
                return False
        return True

    def node(level, r, c):
        k = 1 << (L - 1 - level)
        fF = F2[r * k:(r + 1) * k, c * k:(c + 1) * k].reshape(-1, NDIR)
        fD = D2[r * k:(r + 1) * k, c * k:(c + 1) * k].reshape(-1, NDIR)
        w = ~np.isnan(fF[:, 0])
        if not w.any():
            codes.append(NONE)
            return
        mixed = [(rr, cc) for rr in range(r * k, (r + 1) * k) for cc in range(c * k, (c + 1) * k) if mixgrid[rr, cc]]
        fmax = max([fF[w].max()] + [mix[m][1].max() for m in mixed])
        dmax = max([fD[w].max()] + [mix[m][2].max() for m in mixed])
        if fmax <= iso_km:
            codes.append(ISO)
            iso.append((level, r, c, fmax, dmax))
            return
        pF, pD = fF[w].mean(0), fD[w].mean(0)
        if level == L - 1:
            if mixed:
                mask, aF, aD = mix[(r, c)]
                full.append((level, r, c, pF, pD))
                mixes.append(mask)
                if aF.max() <= iso_km:
                    codes.append(MIX_ISO)
                    iso.append((level, r, c, aF.max(), aD.max()))
                else:
                    codes.append(MIX_FULL)
                    full.append((level, r, c, aF, aD))
                return
            codes.append(FULL)
            full.append((level, r, c, pF, pD))
            return
        if not mixed and ok(fF[w], fD[w], pF, pD):
            codes.append(FULL)
            full.append((level, r, c, pF, pD))
            return
        codes.append(SPLIT)
        for dr, dc in ((0, 0), (0, 1), (1, 0), (1, 1)):
            node(level + 1, 2 * r + dr, 2 * c + dc)

    for r in range(ny0):
        for c in range(nx0):
            node(0, r, c)
    return codes, full, iso, mixes


def pack_tree(codes):
    """two node codes (0..7) per base64url character: v = 8*a + b"""
    cs = list(codes) + [0] * (len(codes) % 2)
    return "".join(B64[8 * cs[i] + cs[i + 1]] for i in range(0, len(cs), 2))


ABOUT = (
    "Разгон ветровой волны и средняя глубина на разгоне для оценки волны у берега южной Ладоги по формулам SPM-1984 "
    "(мелководье, ограниченный разгон); оценка ±30 %, не для навигации. "
    "ENCODING. Quadtree over a base grid of ny x nx cells, dlat x dlon deg, row 0 = north: base cell (r,c) spans "
    "lat [N-(r+1)*dlat, N-r*dlat], lon [W+c*dlon, W+(c+1)*dlon]. 'tree': base64url chars, each = two node codes "
    "(v = alphabet.indexOf(ch): v>>3, v&7), pre-order, base cells row-major. Codes: 0 no water; 2 split into 4 "
    "children NW, NE, SW, SE (half size; finest level 2 = 0.005 x 0.01 deg ~ 0.55 km); 1 leaf: next record of "
    "'fetch' and 'depth' (16 chars each); 3 isotropic leaf: next 2 chars of 'iso' (fetch, depth for all "
    "directions); 4 and 5 mixed leaf (level 2, lake + river/canal): next fetch/depth record = lake, next 3 chars of "
    "'mix' = 16-bit mask (m = v0<<12 | v1<<6 | v2) over a 4x4 sub-grid (~140 m), bit (4*i+j) for sub-row i from "
    "north and sub-column j from west: set = river/canal water, use the second record = next 'iso' pair (code 4) or "
    "next fetch/depth record (code 5). One char per wind direction in 'dirs' order (N, NNE, ... clockwise, the "
    "direction the wind comes FROM); value v (0..63): fetch F_km = 0.05*3000^(v/63) (0.05..150 km, step 13.5 %), "
    "depth d_m = 0.3*400^(v/63) (0.3..120 m, step 10 %). "
    "FETCH = SPM-1984 restricted-fetch rule: mean of 9 radials at 3 deg steps within +-12 deg of the wind direction, "
    "each marched upwind on a 50 m water raster of the whole lake (islands are land) to the first land, cap 150 km. "
    "DEPTH = mean depth along the first min(F, 20 km) of those radials, m below the chart datum (long-term mean lake "
    "level, as in depth_grid.json; add the current level anomaly, 2026: about -0.9 m). Cells that touch the open lake "
    "carry the lake's exposure except their river/canal sub-cells; isotropic leaves use the largest fetch and depth "
    "of the node for every direction (conservative)."
)


def mask_chars(m):
    return B64[(m >> 12) & 63] + B64[(m >> 6) & 63] + B64[m & 63]


def write_json(codes, full, iso, mixes, stats, path):
    F = np.array([r[3] for r in full])
    D = np.array([r[4] for r in full])
    out = {
        "format": "ladoga-fetch/1",
        "generated": time.strftime("%Y-%m-%d"),
        "about": ABOUT,
        "sources": [
            "Вода: OpenStreetMap (ODbL, © участники OpenStreetMap) — Ладожское озеро с островами, реки, каналы, губы",
            "Глубины: модель глубин по картам ГУНиО (data/depth_grid.json); вне карт — GLDB v2 (Choulga et al., CC BY)",
            "Формулы: Shore Protection Manual (CERC, 1984), гл. 3: мелководье, ограниченный разгон, разгон ±12°",
        ],
        "grid": {"N": OUT_N, "S": OUT_S, "W": OUT_W, "E": OUT_E, "dlat": DLAT0, "dlon": DLON0,
                 "ny": int(round((OUT_N - OUT_S) / DLAT0)), "nx": int(round((OUT_E - OUT_W) / DLON0)),
                 "levels": LEVELS},
        "dirs": DIRS,
        "alphabet": B64,
        "fetch_code": {"min_km": F_MIN, "max_km": F_MAX},
        "depth_code": {"min_m": D_MIN, "max_m": D_MAX},
        "stats": stats,
        "tree": pack_tree(codes),
        "fetch": "".join(B64[v] for v in code6(F, F_MIN, F_MAX).ravel()),
        "depth": "".join(B64[v] for v in code6(D, D_MIN, D_MAX).ravel()),
        "iso": "".join(B64[a] + B64[b] for a, b in zip(code6([r[3] for r in iso], F_MIN, F_MAX),
                                                         code6([r[4] for r in iso], D_MIN, D_MAX))),
        "mix": "".join(mask_chars(int(m)) for m in mixes),
    }
    txt = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    Path(path).write_text(txt, encoding="utf-8")
    return len(txt.encode("utf-8"))


# ----------------------------------------------------------------------------------------------- python twin of the client
class FetchTable:
    """decoder + lookup identical to scripts/fetch_wave.js (used for checks and the report)"""

    def __init__(self, fd):
        self.fd = fd
        g = fd["grid"]
        dig = []
        for ch in fd["tree"]:
            v = B64.index(ch)
            dig += [v >> 3, v & 7]
        fc, dc = fd["fetch_code"], fd["depth_code"]
        fv = decode6([B64.index(ch) for ch in fd["fetch"]], fc["min_km"], fc["max_km"]).reshape(-1, NDIR)
        dv = decode6([B64.index(ch) for ch in fd["depth"]], dc["min_m"], dc["max_m"]).reshape(-1, NDIR)
        iv = [B64.index(ch) for ch in fd["iso"]]
        mv = [B64.index(ch) for ch in fd["mix"]]
        st = {"pos": 0, "nf": 0, "ni": 0, "nm": 0}

        def take_full():
            st["nf"] += 1
            return fv[st["nf"] - 1], dv[st["nf"] - 1]

        def take_iso():
            st["ni"] += 1
            a, b = iv[2 * st["ni"] - 2], iv[2 * st["ni"] - 1]
            return (np.full(NDIR, float(decode6(a, fc["min_km"], fc["max_km"]))),
                    np.full(NDIR, float(decode6(b, dc["min_m"], dc["max_m"]))))

        def parse(level, top, left, h, w):
            d = dig[st["pos"]]
            st["pos"] += 1
            box = {"level": level, "lat": top - h / 2, "lon": left + w / 2, "top": top, "left": left, "h": h, "w": w}
            if d == NONE:
                return None
            if d == SPLIT:
                h2, w2 = h / 2, w / 2
                return [parse(level + 1, top - i * h2, left + j * w2, h2, w2) for i in (0, 1) for j in (0, 1)]
            if d == FULL:
                F, D = take_full()
                return dict(box, F=F, D=D, iso=False)
            if d == ISO:
                F, D = take_iso()
                return dict(box, F=F, D=D, iso=True)
            F, D = take_full()                                   # MIX_ISO / MIX_FULL
            st["nm"] += 1
            a, b, c = mv[3 * st["nm"] - 3:3 * st["nm"]]
            mask = (a << 12) | (b << 6) | c
            aF, aD = take_iso() if d == MIX_ISO else take_full()
            return dict(box, F=F, D=D, iso=False, mask=mask, alt={"F": aF, "D": aD, "iso": d == MIX_ISO})

        self.root = [parse(0, g["N"] - r * g["dlat"], g["W"] + c * g["dlon"], g["dlat"], g["dlon"])
                     for r in range(g["ny"]) for c in range(g["nx"])]
        assert st["nf"] == len(fv) and 2 * st["ni"] == len(iv) and 3 * st["nm"] == len(mv), st

    def leaf(self, lat, lon):
        g = self.fd["grid"]
        r = math.floor((g["N"] - lat) / g["dlat"])
        c = math.floor((lon - g["W"]) / g["dlon"])
        if r < 0 or c < 0 or r >= g["ny"] or c >= g["nx"]:
            return None
        node = self.root[r * g["nx"] + c]
        top, left, h, w = g["N"] - r * g["dlat"], g["W"] + c * g["dlon"], g["dlat"], g["dlon"]
        while isinstance(node, list):
            h, w = h / 2, w / 2
            i = 1 if lat < top - h else 0
            j = 1 if lon >= left + w else 0
            top -= i * h
            left += j * w
            node = node[2 * i + j]
        if node is not None and "mask" in node:
            i = min(3, max(0, math.floor((node["top"] - lat) / (node["h"] / 4))))
            j = min(3, max(0, math.floor((lon - node["left"]) / (node["w"] / 4))))
            if node["mask"] >> (4 * i + j) & 1:
                h4, w4 = node["h"] / 4, node["w"] / 4
                t4, l4 = node["top"] - i * h4, node["left"] + j * w4
                return {"level": node["level"] + 2, "lat": t4 - h4 / 2, "lon": l4 + w4 / 2, "top": t4, "left": l4,
                        "h": h4, "w": w4, "F": node["alt"]["F"], "D": node["alt"]["D"], "iso": node["alt"]["iso"],
                        "river": True}
        return node

    def wave(self, lat, lon, wdir, U, level_m=0.0):
        lf = self.leaf(lat, lon)
        if lf is None:
            return None
        k = (wdir % 360.0) / (360.0 / NDIR)
        k0 = int(math.floor(k)) % NDIR
        k1 = (k0 + 1) % NDIR
        t = k - math.floor(k)
        F = lf["F"][k0] * (1 - t) + lf["F"][k1] * t
        d = max(0.3, lf["D"][k0] * (1 - t) + lf["D"][k1] * t + level_m)
        hs, ts = spm(U, F, d)
        return float(hs), float(ts), float(F), float(d), lf


PLACES = [  # (key, name, lat, lon) -- coordinates from site/data/points.json
    ("nladoga_lake", "Новая Ладога, озеро 5,5 км к СЗ", 60.131684, 32.231764),
    ("volkhov_mouth", "Устье Волхова (Немятово)", 60.120491, 32.319319),
    ("volkhov_issad", "р. Волхов у Иссада", 60.064805, 32.345053),
    ("krenitsy", "Креницы, 6 км от сараев", 60.182467, 32.228),
    ("ptinov", "к востоку от о. Птинов (17 км от Крениц)", 60.228772, 32.161988),
    ("sukho", "о. Сухо (у острова)", 60.406806, 32.090174),
    ("kobona", "Кобона, 1,2 км к З (бухта Петрокрепость)", 60.025646, 31.533428),
    ("kobona_canal", "Новоладожский канал у Кобоны", 60.023129, 31.549124),
    ("svir_bay", "Свирская губа", 60.598432, 32.812859),
    ("svirica", "Свирская губа, район «Свирица»", 60.518875, 32.799904),
    ("svir_river", "р. Свирь у Птичьего острова", 60.479217, 32.892208),
    ("shlisselburg", "Шлиссельбург, исток Невы", 59.948739, 31.039084),
    ("osinovets", "мыс Осиновец, 2 км к СВ", 60.13338, 31.108066),
    ("P1", "клетка MFWAM 60.2917 32.2083", 60.291664, 32.208344),
    ("P2", "клетка MFWAM 60.7083 32.7917", 60.708336, 32.791668),
    ("P3", "клетка MFWAM 60.5417 31.7083", 60.541668, 31.708334),
]


def places_report(grid, m, dep, fd, path):
    """fetch roses at named places: table values (what the client sees) and a direct 50 m computation at the point"""
    ft = FetchTable(fd)
    cls = m["cls"]
    rows, cols = [], []
    for key, name, lat, lon in PLACES:
        c, r = grid.ll2px(lon, lat)
        c, r = float(c), float(r)
        if cls[int(r), int(c)] == 0:          # on land at 50 m: snap to the nearest water pixel
            win = cls[int(r) - 20:int(r) + 21, int(c) - 20:int(c) + 21] > 0
            ii, jj = np.nonzero(win)
            if len(ii):
                kk = np.argmin((ii - 20) ** 2 + (jj - 20) ** 2)
                r, c = int(r) - 20 + ii[kk] + 0.5, int(c) - 20 + jj[kk] + 0.5
        rows.append(r)
        cols.append(c)
    direct = cast_points(grid, cls, dep, np.array(rows), np.array(cols), chunk=50)
    out = []
    for n, (key, name, lat, lon) in enumerate(PLACES):
        lf = ft.leaf(lat, lon)
        rec = {"key": key, "name": name, "lat": lat, "lon": lon,
               "direct": {"F84": direct["F84"][n].round(2).tolist(), "Fsav": direct["Fsav"][n].round(2).tolist(),
                          "F1": direct["F1"][n].round(2).tolist(), "D": direct["D"][n].round(1).tolist()}}
        if lf is not None:
            rec["table"] = {"F": np.round(lf["F"], 2).tolist(), "D": np.round(lf["D"], 1).tolist(),
                            "level": lf["level"], "iso": bool(lf["iso"]), "river_subcell": bool(lf.get("river")),
                            "cell_lat": round(lf["lat"], 5), "cell_lon": round(lf["lon"], 5)}
            rec["hs"] = {str(U): [round(ft.wave(lat, lon, 22.5 * k, U)[0], 2) for k in range(NDIR)]
                         for U in (8, 10, 15)}
            rec["ts"] = {str(U): [round(ft.wave(lat, lon, 22.5 * k, U)[1], 1) for k in range(NDIR)]
                         for U in (8, 10, 15)}
        out.append(rec)
    Path(path).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log("places report ->", path)


# ----------------------------------------------------------------------------------------------- validation (--validate)
VAL_POINTS = {  # open-lake cells of MFWAM (1/12 deg) -- requested coordinates, the API snaps to its cell centre
    "P1": ("север Волховской губы", 60.29, 32.21),
    "P2": ("север Свирской губы", 60.71, 32.79),
    "P3": ("открытое озеро, юг", 60.54, 31.71),
}
VAL_CLIMATE = {  # ERA5 cell -> place of the fetch table (the ERA5 cell at Osinovets itself is land-affected)
    "sukho": ("о. Сухо", 60.41, 32.09, "sukho"), "osinovets": ("м. Осиновец", 60.12, 31.10, "osinovets"),
    "osinovets_lake": ("м. Осиновец, ветер ERA5 открытой клетки к СВ", 60.25, 31.25, "osinovets")}
VAL_START, VAL_END = "2025-05-01", "2026-09-22"


def om_get(url, params, name):
    """Open-Meteo request, cached as research/raw/waves/om_<name>.json; one request at a time, >= 1.5 s apart"""
    import requests
    p = RAW / f"om_{name}.json"
    if p.exists():
        return json.load(open(p, encoding="utf-8"))
    for _ in range(3):
        try:
            r = requests.get(url, params=params, headers={"User-Agent": UA}, timeout=(15, 120))
        except Exception as e:  # noqa: BLE001
            log(name, "error", repr(e)[:150])
            time.sleep(5)
            continue
        time.sleep(1.5)
        if r.status_code == 200:
            d = r.json()
            d["_url"] = r.url
            d["_fetched"] = time.strftime("%Y-%m-%d %H:%M:%S")
            json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False)
            log("downloaded", p.name, len(r.content), "bytes")
            return d
        log(name, r.status_code, r.text[:200])
        time.sleep(5)
    return None


def download_validation():
    mv = ("wave_height,wave_period,wave_peak_period,wave_direction,wind_wave_height,wind_wave_period,"
          "wind_wave_peak_period,wind_wave_direction,swell_wave_height")
    for key, (_, la, lo) in VAL_POINTS.items():
        om_get("https://marine-api.open-meteo.com/v1/marine",
               {"latitude": la, "longitude": lo, "hourly": mv, "models": "meteofrance_wave,ecmwf_wam025",
                "start_date": VAL_START, "end_date": VAL_END, "timezone": "UTC"}, f"marine_{key}")
        om_get("https://archive-api.open-meteo.com/v1/archive",
               {"latitude": la, "longitude": lo, "hourly": "wind_speed_10m,wind_direction_10m", "models": "era5",
                "wind_speed_unit": "ms", "start_date": VAL_START, "end_date": "2026-09-14", "timezone": "UTC"},
               f"era5_{key}")
        om_get("https://historical-forecast-api.open-meteo.com/v1/forecast",
               {"latitude": la, "longitude": lo, "hourly": "wind_speed_10m,wind_direction_10m",
                "models": "ecmwf_ifs025,ecmwf_ifs", "wind_speed_unit": "ms", "start_date": VAL_START,
                "end_date": VAL_END, "timezone": "UTC"}, f"ifs_{key}")
    for key, (_, la, lo, _p) in VAL_CLIMATE.items():
        om_get("https://archive-api.open-meteo.com/v1/archive",
               {"latitude": la, "longitude": lo, "hourly": "wind_speed_10m,wind_direction_10m", "models": "era5",
                "wind_speed_unit": "ms", "start_date": "2015-01-01", "end_date": "2024-12-31", "timezone": "UTC",
                **({"cell_selection": "sea"} if key.endswith("_lake") else {})},
               f"era5clim_{key}")


def steady_hours(dirs, speeds):
    """same rule as steadyWindHours() in fetch_wave.js, for every hour"""
    n = len(dirs)
    out = np.zeros(n)
    for i in range(n):
        if not (speeds[i] > 0):
            continue
        k = i
        while k >= 0:
            dd = abs(((dirs[k] - dirs[i]) % 360 + 540) % 360 - 180)
            if dd > 45 or not (speeds[k] >= 0.6 * speeds[i]):
                break
            k -= 1
        out[i] = i - k
    return out


def series(d, var):
    v = d["hourly"].get(var)
    return np.array([np.nan if x is None else x for x in v], float) if v is not None else None


def ours(ft, lat, lon, wdir, U, dur=None, level_m=0.0):
    """hourly SPM estimate at a point: fetch-limited, optionally duration-limited (same as waveAt)"""
    lf = ft.leaf(lat, lon)
    k = (np.asarray(wdir) % 360.0) / 22.5
    k0 = np.floor(k).astype(int) % NDIR
    k1 = (k0 + 1) % NDIR
    t = k - np.floor(k)
    F = lf["F"][k0] * (1 - t) + lf["F"][k1] * t
    d = np.maximum(0.3, lf["D"][k0] * (1 - t) + lf["D"][k1] * t + level_m)
    if dur is not None:
        UA = 0.71 * np.maximum(U, 0.31) ** 1.23
        Fd = UA * UA / G * (G * np.maximum(dur, 1) * 3600 / (68.8 * UA)) ** 1.5 / 1000
        F = np.minimum(F, Fd)
    hs, ts = spm(np.maximum(U, 0.31), F, d)
    return np.where(U > 0.3, hs, 0.0), np.where(U > 0.3, ts, 0.0)


def stats_line(o, m):
    ok = ~np.isnan(o) & ~np.isnan(m)
    o, m = o[ok], m[ok]
    if len(o) < 5:
        return {"n": int(len(o))}
    return {"n": int(len(o)), "mfwam_mean": round(float(m.mean()), 2), "ours_mean": round(float(o.mean()), 2),
            "bias": round(float((o - m).mean()), 2), "median_ratio": round(float(np.median(o / np.maximum(m, 0.05))), 2),
            "rmse": round(float(np.sqrt(((o - m) ** 2).mean())), 2), "r": round(float(np.corrcoef(o, m)[0, 1]), 2),
            "within30": round(float((np.abs(o - m) <= 0.3 * m + 0.05).mean()), 2)}


def validate(fd, out_path=None):
    download_validation()
    ft = FetchTable(fd)
    res = {"points": {}, "lotsia": {}, "climate": {}}
    for key, (name, la, lo) in VAL_POINTS.items():
        ma = json.load(open(RAW / f"om_marine_{key}.json", encoding="utf-8"))
        er = json.load(open(RAW / f"om_era5_{key}.json", encoding="utf-8"))
        ifs = json.load(open(RAW / f"om_ifs_{key}.json", encoding="utf-8"))
        clat, clon = ma["latitude"], ma["longitude"]            # MFWAM cell centre
        times = ma["hourly"]["time"]
        hs_mf = series(ma, "wave_height_meteofrance_wave")
        ww_mf = series(ma, "wind_wave_height_meteofrance_wave")
        tp_mf = series(ma, "wind_wave_period_meteofrance_wave")
        hs_ec = series(ma, "wave_height_ecmwf_wam025")
        winds = {}
        for tag, src, sfx in (("ifs025", ifs, "_ecmwf_ifs025"), ("ifs9", ifs, "_ecmwf_ifs"), ("era5", er, "")):
            idx = {t: i for i, t in enumerate(src["hourly"]["time"])}
            sp, dr = series(src, "wind_speed_10m" + sfx), series(src, "wind_direction_10m" + sfx)
            if sp is None or np.all(np.isnan(sp)):
                continue
            U = np.array([sp[idx[t]] if t in idx else np.nan for t in times])
            D = np.array([dr[idx[t]] if t in idx else np.nan for t in times])
            winds[tag] = (U, D)
        month = np.array([int(t[5:7]) for t in times])
        season = (month >= 5) & (month <= 11)
        pr = {"name": name, "mfwam_cell": [clat, clon], "table_leaf_level": ft.leaf(clat, clon)["level"],
              "mfwam_hours": int(np.sum(~np.isnan(hs_mf))), "ecwam_hours": int(np.sum(~np.isnan(hs_ec)))
              if hs_ec is not None else 0, "winds": {}}
        for tag, (U, D) in winds.items():
            Uz, Dz = np.nan_to_num(U), np.nan_to_num(D)
            dur = steady_hours(Dz, Uz)
            h_f, t_f = ours(ft, clat, clon, Dz, Uz)
            h_d, t_d = ours(ft, clat, clon, Dz, Uz, dur)
            h_f[np.isnan(U)] = np.nan
            h_d[np.isnan(U)] = np.nan
            st = {}
            for lo_, hi_ in ((6, 8), (8, 10), (10, 12), (12, 30), (8, 30)):
                sel = season & (U >= lo_) & (U < hi_)
                st[f"{lo_}-{hi_}"] = {"fetch": stats_line(h_f[sel], hs_mf[sel]),
                                      "fetch+duration": stats_line(h_d[sel], hs_mf[sel]),
                                      "fetch_vs_windsea": stats_line(h_f[sel], ww_mf[sel]),
                                      "fetch+duration_vs_windsea": stats_line(h_d[sel], ww_mf[sel])}
            sel = season & (U >= 8) & ~np.isnan(tp_mf)
            st["period_8+"] = {"ours_ts_mean": round(float(np.nanmean(t_d[sel])), 2) if sel.any() else None,
                               "mfwam_windsea_period_mean": round(float(np.nanmean(tp_mf[sel])), 2) if sel.any() else None}
            # windy days: top days by max wind (season), daily maxima
            days = {}
            for i, tm in enumerate(times):
                if season[i] and not np.isnan(U[i]):
                    days.setdefault(tm[:10], []).append(i)
            top = sorted(days, key=lambda dd: -np.nanmax(U[days[dd]]))[:10]
            st["windy_days"] = []
            for dd in sorted(top):
                ii = days[dd]
                j = ii[int(np.nanargmax(U[ii]))]
                st["windy_days"].append({
                    "day": dd, "u_max": round(float(np.nanmax(U[ii])), 1), "dir_at_max": int(round(D[j])),
                    "mfwam_hs_max": None if np.all(np.isnan(hs_mf[ii])) else round(float(np.nanmax(hs_mf[ii])), 2),
                    "ecwam_hs_max": None if hs_ec is None or np.all(np.isnan(hs_ec[ii])) else round(float(np.nanmax(hs_ec[ii])), 2),
                    "ours_hs_max": round(float(np.nanmax(h_f[ii])), 2),
                    "ours_dur_hs_max": round(float(np.nanmax(h_d[ii])), 2)})
            if hs_ec is not None:
                sel = season & (U >= 8)
                st["ecwam_vs_mfwam_8+"] = stats_line(hs_ec[sel], hs_mf[sel])
            pr["winds"][tag] = st
        res["points"][key] = pr
    # Lotsia: bays under strong northerly winds
    bays = [p for p in PLACES if p[0] in ("nladoga_lake", "krenitsy", "ptinov", "kobona", "osinovets", "svir_bay",
                                           "svirica", "sukho", "P1")]
    for key, name, la, lo in bays:
        rows = {}
        for U in (12, 15, 18, 20):
            best = None
            for wd in (315, 337.5, 0, 22.5, 45):
                hs, ts, F, d, _ = ft.wave(la, lo, wd, U)
                hs9, ts9, *_ = ft.wave(la, lo, wd, U, level_m=-0.9)
                if best is None or hs > best[1]:
                    best = (wd, round(hs, 2), round(ts, 1), round(F, 1), round(d, 1), round(hs9, 2))
            rows[str(U)] = best
        res["lotsia"][key] = {"name": name, "worst_northerly (dir, Hs, Ts, F, d, Hs_level-0.9)": rows}
    # climate at Sukho and Osinovets with ERA5 winds 2015-2024
    for key, (name, la, lo, pk) in VAL_CLIMATE.items():
        er = json.load(open(RAW / f"om_era5clim_{key}.json", encoding="utf-8"))
        U, D = series(er, "wind_speed_10m"), series(er, "wind_direction_10m")
        tt = er["hourly"]["time"]
        month = np.array([int(t[5:7]) for t in tt])
        Uz, Dz = np.nan_to_num(U), np.nan_to_num(D)
        dur = steady_hours(Dz, Uz)
        _, _, pla, plo = [p for p in PLACES if p[0] == pk][0]
        h_f, _ = ours(ft, pla, plo, Dz, Uz)
        h_d, _ = ours(ft, pla, plo, Dz, Uz, dur)
        c = {"name": name, "era5_cell": [er["latitude"], er["longitude"]],
             "u_median_may_nov": round(float(np.median(Uz[(month >= 5) & (month <= 11)])), 1)}
        nav = (month >= 5) & (month <= 11)
        dmax = {}
        for i in np.nonzero(nav)[0]:
            dmax[tt[i][:10]] = max(dmax.get(tt[i][:10], 0.0), float(h_d[i]))
        c["share_hours_hs_lt_0.25"] = round(float((h_d[nav] < 0.25).mean()), 3)
        c["share_days_max_hs_lt_0.25"] = round(float(np.mean([v < 0.25 for v in dmax.values()])), 3)
        for lab, mm in (("may_nov", (month >= 5) & (month <= 11)), ("jul", month == 7), ("oct", month == 10)):
            c[lab] = {"median_fetch": round(float(np.median(h_f[mm])), 2),
                      "median_fetch_dur": round(float(np.median(h_d[mm])), 2),
                      "share_gt_0.9_fetch_dur": round(float((h_d[mm] > 0.9).mean()), 3),
                      "p99_fetch_dur": round(float(np.quantile(h_d[mm], 0.99)), 2),
                      "max_fetch": round(float(h_f[mm].max()), 2), "max_fetch_dur": round(float(h_d[mm].max()), 2)}
        res["climate"][key] = c
    txt = json.dumps(res, ensure_ascii=False, indent=1)
    if out_path:
        Path(out_path).write_text(txt, encoding="utf-8")
    log("validation done", out_path or "")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None, help="dir for intermediate arrays (speeds up re-runs)")
    ap.add_argument("--stage", default="all")
    ap.add_argument("--tol", type=float, default=TOL_REL)
    ap.add_argument("--out", default=str(DATA / "fetch.json"))
    ap.add_argument("--places", default=None, help="write fetch roses of reference places to this json")
    ap.add_argument("--validate", default=None, help="compare with Open-Meteo MFWAM etc., write stats json here")
    a = ap.parse_args()
    cache = Path(a.cache) if a.cache else None
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
    grid = Grid()
    m = build_mask(grid, cache)
    dep = build_depth(grid, m["cls"], cache)
    if a.stage == "mask":
        return
    if cache and (cache / "cells.npz").exists():
        z = np.load(cache / "cells.npz")
        cells = {k: z[k] for k in z.files}
        log("cells + rays from cache")
    else:
        cells = level2_cells(grid, m["cls"])
        rays = cast_points(grid, m["cls"], dep, cells["row"] + 0.5, cells["col"] + 0.5)
        cells.update({k: v for k, v in rays.items() if k != "L"})
        rays = cast_points(grid, m["cls"], dep, cells["alt_row"] + 0.5, cells["alt_col"] + 0.5)
        cells.update({"alt_" + k: v for k, v in rays.items() if k != "L"})
        if cache:
            np.savez_compressed(cache / "cells.npz", **cells)
    ny2, nx2 = int(cells["ny2"]), int(cells["nx2"])
    F2 = np.full((ny2 * nx2, NDIR), np.nan)
    D2 = np.full((ny2 * nx2, NDIR), np.nan)
    F2[cells["cid"]] = np.clip(cells["F84"], F_MIN, F_MAX)
    D2[cells["cid"]] = np.clip(cells["D"], D_MIN, D_MAX)
    F2 = F2.reshape(ny2, nx2, NDIR)
    D2 = D2.reshape(ny2, nx2, NDIR)
    mix = {(int(cid) // nx2, int(cid) % nx2): (int(mk), np.clip(f, F_MIN, F_MAX), np.clip(d, D_MIN, D_MAX))
           for cid, mk, f, d in zip(cells["alt_cid"], cells["alt_mask"], cells["alt_F84"], cells["alt_D"])}
    codes, full, iso, mixes = build_tree(F2, D2, mix, a.tol)
    cnt = np.bincount(codes, minlength=6).tolist()
    stats = {"leaves": {"full": cnt[FULL], "isotropic": cnt[ISO], "mixed": cnt[MIX_ISO] + cnt[MIX_FULL],
                        "split_nodes": cnt[SPLIT]},
             "cells_0.55km_with_water": int(len(cells["cid"])),
             "merge_rule": f"Hs(8, 15 m/s) of every 0.55 km cell within {a.tol:.0%} + {TOL_ABS} m; "
                           f"isotropic if fetch <= {ISO_KM} km",
             "mask_vs_depth_model_px": json.loads(str(m["dm_stats"]))}
    size = write_json(codes, full, iso, mixes, stats, a.out)
    log("codes", cnt, "records full", len(full), "iso", len(iso), "mix", len(mixes), "->", a.out, size, "bytes")
    # self-check: decode what was written and compare with the 0.55 km cells it represents
    fd = json.load(open(a.out, encoding="utf-8"))
    ft = FetchTable(fd)
    lon_c, lat_c = grid.centers_ll(cells["row"], cells["col"])
    errs = []
    for n in range(0, len(cells["cid"]), 7):
        lf = ft.leaf(float(lat_c[n]), float(lon_c[n]))
        assert lf is not None, (lat_c[n], lon_c[n])
        if lf.get("river"):
            continue
        h0, _ = spm(10.0, F2.reshape(-1, NDIR)[cells["cid"][n]], D2.reshape(-1, NDIR)[cells["cid"][n]])
        h1, _ = spm(10.0, lf["F"], lf["D"])
        errs.append((h1 - h0) / np.maximum(h0, 0.05))
    e = np.concatenate(errs)
    log(f"decode check on {len(errs)} cells: Hs(10 m/s) rel. error median {np.median(np.abs(e)):.3f}, "
        f"p95 {np.quantile(np.abs(e), 0.95):.3f}, min {e.min():+.3f}, max {e.max():+.3f}")
    lon_a, lat_a = grid.centers_ll(cells["alt_row"], cells["alt_col"])
    n_riv = sum(1 for la, lo in zip(lat_a, lon_a) if (ft.leaf(float(la), float(lo)) or {}).get("river"))
    log(f"river/canal points of mixed cells resolved to their own record: {n_riv} of {len(lat_a)}")
    if a.places:
        places_report(grid, m, dep, fd, a.places)
    if a.validate:
        validate(fd, a.validate)


if __name__ == "__main__":
    main()
