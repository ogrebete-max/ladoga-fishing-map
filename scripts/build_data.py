"""Merge the baseline handoff and the research JSON files into the site's data.

Inputs
  data/baseline/ladoga_reports.csv   202 reports collected earlier (FisherMap, fishing-report.ru, ...)
  research/*.json                    one file per research agent (see research/BRIEF.md)

Outputs
  site/data/points.json      reports + map markers (reports closer than MERGE_M share a marker)
  site/data/context.json     species calendar, rules, zones, lines, extra tile layers
  site/downloads/*           GPX / CSV / GeoJSON of every point, for navigators and chartplotters

Run: python scripts/build_data.py
"""
from __future__ import annotations

import csv
import json
import math
import re
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = ROOT / "research"
BASELINE = ROOT / "data" / "baseline"
SITE_DATA = ROOT / "site" / "data"
DOWNLOADS = ROOT / "site" / "downloads"

CENTER = (60.1037113, 32.2939775)  # Новая Ладога / устье Волхова
CORE_KM = 55
# Southern Ladoga and the lower rivers; anything outside is dropped.
BBOX = (59.85, 30.90, 60.80, 33.40)
MERGE_M = 30

KINDS = {"fishing", "observation", "structure", "launch", "hazard", "landmark", "ice_incident"}

SECTORS = [
    ("Новая Ладога / устье Волхова", 60.118, 32.32),
    ("Нижний Волхов", 60.075, 32.333),
    ("Старая Ладога / Волхов", 60.01, 32.30),
    ("Креницы / Волховская губа", 60.16, 32.26),
    ("Волховская губа, центр", 60.20, 32.30),
    ("Устье Сяси / Сясьстрой", 60.15, 32.56),
    ("о. Птинов", 60.25366, 32.07901),
    ("Варецкие банки", 60.29833, 32.10667),
    ("Дубно", 60.234609, 31.983349),
    ("Лигово", 60.240971, 31.778853),
    ("Вороново", 60.285915, 32.601296),
    ("о. Сухо", 60.405998, 32.091712),
    ("Кобона / южный берег", 60.03, 31.55),
    ("Шлиссельбург / бухта Петрокрепость", 60.00, 31.10),
    ("Осиновец / западный берег", 60.12, 31.08),
    ("Свирская губа / устье Свири", 60.49, 32.87),
    ("Свирица / Загубская губа", 60.45, 32.82),
    ("Открытая Ладога", 60.55, 31.90),
]

# Canonical fish names; the key is a lowercase stem found in the source text.
FISH = [
    ("судак", "Судак"), ("щук", "Щука"), ("окун", "Окунь"), ("подлещ", "Лещ"), ("лещ", "Лещ"),
    ("плотв", "Плотва"), ("сорог", "Плотва"), ("сиг", "Сиг"), ("ряпушк", "Ряпушка"), ("корюшк", "Корюшка"),
    ("лосос", "Лосось"), ("семг", "Лосось"), ("форел", "Форель"), ("кумж", "Форель"), ("пали", "Палия"),
    ("налим", "Налим"), ("жерех", "Жерех"), ("язь", "Язь"), ("язя", "Язь"), ("густер", "Густера"),
    ("уклей", "Уклейка"), ("ерш", "Ёрш"), ("ёрш", "Ёрш"), ("ерш", "Ёрш"), ("синец", "Синец"), ("чехон", "Чехонь"),
    ("карас", "Карась"), ("карп", "Карп"), ("сом", "Сом"), ("голавл", "Голавль"), ("елец", "Елец"),
    ("красноп", "Краснопёрка"), ("линь", "Линь"), ("хариус", "Хариус"), ("снеток", "Корюшка"),
    ("минога", "Минога"), ("угор", "Угорь"), ("пескар", "Пескарь"), ("бычок", "Бычок"),
]
LATIN = {
    "sander lucioperca": "Судак", "esox lucius": "Щука", "perca fluviatilis": "Окунь", "abramis brama": "Лещ",
    "rutilus rutilus": "Плотва", "coregonus": "Сиг", "coregonus albula": "Ряпушка", "osmerus eperlanus": "Корюшка",
    "salmo salar": "Лосось", "salmo trutta": "Форель", "salvelinus": "Палия", "lota lota": "Налим",
    "leuciscus aspius": "Жерех", "aspius aspius": "Жерех", "leuciscus idus": "Язь", "blicca bjoerkna": "Густера",
    "alburnus alburnus": "Уклейка", "gymnocephalus cernua": "Ёрш", "ballerus ballerus": "Синец",
    "abramis ballerus": "Синец", "pelecus cultratus": "Чехонь", "carassius": "Карась", "tinca tinca": "Линь",
    "squalius cephalus": "Голавль", "leuciscus leuciscus": "Елец", "scardinius erythrophthalmus": "Краснопёрка",
    "thymallus thymallus": "Хариус", "gobio gobio": "Пескарь", "cottus": "Бычок", "anguilla anguilla": "Угорь",
    "lampetra": "Минога", "cyprinus carpio": "Карп", "silurus glanis": "Сом",
}
ICE_WORDS = re.compile(r"л[её]д|подл[её]д|лунк|мормыш|балансир|жерлиц|зимн|ледостав|перволед|последн\w* л", re.I)
OPEN_WORDS = re.compile(r"лодк|спиннинг|джиг|троллинг|поплав|фидер|донк|с берега|катер|весл", re.I)


def haversine_m(a_lat, a_lon, b_lat, b_lon):
    r = 6371008.8
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def norm_fish(values) -> list[str]:
    if isinstance(values, str):
        values = re.split(r"[;,/]| и ", values)
    out = []
    for raw in values or []:
        text = str(raw).strip().lower().replace("ё", "е")
        if not text:
            continue
        name = None
        for latin, ru in LATIN.items():
            if text.startswith(latin):
                name = ru
                break
        if not name:
            for stem, ru in FISH:
                if stem.replace("ё", "е") in text:
                    name = ru
                    break
        if not name and re.match(r"^[а-я]", text):
            name = text[:1].upper() + text[1:]
        if name and name not in out:
            out.append(name)
    return out


def clean_date(value) -> str:
    text = str(value or "").strip()
    m = re.match(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", text)
    if not m:
        return ""
    year = int(m.group(1))
    if not 1950 <= year <= date.today().year:
        return ""
    return "-".join(g for g in m.groups() if g)


def season_of(d: str, text: str, given: str = "") -> str:
    if given in ("ice", "open_water"):
        return given
    month = int(d[5:7]) if len(d) >= 7 else 0
    if ICE_WORDS.search(text or ""):
        return "ice"
    if month in (1, 2, 3):
        return "ice"
    if month and 5 <= month <= 11:
        return "open_water"
    if OPEN_WORDS.search(text or ""):
        return "open_water"
    return ""


def sector_of(lat, lon) -> str:
    return min(SECTORS, key=lambda s: haversine_m(lat, lon, s[1], s[2]))[0]


def in_area(lat, lon) -> bool:
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def short(text, limit=260) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def baseline_reports():
    rows = list(csv.DictReader(open(BASELINE / "ladoga_reports.csv", encoding="utf-8-sig")))
    for row in rows:
        src = row["source"]
        if src.startswith("Предыдущее"):
            src = "Прежнее исследование (ChatGPT)"
        comment = row["comment"]
        yield {
            "lat": float(row["latitude"]), "lon": float(row["longitude"]),
            "kind": "fishing", "cls": row["confidence_class"] or "B",
            "prec": 10 if row["confidence_class"] == "A" else (300 if row["confidence_class"] == "C" else 30),
            "fish": norm_fish(row["fish"]), "date": clean_date(row["date"]),
            "title": row["sector"], "comment": comment,
            "depth": row["depth"], "method": row["method"], "catch": row["catch"],
            "src": src, "url": row["source_url"], "sid": row["source_id"],
            "orig": row["original_source_url"] if row["original_source_url"] != row["source_url"] else "",
            "agent": "baseline",
        }
    # Two geographic landmarks the previous research kept apart from the reports.
    yield {"lat": 60.25366, "lon": 32.07901, "kind": "landmark", "cls": "C", "prec": 500, "fish": [], "date": "",
           "title": "о. Птинов", "comment": "Остров-ориентир в Волховской губе; вокруг него свалы и банки.",
           "src": "Прежнее исследование (ChatGPT)", "url": "", "sid": "landmark-ptinov", "agent": "baseline"}
    yield {"lat": 60.29833, "lon": 32.10667, "kind": "landmark", "cls": "C", "prec": 1500, "fish": [], "date": "",
           "title": "Варецкие банки", "comment": "Протяжённая гряда мелей к северу от Птинова; точка — условный центр.",
           "src": "Прежнее исследование (ChatGPT)", "url": "", "sid": "landmark-varetskie", "agent": "baseline"}


def research_reports():
    for path in sorted(RESEARCH.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception as error:  # a broken agent file must not stop the build
            print(f"skip {path.name}: {error}")
            continue
        slug = payload.get("agent") or path.stem
        for p in payload.get("points") or []:
            try:
                lat, lon = float(p["latitude"]), float(p["longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            kind = p.get("kind") if p.get("kind") in KINDS else "fishing"
            fish = norm_fish(p.get("fish") or [])
            if not fish and p.get("latin_name"):
                fish = norm_fish([p["latin_name"]])
            yield {
                "lat": lat, "lon": lon, "kind": kind,
                "cls": p.get("confidence_class") if p.get("confidence_class") in ("A", "B", "C") else "C",
                "prec": int(float(p.get("coord_precision_m") or 0)) or None,
                "fish": fish, "date": clean_date(p.get("date")), "season_given": p.get("season") or "",
                "title": short(p.get("title"), 90), "comment": short(p.get("comment")),
                "depth": short(p.get("depth"), 40), "method": short(p.get("method"), 80), "catch": short(p.get("catch"), 80),
                "src": short(p.get("source") or slug, 60), "url": p.get("source_url") or "", "sid": str(p.get("source_id") or ""),
                "raw": short(p.get("raw_coordinate_text"), 80), "agent": slug,
                "dup": bool(p.get("dup_of_baseline")),
            }


def load_json(name):
    path = RESEARCH / f"{name}.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as error:
        print(f"skip {name}: {error}")
        return {}


def main():
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    DOWNLOADS.mkdir(parents=True, exist_ok=True)

    reports, seen = [], set()
    dropped = Counter()
    for r in list(baseline_reports()) + list(research_reports()):
        if not in_area(r["lat"], r["lon"]):
            dropped["вне района"] += 1
            continue
        # The same card reached through two routes (e.g. FisherMap city + lake page).
        key = (r["src"].split(":")[0].lower().replace("ru.", ""), r["sid"]) if r["sid"] else None
        url_key = r["url"].rstrip("/").lower() if r["url"] else None
        if (key and key in seen) or (url_key and url_key in seen):
            dropped["повтор источника"] += 1
            continue
        if key:
            seen.add(key)
        if url_key:
            seen.add(url_key)
        text = " ".join(str(r.get(k) or "") for k in ("comment", "method", "title"))
        r["season"] = season_of(r["date"], text, r.pop("season_given", ""))
        r["dist"] = round(haversine_m(CENTER[0], CENTER[1], r["lat"], r["lon"]) / 1000, 1)
        r["zone"] = "core" if r["dist"] <= CORE_KM else "ext"
        r["sector"] = sector_of(r["lat"], r["lon"])
        r.pop("dup", None)
        reports.append(r)

    # Markers: reports of the same kind family within MERGE_M share one marker.
    family = lambda k: "catch" if k in ("fishing", "observation") else k
    markers = []
    grid = defaultdict(list)
    for i, r in enumerate(reports):
        cell = (round(r["lat"] * 2000), round(r["lon"] * 1000))
        target = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for m in grid[(cell[0] + dx, cell[1] + dy)]:
                    if family(m["kind"]) == family(r["kind"]) and haversine_m(m["lat"], m["lon"], r["lat"], r["lon"]) <= MERGE_M:
                        target = m
                        break
                if target:
                    break
            if target:
                break
        if target:
            target["r"].append(i)
        else:
            m = {"lat": r["lat"], "lon": r["lon"], "kind": r["kind"], "r": [i]}
            markers.append(m)
            grid[cell].append(m)
    for m in markers:
        kinds = [reports[i]["kind"] for i in m["r"]]
        m["kind"] = "fishing" if "fishing" in kinds else kinds[0]

    for r in reports:
        for k in [k for k, v in r.items() if v in ("", None, [])]:
            r.pop(k)
        r["lat"], r["lon"] = round(r["lat"], 6), round(r["lon"], 6)
    for m in markers:
        m["lat"], m["lon"] = round(m["lat"], 6), round(m["lon"], 6)

    points = {
        "generated": date.today().isoformat(),
        "center": {"lat": CENTER[0], "lon": CENTER[1], "core_km": CORE_KM},
        "reports": reports,
        "markers": markers,
        "stats": {
            "reports": len(reports), "markers": len(markers),
            "by_source": Counter(r["src"] for r in reports).most_common(),
            "by_kind": Counter(r["kind"] for r in reports).most_common(),
            "by_class": Counter(r["cls"] for r in reports).most_common(),
            "dropped": dict(dropped),
        },
    }
    (SITE_DATA / "points.json").write_text(json.dumps(points, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    bio, rules, nav = load_json("biology_seasons"), load_json("rules_safety"), load_json("nav_structures")
    sources = []
    for path in sorted(RESEARCH.glob("*.json")):
        payload = load_json(path.stem)
        for s in payload.get("sources_checked") or []:
            sources.append({**{k: s.get(k, "") for k in ("name", "url", "status", "note")}, "agent": payload.get("agent") or path.stem})
    context = {
        "generated": date.today().isoformat(),
        "species": bio.get("species") or [],
        "hydro_calendar": bio.get("hydro_calendar") or [],
        "season_zones": bio.get("season_zones") or [],
        "regulations": rules.get("regulations") or {},
        "ice_rules": rules.get("ice_rules") or [],
        "lines": nav.get("lines") or [],
        "tile_layers": nav.get("tile_layers") or [],
        "sources": sources,
    }
    (SITE_DATA / "context.json").write_text(json.dumps(context, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    write_downloads(reports, markers)
    print(json.dumps(points["stats"], ensure_ascii=False, indent=1))


def xml(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def write_downloads(reports, markers):
    kind_ru = {"fishing": "Рыбалка", "observation": "Наблюдение", "structure": "Структура", "launch": "Спуск/база",
               "hazard": "Опасность", "landmark": "Ориентир", "ice_incident": "Происшествие на льду"}
    wpts = []
    for n, m in enumerate(markers, 1):
        rs = [reports[i] for i in m["r"]]
        fish = sorted({f for r in rs for f in r.get("fish", [])})
        name = f"L{n:04d} {', '.join(fish[:2]) or kind_ru[m['kind']]}"
        desc = "; ".join(f"{r.get('date', '')} {r['src']}: {r.get('comment', r.get('title', ''))}".strip() for r in rs[:5])
        wpts.append(f'  <wpt lat="{m["lat"]}" lon="{m["lon"]}">\n    <name>{xml(name)}</name>\n'
                    f'    <desc>{xml(desc[:900])}</desc>\n    <type>{xml(kind_ru[m["kind"]])}</type>\n  </wpt>')
    gpx = ('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ladoga-fishing-map" '
           'xmlns="http://www.topografix.com/GPX/1/1">\n' + "\n".join(wpts) + "\n</gpx>\n")
    (DOWNLOADS / "ladoga_points.gpx").write_text(gpx, encoding="utf-8")

    cols = ["lat", "lon", "kind", "cls", "prec", "fish", "date", "season", "sector", "dist", "zone", "title",
            "comment", "depth", "method", "catch", "src", "url", "orig", "sid"]
    with open(DOWNLOADS / "ladoga_reports.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for r in reports:
            w.writerow(["; ".join(r.get(c, [])) if c == "fish" else r.get(c, "") for c in cols])

    features = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
                 "properties": {k: v for k, v in r.items() if k not in ("lat", "lon")}} for r in reports]
    (DOWNLOADS / "ladoga_reports.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
