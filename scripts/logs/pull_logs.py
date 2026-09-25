#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fetch the work log of the phones from the VPS and say what went wrong — the owner's «постоянная обратная связь».

    python scripts/logs/pull_logs.py [--days 7] [--ip 195.133.61.136]

Copies /var/lib/ladoga-logs (last --days) over SSH into research/raw/logs/ (git-ignored) and prints: how many phones
and launches, the errors (grouped by message), the problem reports with the person's words, GPS permission states,
the navigator (how often the map was let go, auto returns, voice), GPS oddities (gaps, poor fixes, speed mismatch)
and long freezes of the page.
"""
import argparse
import collections
import io
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser()
ap.add_argument("--days", type=int, default=7)
ap.add_argument("--ip", default="195.133.61.136")
ap.add_argument("--local", default="", help="summarise an already fetched folder instead")
args = ap.parse_args()

out = Path(args.local) if args.local else ROOT / "research" / "raw" / "logs"
if not args.local:
    key = os.environ.get("LADOGA_SSH_KEY", str(Path.home() / ".ssh" / "spbfi_club_ed25519"))
    cmd = ["ssh", "-i", key, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new", f"root@{args.ip}",
           f"cd /var/lib/ladoga-logs 2>/dev/null && find . -type f -mtime -{args.days} -print0 | tar czf - --null -T - || true"]
    data = subprocess.run(cmd, capture_output=True, check=False).stdout
    out.mkdir(parents=True, exist_ok=True)
    if data:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            tar.extractall(out, filter="data") if hasattr(tarfile, "data_filter") else tar.extractall(out)
    print(f"fetched {len(data)} bytes into {out}")

phones, sessions, versions = set(), set(), collections.Counter()
events = collections.Counter()
errors = collections.Counter()
perm = collections.Counter()
taps = collections.Counter()
odd = collections.Counter()
voice = collections.Counter()
slow = [0, 0]
nav = collections.Counter()
for path in sorted(out.rglob("*.jsonl")):  # one folder per app: ladoga/, fuel/, …
    if path.name == "reports.jsonl":
        continue
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            b = json.loads(line)
        except ValueError:
            continue
        phones.add(b.get("iid")); sessions.add(b.get("sid")); versions[b.get("app")] += 1
        for e in b.get("events", []):
            name = e.get("e")
            events[name] += 1
            if name == "error":
                errors[f"{e.get('msg', '')} @{e.get('src', '')}:{e.get('line', '')}"] += 1
            elif name == "geo_permission":
                perm[e.get("state")] += 1
            elif name == "tap":
                taps[e.get("what")] += 1
            elif name == "fix" and e.get("odd"):
                why = []
                if (e.get("dt") or 0) > 5000: why.append("пропуск >5 с")
                if (e.get("acc") or 0) > 50: why.append("точность >50 м")
                if e.get("v") is not None and e.get("made") is not None and abs(e["v"] - e["made"]) > max(10, 0.3 * e["v"]): why.append("скорость ≠ пройденному")
                odd[", ".join(why) or "другое"] += 1
            elif name == "voice":
                voice[e.get("text", "")[:40]] += 1
            elif name == "slow":
                slow[0] += e.get("n", 0); slow[1] += e.get("ms", 0)
            elif name in ("map_free", "recenter", "nav_start", "nav_arrived", "shoal_ahead", "guard_alarm", "mob", "gap", "saver_on"):
                nav[name + (" (сам)" if name == "recenter" and e.get("auto") else "")] += 1

print(f"\nТелефонов: {len(phones)}, запусков: {len(sessions)}, версии: {dict(versions)}")
print("\nСобытия:", dict(events.most_common(25)))
print("\nОшибки (сколько раз):")
for k, v in errors.most_common(20):
    print(f"  {v:4d}  {k}")
print("\nРазрешение геопозиции при запуске:", dict(perm))
print("\nНавигатор:", dict(nav))
print("\nGPS — странности:", dict(odd))
print("\nГолос (частые фразы):", dict(voice.most_common(10)))
print(f"\nЗависания страницы (Android): {slow[0]} шт., {slow[1] / 1000:.1f} с всего")
print("\nЧаще всего нажимали:", dict(taps.most_common(20)))
for rep in sorted(out.rglob("reports.jsonl")):
    print(f"\nСообщения о проблемах ({rep.parent.name}):")
    for line in rep.read_text(encoding="utf-8").splitlines()[-30:]:
        r = json.loads(line)
        print(f"  {r['rt']}  [{r.get('app')}] {r.get('who') or ''} {r.get('text')}  ({r.get('file')})")
