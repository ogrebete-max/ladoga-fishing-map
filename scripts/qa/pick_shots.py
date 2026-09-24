#!/usr/bin/env python3
"""Copy chosen QA screenshots into design/qa/ as small PNGs (≤ 300 KB each, palette PNG, downscaled if needed).

  python scripts/qa/pick_shots.py research/raw/qa/iphone15/s1-02-start-overlap.png=01-start-hint-over-scale.png ...
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'design' / 'qa'
LIMIT = 300 * 1024


def shrink(src: Path, dst: Path, max_w=1000):
    im = Image.open(src).convert('RGB')
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    scale = 1.0
    for colors in (256, 192, 128, 96, 64):
        for _ in range(6):
            w, h = round(im.width * scale), round(im.height * scale)
            cur = im if scale == 1.0 else im.resize((w, h), Image.LANCZOS)
            q = cur.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
            q.save(dst, optimize=True)
            if dst.stat().st_size <= LIMIT:
                return dst.stat().st_size, (w, h), colors
            scale *= 0.9
        scale = 1.0
    return dst.stat().st_size, (w, h), colors


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    for arg in sys.argv[1:]:
        src, _, name = arg.partition('=')
        src = (ROOT / src) if not Path(src).is_absolute() else Path(src)
        dst = DEST / (name or src.name)
        size, wh, colors = shrink(src, dst)
        print(f'{dst.relative_to(ROOT).as_posix()}  {size // 1024} KB  {wh[0]}×{wh[1]}  {colors} colours')


if __name__ == '__main__':
    main()
