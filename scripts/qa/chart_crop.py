#!/usr/bin/env python3
"""A piece of our ГУНиО chart tiles around a point, with the point marked — to check a depth question by eye.

    python scripts/qa/chart_crop.py OUT.png lat lon [label] [--z 15] [--r 1]   (r: tiles around the centre one)
    python scripts/qa/chart_crop.py --grid OUT.png lat,lon,label [lat,lon,label ...]   (several crops side by side)
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
TILES = ROOT / "site" / "tiles" / "charts"


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def crop(lat, lon, label="", z=15, r=1):
    fx, fy = tile_xy(lat, lon, z)
    tx, ty = int(fx), int(fy)
    size = (2 * r + 1) * 256
    img = Image.new("RGB", (size, size), (200, 200, 200))
    found = 0
    for dx in range(-r, r + 1):
        for dy in range(-r, r + 1):
            p = TILES / str(z) / str(tx + dx) / f"{ty + dy}.webp"
            if p.exists():
                img.paste(Image.open(p).convert("RGB"), ((dx + r) * 256, (dy + r) * 256))
                found += 1
    px, py = (fx - tx + r) * 256, (fy - ty + r) * 256
    d = ImageDraw.Draw(img)
    d.ellipse([px - 14, py - 14, px + 14, py + 14], outline=(255, 0, 0), width=3)
    d.line([px - 22, py, px - 8, py], fill=(255, 0, 0), width=2)
    d.line([px + 8, py, px + 22, py], fill=(255, 0, 0), width=2)
    d.rectangle([0, 0, size, 22], fill=(255, 255, 255))
    d.text((4, 4), f"{label}  {lat:.5f},{lon:.5f}  z{z}  tiles {found}", fill=(0, 0, 0))
    return img


def main():
    args = sys.argv[1:]
    if args and args[0] == "--grid":
        out, items = args[1], args[2:]
        crops = []
        for it in items:
            lat, lon, *lab = it.split(",", 2)
            crops.append(crop(float(lat), float(lon), lab[0] if lab else ""))
        cols = min(3, len(crops))
        rows = math.ceil(len(crops) / cols)
        w, h = crops[0].size
        sheet = Image.new("RGB", (cols * w, rows * h), (255, 255, 255))
        for i, c in enumerate(crops):
            sheet.paste(c, ((i % cols) * w, (i // cols) * h))
        sheet.save(out)
        return
    out, lat, lon = args[0], float(args[1]), float(args[2])
    label = args[3] if len(args) > 3 and not args[3].startswith("--") else ""
    z = int(args[args.index("--z") + 1]) if "--z" in args else 15
    r = int(args[args.index("--r") + 1]) if "--r" in args else 1
    crop(lat, lon, label, z, r).save(out)


if __name__ == "__main__":
    main()
