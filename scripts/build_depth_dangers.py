#!/usr/bin/env python3
"""Shallow places the depth model does not show — for the navigator's depth and shallow-water warnings.

The model (a 25–50 m grid through the chart soundings) smooths a single rock or a small shoal between its cells:
the owner's check of 25.09.2026 found e.g. the rock of 1.2 m on the Northern Torpakova bank shown as 6.7 m, and a
1.6 m patch at the Sodomskie islands as 5.6 m (scripts/qa/depth_check.py, research/depth_check.md). The navigator
therefore takes the SMALLER of the model and these points:
  chart  — soundings of the ГУНиО charts over a danger (in brackets / a dotted circle: danger_least_depth), and
           chart soundings the model shows ≥ 0.7 m deeper than printed (research/soundings.geojson, our OCR);
  garmin — soundings of the free anglers' Garmin maps (site/data/depth_community.geojson, a hand digitisation of the
           same charts) ≥ 1.5 m shallower than the model, kept only when a chart sounding within 150 m confirms a
           shallow place there (≤ the Garmin depth + 1 m) or it is a danger the OCR missed next to charted rocks —
           not on a Garmin isobath line and not «0» (the Garmin errors found by eye: isobath labels read as soundings);
           where the model says under 8 m, a Garmin shoal is kept unless a chart sounding within 15 m says ≥ 1,5 m deeper.
Only places to 5 m: deeper ones are no danger to a boat (the warnings go to 5 m at most).

Writes site/data/depth_dangers.json: {"v":1, "points": [[lat, lon, depth_m, src], ...]} (src: c chart, g garmin).

    python scripts/build_depth_dangers.py
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "qa"))
from depth_check import Grid  # noqa: E402  (the app's own lookup)

ROOT = Path(__file__).resolve().parents[1]
MAX_DEPTH = 5.0


def dist_m(a_lat, a_lon, b_lat, b_lon):
    k = math.cos(math.radians(a_lat)) * 111320
    return math.hypot((b_lon - a_lon) * k, (b_lat - a_lat) * 110540)


class Cells:
    """A coarse spatial index: 0.002° cells (~220 × 110 m)."""

    def __init__(self, pts):
        self.cells = {}
        for p in pts:
            self.cells.setdefault((round(p[0] / 0.002), round(p[1] / 0.002)), []).append(p)

    def near(self, lat, lon, r):
        ci, cj = round(lat / 0.002), round(lon / 0.002)
        span = int(r / 110) + 1
        for di in range(-span, span + 1):
            for dj in range(-span, span + 1):
                for p in self.cells.get((ci + di, cj + dj), ()):
                    if dist_m(lat, lon, p[0], p[1]) <= r:
                        yield p


def main():
    grid = Grid()
    snd = json.loads((ROOT / "research" / "soundings.geojson").read_text(encoding="utf-8"))["features"]
    chart_pts, out, why = [], [], {"danger": 0, "smoothed": 0, "garmin_confirmed": 0, "garmin_near_danger": 0}
    for f in snd:
        lon, lat = f["geometry"]["coordinates"][:2]
        p = f["properties"]
        d = p.get("danger_least_depth", p.get("depth_m"))
        if d is None:
            continue
        chart_pts.append((lat, lon, float(p["depth_m"]), p.get("danger_least_depth") is not None))
        if d > MAX_DEPTH or (p.get("qc") and p.get("danger_least_depth") is None):
            continue  # doubtful readings stay out unless they mark a danger
        m = grid.depth(lat, lon)
        if p.get("danger_least_depth") is not None:
            out.append([round(lat, 6), round(lon, 6), round(float(d), 1), "c"]); why["danger"] += 1
        elif m is not None and m - d >= 0.7:
            out.append([round(lat, 6), round(lon, 6), round(float(d), 1), "c"]); why["smoothed"] += 1
    cells = Cells(chart_pts)

    gj = json.loads((ROOT / "site" / "data" / "depth_community.geojson").read_text(encoding="utf-8"))["features"]
    lines = []
    for f in gj:
        if f["geometry"]["type"] == "LineString":
            for lon, lat in f["geometry"]["coordinates"]:
                lines.append((lat, lon, 0, False))
    line_cells = Cells(lines)
    for f in gj:
        if f["geometry"]["type"] != "MultiPoint":
            continue
        d = f["properties"].get("depth_m")
        if d is None or d <= 0.05 or d > 3:
            continue
        for lon, lat in f["geometry"]["coordinates"]:
            m = grid.depth(lat, lon)
            if m is None or m - d < 1.5:
                continue
            if any(True for _ in line_cells.near(lat, lon, 20)):
                continue  # on an isobath: a label read as a sounding
            near = list(cells.near(lat, lon, 150))
            if any(q[2] <= d + 1 for q in near):
                out.append([round(lat, 6), round(lon, 6), round(float(d), 1), "g"]); why["garmin_confirmed"] += 1
            elif any(q[3] for q in cells.near(lat, lon, 400)):
                out.append([round(lat, 6), round(lon, 6), round(float(d), 1), "g"]); why["garmin_near_danger"] += 1
            elif m < 8 and not any(q[2] >= d + 1.5 for q in cells.near(lat, lon, 15)):
                # Checked by eye on the charts (25.09.2026): where the model says under 8 m, such a Garmin sounding was a
                # real small shoal every time (a closed 1.8 m contour at Железница, 1.6 m at the Содомские islands, a
                # 0.4 m band at Кобона); in deeper water it was a Garmin error (an isobath label read as «1»).
                out.append([round(lat, 6), round(lon, 6), round(float(d), 1), "g"]); why["garmin_shallow_area"] = why.get("garmin_shallow_area", 0) + 1
    # One point per 30 m: the shallowest.
    out.sort(key=lambda p: p[2])
    kept, keep_cells = [], Cells([])
    for p in out:
        if any(True for _ in keep_cells.near(p[0], p[1], 30)):
            continue
        kept.append(p)
        keep_cells.cells.setdefault((round(p[0] / 0.002), round(p[1] / 0.002)), []).append((p[0], p[1]))
    kept.sort(key=lambda p: (p[0], p[1]))
    doc = {"v": 1, "about": "Мелкие места, которые модель глубин сглаживает: отметки карт ГУНиО над опасностями, сглаженные "
                            "моделью отметки и подтверждённые картой отметки любительских карт Garmin. Глубина — от нуля карт.",
           "counts": why, "points": kept}
    (ROOT / "site" / "data" / "depth_dangers.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({**why, "kept": len(kept)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
