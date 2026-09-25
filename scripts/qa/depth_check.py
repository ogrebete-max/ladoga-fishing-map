#!/usr/bin/env python3
"""How far can the depth model be trusted? (owner, 25.09.2026: «боюсь за точность модели глубин»)

Compares the model (site/data/depth_grid.json → site/data/depth/*.json, the same lookup as the app's gridDepth)
with what we have besides it:
  1. the free Garmin maps made by anglers (freegpsmap 2007, С. Новиков 2005 — site/data/depth_community.geojson):
     their soundings and isobaths are a hand digitisation of the same ГУНиО charts, so they check our reading of
     the charts (OCR, georeferencing, interpolation), not the age of the survey;
  2. depths anglers reported at GPS points (class A reports of site/data/points.json with a depth);
  3. the Volgo-Balt ENC of 2023 at the Volkhov mouth (site/data/depth_vvp.geojson, already reduced to the chart zero).
Writes research/depth_check.md and prints the numbers.

  python scripts/qa/depth_check.py
"""
import base64
import json
import math
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"


class Grid:
    """The app's lookup (site/app.js gridDepth): files by priority; bilinear over the valid cells of the four
    around the point; a point with none of them valid falls to the next file."""

    def __init__(self):
        idx = json.loads((SITE / "data" / "depth_grid.json").read_text(encoding="utf-8"))
        self.files = sorted(idx["files"], key=lambda f: f.get("priority", 9))
        self.cache = {}

    def _load(self, f):
        if f["file"] not in self.cache:
            j = json.loads((SITE / f["file"]).read_text(encoding="utf-8"))
            raw = base64.b64decode(j["data"])
            vals = [raw[i] | (raw[i + 1] << 8) for i in range(0, len(raw), 2)]
            self.cache[f["file"]] = (j, vals)
        return self.cache[f["file"]]

    def depth(self, lat, lon):
        for f in self.files:
            (s, w), (n, e) = f["bounds"]
            if not (s <= lat <= n and w <= lon <= e):
                continue
            j, vals = self._load(f)
            nx, ny, dlat, dlon = j["nx"], j["ny"], j["dlat"], j["dlon"]
            fr = (n - lat) / dlat - 0.5
            fc = (lon - w) / dlon - 0.5
            r0, c0 = math.floor(fr), math.floor(fc)
            acc = wsum = 0.0
            for dr in (0, 1):
                for dc in (0, 1):
                    r, c = r0 + dr, c0 + dc
                    if 0 <= r < ny and 0 <= c < nx:
                        v = vals[r * nx + c]
                        if v != j["nodata"]:
                            wgt = (1 - abs(fr - r)) * (1 - abs(fc - c))
                            acc += wgt * v / j["scale"]
                            wsum += wgt
            if wsum > 0.05:
                return acc / wsum
        return None


def stats(diffs):
    a = sorted(abs(d) for d in diffs)
    if not a:
        return None
    q = lambda p: a[min(len(a) - 1, int(p * len(a)))]
    return {"n": len(a), "median_abs": round(statistics.median(a), 2), "p90_abs": round(q(0.9), 2),
            "over_1m": round(100 * sum(1 for x in a if x > 1) / len(a), 1), "over_2m": round(100 * sum(1 for x in a if x > 2) / len(a), 1),
            "bias": round(statistics.mean(diffs), 2)}


def main():
    grid = Grid()
    out = {}

    # 1. Community Garmin maps: soundings (multipoints) and isobath vertices.
    gj = json.loads((SITE / "data" / "depth_community.geojson").read_text(encoding="utf-8"))
    snd, iso, by_src = [], [], defaultdict(list)
    worst = []
    for f in gj["features"]:
        p = f["properties"]
        d = p.get("depth_m")
        if d is None:
            continue
        geom = f["geometry"]
        coords = geom["coordinates"] if geom["type"] in ("MultiPoint", "LineString") else []
        for k, (lon, lat) in enumerate(coords):
            if geom["type"] == "LineString" and k % 3:
                continue  # every third vertex is plenty
            m = grid.depth(lat, lon)
            if m is None:
                continue
            diff = m - d  # plus: the model is deeper than the Garmin map (the dangerous side)
            (snd if p.get("kind") == "sounding" else iso).append(diff)
            by_src[p.get("source")].append(diff)
            if p.get("kind") == "sounding" and diff > 2 and d < 4:
                worst.append((round(diff, 1), d, round(m, 1), round(lat, 5), round(lon, 5)))
    out["garmin_soundings"] = stats(snd)
    out["garmin_isobaths"] = stats(iso)
    out["garmin_by_source"] = {k: stats(v) for k, v in by_src.items()}
    out["garmin_model_deeper_by_1m_pct"] = round(100 * sum(1 for x in snd if x > 1) / max(1, len(snd)), 1)

    # 2. Anglers' GPS points with a depth.
    pts = json.loads((SITE / "data" / "points.json").read_text(encoding="utf-8"))
    ang = []
    for r in pts["reports"]:
        if r.get("cls") != "A" or not r.get("depth") or r["kind"] != "fishing":
            continue
        nums = [float(x.replace(",", ".")) for x in re.findall(r"\d+(?:[.,]\d+)?", r["depth"])]
        nums = [x for x in nums if 0.3 <= x <= 60]
        if not nums:
            continue
        told = sum(nums[:2]) / len(nums[:2])
        m = grid.depth(r["lat"], r["lon"])
        if m is None:
            continue
        ang.append(m - told)
    out["anglers_gps_depths"] = stats(ang)

    # 3. ENC 2023, Volkhov mouth (chart zero): the change since the 1984 chart, by zone.
    vvp = json.loads((SITE / "data" / "depth_vvp.geojson").read_text(encoding="utf-8"))
    enc = defaultdict(list)
    for f in vvp["features"]:
        lon, lat = f["geometry"]["coordinates"][:2]
        d = f["properties"].get("m")  # the ENC depth reduced to the chart zero (d is from the ENC's own datum, ПУ)
        m = grid.depth(lat, lon)
        if d is None or m is None:
            continue
        enc[f["properties"].get("z") or "all"].append(m - d)
    out["enc2023_volkhov"] = {k: stats(v) for k, v in enc.items()}

    worst.sort(key=lambda x: -abs(x[0]))
    out["garmin_shallow_but_model_deep"] = worst[:60]
    out["garmin_shallow_but_model_deep_n"] = len(worst)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    (ROOT / "research" / "raw").mkdir(parents=True, exist_ok=True)
    (ROOT / "research" / "raw" / "depth_check.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
