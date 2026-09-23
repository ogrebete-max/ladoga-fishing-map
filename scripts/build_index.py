"""Assemble site/index.html from index.template.html: inline the icon sprite and stamp the asset version.

Run after front-end changes: python scripts/build_index.py 41   (then bump VERSION in site/sw.js)
"""
import sys
from pathlib import Path

site = Path(__file__).resolve().parents[1] / "site"
version = sys.argv[1] if len(sys.argv) > 1 else "1"
html = (site / "index.template.html").read_text(encoding="utf-8")
sprite = (site / "icons" / "sprite.svg").read_text(encoding="utf-8")
html = html.replace("<!--SPRITE-->", sprite).replace("__V__", version)
(site / "index.html").write_text(html, encoding="utf-8")
print(f"index.html v={version}, {len(html)} bytes")
