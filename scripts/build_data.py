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

KINDS = {"fishing", "observation", "structure", "launch", "hazard", "landmark", "ice_incident", "service"}
# Kinds of the practical guide that become a "service" point with a subtype icon.
SERVICE = {"base", "shop", "fuel", "hospital", "rescue"}

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
        src = "Прежнее исследование (ChatGPT)" if src.startswith("Предыдущее") else canon_source(src)
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


SOURCE_NAMES = [
    (re.compile(r"fishermap", re.I), "FisherMap"),
    (re.compile(r"fishing-report", re.I), "fishing-report.ru"),
    (re.compile(r"inaturalist", re.I), "iNaturalist"),
    (re.compile(r"gbif", re.I), "GBIF"),
    (re.compile(r"openstreetmap|overpass|osm", re.I), "OpenStreetMap"),
    (re.compile(r"wikimapia", re.I), "Wikimapia"),
    (re.compile(r"wikimedia|commons", re.I), "Wikimedia Commons"),
    (re.compile(r"rybalka_spb_lenoblasti|Рыболовная сводка", re.I), "Telegram: Рыболовная сводка СПб"),
    (re.compile(r"fishingspb1", re.I), "Telegram: Отчёты Рыбалка СПб"),
    (re.compile(r"damfishspb", re.I), "Telegram: @damfishspb"),
    (re.compile(r"gumchslo|МЧС", re.I), "МЧС Ленинградской области"),
    # points_2026: the club's Telegram mirror and new channels (source names are cut to 60 chars before this runs)
    (re.compile(r"novosti_s_vodoemov|^Telegram: Питерский", re.I), "Telegram: Новости с водоемов (ПКР)"),
    (re.compile(r"gid_rybalka_na_ladoge|Гид по рыболовным местам", re.I), "Telegram: Гид по рыболовным местам Ладоги"),
    (re.compile(r"Волго-Балт", re.I), "ФБУ «Администрация «Волго-Балт»"),
    (re.compile(r"fisher\.spb|ПКР|Питерский\s+клуб\s+рыбаков", re.I), "fisher.spb.ru (Питерский клуб рыбаков)"),
    (re.compile(r"iv70\.narod|Схема сетей", re.I), "iv70.narod.ru"),
    (re.compile(r"fishing-club\.ru|rapala\.ru", re.I), "fishing-club.ru (точки 2001 г.)"),
    (re.compile(r"flickr", re.I), "Flickr"),
    (re.compile(r"pastvu", re.I), "PastVu (старые фото)"),
    (re.compile(r"rusfishing", re.I), "rusfishing.ru"),
    (re.compile(r"barque", re.I), "barque.ru"),
    (re.compile(r"boatfisher", re.I), "boatfisher.ru (слипы)"),
]


def canon_source(name: str) -> str:
    for rx, canon in SOURCE_NAMES:
        if rx.search(name or ""):
            return canon
    return name


# Research files still being written can be held back: SKIP_AGENTS=nav_structures,charts2
SKIP = {x.strip() for x in __import__("os").environ.get("SKIP_AGENTS", "").split(",") if x.strip()}


def research_reports():
    for path in sorted(RESEARCH.glob("*.json")):
        if path.stem in SKIP:
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception as error:  # a broken agent file must not stop the build
            print(f"skip {path.name}: {error}")
            continue
        if not isinstance(payload, dict):
            continue  # not a points file (a list of sources, a report table…)
        slug = payload.get("agent") or path.stem
        points = list(payload.get("points") or [])
        singles = [w for w in payload.get("dated_reports_with_coords") or [] if w.get("latitude") is not None]
        if singles:
            # The file also lists every report at its own coordinate: keep those instead of the
            # merged points, so each report keeps its date and fish for the season statistics.
            points = [p for p in points if not (p.get("kind") == "fishing" and p.get("confidence_class") == "A")]
            for w in singles:
                bits = [w.get("catch"), w.get("method"), f"глубина {w['depth']}" if w.get("depth") else ""]
                points.append({
                    "latitude": w["latitude"], "longitude": w["longitude"], "kind": w.get("kind") or "fishing",
                    "confidence_class": "A", "coord_precision_m": 20, "fish": w.get("fish") or [],
                    "date": w.get("date"), "season": w.get("season"), "title": w.get("place_text"),
                    "comment": "; ".join(b for b in bits if b) or "Отчёт с координатами места ловли.",
                    "depth": w.get("depth"), "method": w.get("method"), "catch": w.get("catch"),
                    "source": w.get("source"), "source_url": w.get("source_url"), "source_id": w.get("source_url"),
                })
        for p in points:
            if p.get("separate_waterbody"):
                continue
            try:
                lat, lon = float(p["latitude"]), float(p["longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            sub = p.get("kind") if p.get("kind") in SERVICE else ""
            kind = "service" if sub else ("launch" if p.get("kind") == "parking" else (p.get("kind") if p.get("kind") in KINDS else "fishing"))
            title_text = str(p.get("title") or "")
            if kind in ("landmark", "observation") and re.search(r"Парковк|выход|Ледовая обстановка|Слип", title_text, re.I):
                kind = "launch"
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
                "src": canon_source(short(p.get("source") or slug, 60)),
                "srcd": short(p.get("source"), 120) if canon_source(short(p.get("source") or slug, 60)) != short(p.get("source"), 60) else "",
                "url": p.get("source_url") or "", "sid": str(p.get("source_id") or ""),
                "orig": p.get("original_source_url") or "",
                "wb": short(p.get("waterbody"), 80),
                "raw": short(p.get("raw_coordinate_text"), 80), "agent": slug,
                "doubt": bool(p.get("location_doubtful")),
                "sub": sub or ("parking" if p.get("kind") == "parking" else ""),
            }


def timeseries():
    """Monthly counts of dated reports (Telegram, YouTube, forums) by fish and by area."""
    by_fish, by_sector, by_source = defaultdict(lambda: [0] * 12), defaultdict(lambda: [0] * 12), Counter()
    by_month = [0] * 12
    sector_fish = defaultdict(Counter)
    total = 0
    for path in sorted(RESEARCH.glob("*.json")):
        payload = load_json(path.stem)
        rows = list(payload.get("dated_reports_without_coords") or []) + list(payload.get("dated_reports_with_coords") or [])
        for row in rows:
            d = clean_date(row.get("date"))
            if len(d) < 7 or row.get("date_basis") == "publication":
                continue  # an upload date can lag the trip by months
            if row.get("dup_of_baseline") is True:
                continue
            m = int(d[5:7]) - 1
            total += 1
            by_month[m] += 1
            sector = (row.get("sector") or "").strip() or "место не уточнено"
            by_sector[sector][m] += 1
            by_source[canon_source(row.get("source") or path.stem)] += 1
            for f in norm_fish(row.get("fish") or []):
                by_fish[f][m] += 1
                sector_fish[sector][f] += 1
    top_sectors = sorted(by_sector, key=lambda k: -sum(by_sector[k]))[:25]
    return {
        "total": total,
        "by_month": by_month,
        "by_fish": dict(sorted(by_fish.items(), key=lambda kv: -sum(kv[1]))),
        "by_sector": {k: {"by_month": by_sector[k], "fish": dict(sector_fish[k].most_common(6))} for k in top_sectors},
        "by_source": by_source.most_common(),
    }


# Map layers the research found working, with the zooms they really serve (nakarte: GGC and the General Staff mosaic).
TILE_MAXZOOM = {"topomapper": 13, "ggc2000": 12, "ggc500": 14, "ggc250": 15}
TILE_NAMES = {"topomapper": "Генштаб СССР (1:100 000, мозаика)", "ggc2000": "ГосГисЦентр 1:200 000",
              "ggc500": "ГосГисЦентр 1:50 000 — мели, камни, отмели", "ggc250": "ГосГисЦентр 1:25 000 — самая подробная"}


def curated_tiles(layers):
    out = []
    for t in layers:
        url = t.get("url_template") or t.get("url") or ""
        key = next((k for k in TILE_MAXZOOM if f"/{k}/" in url), None)
        if not key or not str(t.get("works_in_browser", "")).startswith("yes"):
            continue
        out.append({"key": key, "name": TILE_NAMES[key], "url": url, "tms": bool(t.get("tms")) and str(t.get("tms")) != "False",
                    "subdomains": t.get("subdomains") or "abc", "max_zoom": TILE_MAXZOOM[key],
                    "attribution": t.get("attribution") or "nakarte.me"})
    order = ["ggc250", "ggc500", "topomapper", "ggc2000"]
    return sorted(out, key=lambda t: order.index(t["key"]))


def charts_context():
    """Navigation charts (ГУНиО) as image overlays, with the zooms each one should show at."""
    out = []
    for o in load_json("charts2").get("image_overlays") or []:
        if not (ROOT / "site" / o.get("file", "")).exists():
            continue
        zmin, zmax = (o.get("recommended_zoom") or [10, 16])[:2]
        out.append({"name": o.get("name"), "url": o["file"], "bounds": o["bounds"], "group": o.get("group"),
                    "chart": o.get("chart_number"), "title": o.get("chart_title"), "scale": o.get("scale"),
                    "year": o.get("year"), "zmin": zmin, "zmax": zmax, "zone": o.get("zone"),
                    "attribution": o.get("attribution"), "depth_content": o.get("depth_content")})
    return out


def tackle_context():
    t = load_json("tackle")
    if not t:
        return {}
    records = RESEARCH / "raw" / "tackle" / "records.jsonl"
    total = sum(1 for _ in open(records, encoding="utf-8")) if records.exists() else 0
    return {"species": t.get("species") or [], "gear_lists": t.get("gear_lists") or {},
            "legal_common": t.get("legal_common"), "total": total}


def depth_shade():
    """The coloured depth tiles (site/tiles/depth/{z}/{x}/{y}.png) if the depth model has been built."""
    base = ROOT / "site" / "tiles" / "depth"
    zooms = sorted(int(d.name) for d in base.iterdir() if d.is_dir() and d.name.isdigit()) if base.exists() else []
    if not zooms:
        return {}
    ext = next((f.suffix for f in (base / str(zooms[-1])).rglob("*") if f.is_file()), ".png")
    listing = ROOT / "site" / "tiles" / "depth_tiles.txt"
    out = {"url": f"tiles/depth/{{z}}/{{x}}/{{y}}{ext}", "minZoom": zooms[0], "maxNativeZoom": zooms[-1],
           "list": "tiles/depth_tiles.txt" if listing.exists() else ""}
    if listing.exists():
        out["cover"] = write_cover(listing, "depth_cover.json")
    return out


def write_cover(listing, name):
    """Tiles exist only where the layer has something (the depth shading over water, the charts inside their
    sheets): the app asks for no tile outside these runs — no 404s, no wasted requests on a weak signal.
    {z: {x: [y0, y1, y2, y3, ...]}} — inclusive runs of y in each column."""
    cols = defaultdict(set)
    for line in listing.read_text(encoding="utf-8").split():
        m = re.search(r"/(\d+)/(\d+)/(\d+)\.\w+$", line)
        if m:
            cols[(int(m[1]), int(m[2]))].add(int(m[3]))
    cover = defaultdict(dict)
    for (z, x), ys in sorted(cols.items()):
        runs, ys = [], sorted(ys)
        for y in ys:
            if runs and y == runs[-1] + 1:
                runs[-1] = y
            else:
                runs += [y, y]
        cover[str(z)][str(x)] = runs
    (ROOT / "site" / "tiles" / name).write_text(json.dumps(cover, separators=(",", ":")), encoding="utf-8")
    return f"tiles/{name}"


def tile_index():
    """What the app needs of site/tiles/index.json (written by scripts/build_chart_tiles.py), inside context.json:
    it then works offline and on a weak signal without one more request."""
    path = ROOT / "site" / "tiles" / "index.json"
    if not path.exists():
        return {}
    idx = json.loads(path.read_text(encoding="utf-8"))
    keep = ("id", "url", "minZoom", "maxZoom", "maxNativeZoom", "bounds", "list", "total_bytes")
    layers = []
    for layer in idx.get("layers") or []:
        out = {k: layer[k] for k in keep if k in layer}
        if layer.get("detail"):
            out["detail"] = {"regions": [{"bounds": r["bounds"]} for r in layer["detail"].get("regions") or [] if r.get("bounds")]}
        listing = ROOT / "site" / str(layer.get("list") or "")
        if layer.get("list") and listing.is_file():
            out["cover"] = write_cover(listing, f"{layer['id']}_cover.json")
        layers.append(out)
    return {"generated": idx.get("generated"), "layers": layers}


# ---------- How long a record stays true (research/freshness.md) ----------
# The owner's rule (24.09.2026): a place where fish were caught stays on the map for good and new ones are added,
# but what was true for a day, a week or one winter must not look current years later. Every record gets `life`:
#   perm    постоянно: дно, камни, рифы, затонувшие суда, маяки, острова, спуски, базы; места ловли;
#   spring  каждую весну (`months`): промысловые мережи на корюшку в устьях — только в апреле–мае;
#   season  до конца того сезона (`until`): сети, топляки, трещины и промоины, «дальше не ехать»;
#   event   несколько дней (`until` = дата + EVENT_DAYS): происшествие;
#   gone    больше не нужно (`until` = дата записи): закрыто, лодка на старом фото.
# The app hides a record after `until` and outside `months` unless the filter asks for the archive: nothing is
# deleted. Incidents and ice notes whose cause is the ice itself make the «опасный лёд» zones (ice_zones()).
EVENT_DAYS = 10
# Incidents that say nothing about the place: a broken snowmobile, lost in fog, an injury.
NON_ICE = re.compile(r"поломк|заглох|сломал|застрял|заблуд|потерял\w*\s+направлен|травм|не\s+могл\w+\s+вернуться|"
                     r"не\s+смог\w*\s+найти|пропал\w*\s+при", re.I)
ICE_CAUSES = [
    ("detach", re.compile(r"отрыв|оторва|дрейф|унесл|отколов|отнесл", re.I)),
    ("fall", re.compile(r"провал|ушл[аио]?\s+под|ушёл\s+под|полынью|майна", re.I)),
    ("crack", re.compile(r"трещин|треска|разрушени\w*\s+льда|разрушающ|отрезал|отрезан", re.I)),
    ("polynya", re.compile(r"промоин|полынь|с\s+выходом\s+воды|вода\s+на\s+льду", re.I)),
    ("weak", re.compile(r"опасн\w+\s+льд|не\s+ехать|тонк\w+\s+л[её]д", re.I)),
]
ICE_NOTE = re.compile(r"трещин|промоин|полынь|не\s+ехать|л[её]д\s*~?\d", re.I)
GONE = {  # title fragment → why it is not shown any more
    "Рыболовецкий бот ССП-34": "лодка на фото 2020 г., не место",
    "рыбокомбинат (1975)": "старое фото 1975 г.",
    "«Камнеломня»": "поворот к парковке закрыт шлагбаумом",
}


def winter_end(d: str) -> str:
    y, m = int(d[:4]), int(d[5:7]) if len(d) >= 7 else 1
    return f"{y + 1 if m >= 10 else y}-04-30"


def plus_days(d: str, n: int) -> str:
    y, m = int(d[:4]), int(d[5:7]) if len(d) >= 7 else 1
    day = int(d[8:10]) if len(d) >= 10 else 1
    return date.fromordinal(date(y, m, day).toordinal() + n).isoformat()


def ice_causes(r) -> list[str]:
    text = f"{r.get('title', '')} {r.get('comment', '')}"
    return [k for k, rx in ICE_CAUSES if rx.search(text)]


def lifetime(r):
    """(life, until, months, why) of one record — see the table above."""
    title, d, kind = r.get("title") or "", r.get("date") or "", r["kind"]
    text = f"{title} {r.get('comment', '')}"
    for frag, why in GONE.items():
        if frag in title:
            return "gone", d or "2000-01-01", None, why
    if kind == "ice_incident":
        if NON_ICE.search(title) or not ice_causes(r):
            return "event", plus_days(d, EVENT_DAYS), None, "случай к месту не относится: поломка, заблудились, травма"
        return "event", plus_days(d, EVENT_DAYS), None, "давний случай — место в слое «Опасный лёд»"
    if kind == "hazard":
        if re.search(r"топляк", title, re.I):
            return "season", f"{d[:4]}-11-30", None, "топляки уносит — точки одного лета"
        if re.search(r"мереж", title, re.I):
            return "spring", None, [4, 5], "только весной: мережи на корюшку ставят в апреле–мае"
        if re.search(r"сети", title, re.I) and not d:
            return "gone", "2000-01-01", None, "сети переставляют каждый сезон, схема без даты"
        if re.search(r"опрокидыван|перевернул", text, re.I) and d:
            return "event", plus_days(d, EVENT_DAYS), None, "происшествие — важно несколько дней"
        if d and ICE_NOTE.search(text):
            return "season", winter_end(d), None, "лёд той зимы — место в слое «Опасный лёд»"
    return "perm", None, None, ""


ZONE_LINK_M = 2000
FLOW = re.compile(r"канал|(?<![а-яё])р\.\s|реки|река|проток|устье Волхова|Свир|Сясь|Валгом", re.I)
ZONE_ALIAS = {
    "Губа Черная Сатама": "Чёрное", "Осиновецкая гавань": "Осиновец", "Осиновецкий маяк": "Осиновец",
    "р. Волхов у Креницы": "Волхов у Новой Ладоги", "протока у Волховца": "Волхов у Новой Ладоги",
    "Новая Ладога, канал судозавода": "Волхов у Новой Ладоги", "канал у Немятово-2": "Волхов у Новой Ладоги",
    "Сясьстрой, р. Валгома": "Сясьстрой", "р. Сясь в Сясьстрое": "Сясьстрой", "р. Свирь у Свирицы": "Свирица",
    "Шлиссельбург, Новоладожский канал": "Новоладожский канал в Шлиссельбурге",
    "южн. берег бухты Петрокрепость": "бухта Петрокрепость, южный берег", "Лаврово–Шальдиха": "Лаврово — Шальдиха",
}
ZONE_TITLE_NAME = {"Две промоины в 4 км от Лаврово к Зеленцу": "Лаврово — Зеленцы", "Промоина в устье Волхова": "Волхов у Новой Ладоги",
                   "Трещины с выходом воды у Осиновца": "Осиновец", "Промоина у Леднево (сводка МЧС)": "Леднево"}


def ice_zones(reports):
    """«Опасный лёд»: places where the ice itself hurt people (fell through, a floe broke off, cracks, polynyas),
    from the incident reports and the anglers' ice notes of all years. One case is history; the place is what stays.
    Single-link clusters (≤ ZONE_LINK_M) of the same water (lake / river or canal with a current)."""
    items = []
    for i, r in enumerate(reports):
        if r["kind"] not in ("ice_incident", "hazard") or r.get("life") not in ("event", "season"):
            continue
        causes = ice_causes(r)
        if r["kind"] == "ice_incident" and NON_ICE.search(r.get("title") or ""):
            continue
        if r["kind"] == "hazard" and not ICE_NOTE.search(f"{r.get('title', '')} {r.get('comment', '')}"):
            continue
        if not causes:
            continue
        items.append({"i": i, "lat": r["lat"], "lon": r["lon"], "flow": bool(FLOW.search(r.get("title") or "")), "causes": causes})
    groups = []
    for it in items:
        near = [g for g in groups if g[0]["flow"] == it["flow"] and any(haversine_m(it["lat"], it["lon"], o["lat"], o["lon"]) <= ZONE_LINK_M for o in g)]
        if near:
            keep = near[0]
            for g in near[1:]:
                keep.extend(g)
                groups.remove(g)
            keep.append(it)
        else:
            groups.append([it])
    zones = []
    for g in groups:
        rs = [reports[x["i"]] for x in g]
        if not any(r["kind"] == "ice_incident" for r in rs) and len(rs) < 2:
            continue  # one old crack is not a place yet
        votes = Counter()
        for r in rs:
            t = r.get("title") or ""
            if t in ZONE_TITLE_NAME:
                votes[ZONE_TITLE_NAME[t]] += 1
            elif ":" in t:
                p = re.sub(r"\s*\(.*?\)", "", t.split(":")[0]).strip()
                votes[ZONE_ALIAS.get(p, p)] += 1
        ranked = votes.most_common()
        name = ranked[0][0] if ranked else sector_of(rs[0]["lat"], rs[0]["lon"])
        if len(ranked) > 1 and ranked[1][1] * 3 >= ranked[0][1] and ranked[1][0] not in name:
            name = f"{name} — {ranked[1][0]}"
        lat = sum(r["lat"] for r in rs) / len(rs)
        lon = sum(r["lon"] for r in rs) / len(rs)
        radius = max(haversine_m(lat, lon, r["lat"], r["lon"]) + min(r.get("prec") or 500, 1500) / 2 for r in rs)
        causes = defaultdict(list)
        for x in g:
            for c in x["causes"]:
                causes[c].append(int(reports[x["i"]]["date"][:4]))
        zid = f"z{len(zones) + 1}"
        cases = []
        for x in sorted(g, key=lambda x: reports[x["i"]]["date"], reverse=True):
            r = reports[x["i"]]
            r["icez"] = zid
            t = re.sub(r"\s*\(\d{4}\)\s*$", "", r.get("title") or "")
            t = t.split(":", 1)[1].strip() if ":" in t else t
            cases.append({"d": r["date"], "t": short(t, 70), "u": r.get("url") or "", "s": r["src"]})
        zones.append({"id": zid, "name": name, "lat": round(lat, 5), "lon": round(lon, 5),
                      "r": int(round(min(3500, max(800, radius)) / 100) * 100), "flow": g[0]["flow"],
                      "causes": {k: sorted(v) for k, v in causes.items()}, "n": len(g),
                      "last": max(r["date"] for r in rs), "cases": cases})
    zones.sort(key=lambda z: (-z["n"], z["name"]))
    return zones


def load_json(name):
    path = RESEARCH / f"{name}.json"
    if name in SKIP or not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as error:
        print(f"skip {name}: {error}")
        return {}
    return payload if isinstance(payload, dict) else {}


def main():
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    DOWNLOADS.mkdir(parents=True, exist_ok=True)

    reports, seen = [], {}
    dropped = Counter()
    excluded = {u.rstrip("/").lower() for u in (load_json("exclude").get("urls") or {})}
    # Research files first: for a card both collected, the fresher, richer copy wins.
    for r in list(research_reports()) + list(baseline_reports()):
        if not in_area(r["lat"], r["lon"]):
            dropped["вне района"] += 1
            continue
        if r["url"] and r["url"].rstrip("/").lower() in excluded:
            dropped["исключено вручную"] += 1
            continue
        # The same card reached through two routes (e.g. FisherMap city + lake page, or the first
        # research and a research agent). A catalogue page lists many places under one URL, so a
        # repeat is the same link *and* the same place, not the link alone.
        # A slip and the parking next to it may share a page: the kind is part of the key.
        keys = [k for k in (("sid", r["src"], r["sid"], r.get("sub") or r["kind"]) if r["sid"] else None,
                            ("url", r["url"].rstrip("/").lower(), r.get("sub") or r["kind"]) if r["url"] else None) if k]
        if any(haversine_m(r["lat"], r["lon"], la, lo) < 150 for k in keys for la, lo in seen.get(k, [])):
            dropped["повтор источника"] += 1
            continue
        for k in keys:
            seen.setdefault(k, []).append((r["lat"], r["lon"]))
        text = " ".join(str(r.get(k) or "") for k in ("comment", "method", "title"))
        r["season"] = season_of(r["date"], text, r.pop("season_given", ""))
        r["dist"] = round(haversine_m(CENTER[0], CENTER[1], r["lat"], r["lon"]) / 1000, 1)
        r["zone"] = "core" if r["dist"] <= CORE_KM else "ext"
        r["sector"] = sector_of(r["lat"], r["lon"])
        if r.pop("doubt", False):
            r["comment"] = f"{r.get('comment', '')} Место под сомнением: координата легла на сушу.".strip()
        reports.append(r)

    # The club catalogue's area pins (fisher.spb.ru) reached us three times: from the catalogue itself,
    # from the forum crawl and from the first research. One pin per area, the richest copy first.
    order = {"report_sites": 0, "forums_old": 1, "baseline": 2}
    # Only the catalogue pages are area pins; the club's dated reports (research/points_2026.json) stay separate.
    pins = [r for r in reports if r["cls"] == "C" and "message-bycatalog.php" in (r.get("url") or "")]
    pins.sort(key=lambda r: order.get(r["agent"], 3))
    drop = set()
    for i, a in enumerate(pins):
        if id(a) in drop:
            continue
        for b in pins[i + 1:]:
            if id(b) not in drop and haversine_m(a["lat"], a["lon"], b["lat"], b["lon"]) < 400:
                drop.add(id(b))
    if drop:
        dropped["повтор метки района ПКР"] += len(drop)
        reports = [r for r in reports if id(r) not in drop]

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
        life, until, months, why = lifetime(r)
        r.update({"life": life, "until": until, "months": months, "why": why})
    zones = ice_zones(reports)
    for r in reports:
        if r["life"] == "perm":
            r.pop("life")  # the default: saves 13 bytes on 1900 records
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
            "by_life": Counter(r.get("life", "perm") for r in reports).most_common(),
            "ice_zones": len(zones),
            "dropped": dict(dropped),
        },
    }
    (SITE_DATA / "points.json").write_text(json.dumps(points, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    bio, rules, nav = load_json("biology_seasons"), load_json("rules_safety"), load_json("nav_structures")
    # The species notes quote the ban dates before order № 747; since 01.09.2024 they are fixed dates.
    fixes = {"запрет от распаления льда по 15 июня": "запрет с 1 мая по 15 июня",
             "запрет от распаления льда до 31 мая": "запрет с 15 апреля по 31 мая"}
    for sp in bio.get("species") or []:
        for k, v in list(sp.items()):
            if isinstance(v, str):
                for old, new in fixes.items():
                    v = v.replace(old, new)
                sp[k] = v
    depth = load_json("depth")
    practical = load_json("practical")
    overlays = []
    for o in depth.get("image_overlays") or []:
        name = Path(str(o.get("file") or o.get("url") or "")).stem
        if not (ROOT / "site" / "overlays" / f"{name}.webp").exists():
            continue  # scripts/prepare_overlays step not run for this sheet
        bounds = o.get("bounds")
        if isinstance(bounds, str):
            bounds = json.loads(bounds)
        overlays.append({"name": o.get("name"), "url": f"overlays/{name}.webp", "bounds": bounds,
                         "depth_content": o.get("depth_content"), "source_url": o.get("source_url")})
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
        "ice_from_angler_reports": bio.get("ice_from_angler_reports") or {},
        "wind_effects": bio.get("wind_effects") or [],
        "regulations": rules.get("regulations") or {},
        "ice_rules": rules.get("ice_rules") or [],
        "ice_zones": zones,
        "timeseries": timeseries(),
        "tackle": tackle_context(),
        "practical": {k: practical.get(k) for k in ("boat_rules", "ice_rules_general", "weather", "emergency", "coverage")},
        "depth": {
            "charts": charts_context(),
            "chart_isobaths": "data/depth_chart_isobaths.geojson" if (SITE_DATA / "depth_chart_isobaths.geojson").exists() else "",
            "overlays": overlays,
            "isobaths": "data/depth_isobaths.geojson" if (SITE_DATA / "depth_isobaths.geojson").exists() else "",
            # SKIP_AGENTS=depth_model holds back the depth model while it is being rebuilt.
            "grid": "data/depth_grid.json" if (SITE_DATA / "depth_grid.json").exists() and "depth_model" not in SKIP else "",
            "isolines": "data/depth_isolines.geojson" if (SITE_DATA / "depth_isolines.geojson").exists() and "depth_model" not in SKIP else "",
            "community": "data/depth_community.geojson" if (SITE_DATA / "depth_community.geojson").exists() else "",
            # Fresh soundings of the Volkhov mouth and bar (ENC 2023 via a Волго-Балт scheme, research/fresh_depth.md).
            "vvp": "data/depth_vvp.geojson" if (SITE_DATA / "depth_vvp.geojson").exists() else "",
            # Fetch table for the wave near the shore (scripts/build_fetch.py, research/wave_report.md).
            "fetch": "data/fetch.json" if (SITE_DATA / "fetch.json").exists() else "",
            "shade": depth_shade() if "depth_model" not in SKIP else {},
            "tiles": tile_index(),
            "phone_workflows": depth.get("phone_workflows") or [],
        },
        "lines": nav.get("lines") or [],
        "tile_layers": curated_tiles(nav.get("tile_layers") or []),
        "sources": sources,
    }
    (SITE_DATA / "context.json").write_text(json.dumps(context, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    write_downloads(reports, markers)
    print(json.dumps(points["stats"], ensure_ascii=False, indent=1))


def xml(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def write_downloads(reports, markers):
    kind_ru = {"fishing": "Рыбалка", "observation": "Наблюдение", "structure": "Структура", "launch": "Спуск/база",
               "hazard": "Опасность", "landmark": "Ориентир", "ice_incident": "Происшествие на льду", "service": "Сервис"}
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
