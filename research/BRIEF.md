# Ladoga research brief (shared by all research agents)

Goal: collect as many PUBLIC, precisely-located fishing points / observations for SOUTH LADOGA as possible,
plus context (seasons, migration, regulations, navigation) for an interactive online map.

## Area
- Core: within 50 km of Новая Ладога / устье Волхова (60.1037, 32.2940): Волховская губа, Креницы, о. Птинов,
  Варецкие банки, Дубно, Лигово, Вороново, о. Сухо, устье/нижний Волхов (до Старой Ладоги), устье Сяси, Кобона.
- Extended (keep, but flag): whole southern Ladoga south of lat 60.75 between lon 30.9 and 33.3 —
  Шлиссельбург / бухта Петрокрепость, Осиновец, Кобона, Свирская губа / устье Свири, Загубская губа, Свирица.
- Bounding box for queries: lat 59.85..60.80, lon 30.90..33.40. Water of Ladoga + lower reaches of Волхов/Сясь/Свирь/Нева-исток only.
  Skip separate lakes, ponds, canals far from the lake, upper Volkhov (south of Старая Ладога ~60.00).

## Baseline already collected (do NOT spend effort re-collecting these)
- FisherMap city "Новая Ладога" (id 49, type=city): 170 cards, 144 in area. IDs are in C:\STT\ladoga-fishing-map\data\baseline\fishermap_novaya_ladoga_all_170.csv
- fishing-report.ru WP posts under tags 1002,4267,2679,945,648,8008,7081,4411,4956,3153,3154,3002 (88 geotagged, 36 in area).
- Telegram t.me/s/rybalka_spb_lenoblasti searched for a few place names (3 posts).
- Scripts showing how these were fetched: C:\STT\ladoga-fishing-map\data\baseline\fetch_*.mjs (Node 24 available: `node`, also python 3.12).
  Duplicates against the baseline are fine to report (mark `"dup_of_baseline": true` if you know) — the merger dedupes by coordinates+source id.

## Output format (STRICT)
Write your results to C:\STT\ladoga-fishing-map\research\<your_slug>.json as:
{
  "agent": "<slug>",
  "generated": "2026-09-22",
  "sources_checked": [ {"name": "...", "url": "...", "status": "used|no_data|blocked|login_required|error", "note": "..."} ],
  "points": [ {
      "latitude": 60.12345, "longitude": 32.12345,          // WGS84 decimal degrees, >=4 decimals when the source gives it
      "kind": "fishing" | "observation" | "structure" | "launch" | "hazard" | "landmark" | "ice_incident",
      "confidence_class": "A" | "B" | "C",   // A = exact GPS published by angler/source; B = public geotag of a report/photo/observation; C = named place / structure located from a description or map label
      "coord_precision_m": 10,               // your honest estimate
      "fish": ["Судак","Щука"],              // Russian names, capitalised; [] if none
      "date": "YYYY-MM-DD" | "YYYY-MM" | "YYYY" | "",
      "season": "ice" | "open_water" | "",
      "title": "short name, e.g. 'Банка у о. Птинов' ",
      "comment": "ONE short sentence in Russian in YOUR OWN WORDS (depth/method/bait/catch if known). Never paste long quotes.",
      "depth": "", "method": "", "catch": "",
      "source": "site or dataset name", "source_url": "direct URL to the specific post/card/object", "source_id": "",
      "raw_coordinate_text": "the exact coordinate string as published, if any"
  } ],
  "notes": "free text: what worked, what did not, ideas for more"
}
Also save any raw downloads you make into C:\STT\ladoga-fishing-map\research\raw\<your_slug>\ (json/html/gpx).

## Rules
- Public data only. No logins, no account creation, no CAPTCHA solving, no paywall bypass. If a site needs login, record it in sources_checked and move on.
- Be polite: sequential requests or small concurrency, ~0.3-1 s between requests to one host, real UA string.
- Never invent coordinates. If a place is only named, geolocate it yourself ONLY when unambiguous (then class C, precision 300-2000 m, say how in comment).
- Coordinates in text like "N60°15.123' E32°05.456'" or "60 15 07 / 32 05 27" must be converted to decimal carefully (DM vs DMS!) — keep raw_coordinate_text.
- Russian text in outputs; UTF-8 without BOM. Validate your JSON parses before finishing (python -c "import json;json.load(open(p,encoding='utf-8'))").
- Your final chat answer: short summary (counts, best sources, blockers) — the data lives in the JSON file.
