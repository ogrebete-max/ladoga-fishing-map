#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pure functions of the report monitor (fetch_reports.py): the gazetteer of southern Ladoga, parsers of the source
pages, extraction of fishing reports and incidents, templated titles and comments, deduplication helpers.

Ported from the research scripts of 22–23.09.2026 (research/raw/fresh/scripts: anchors, common_extract,
fisher_extract, tg_extract, build_points_2026; research/raw/social_reports/scripts: extract_rsl, gazetteer,
parse_common). The regular expressions are kept as they were checked there; the changes are marked «monitor:».

No network and no files here. Nothing of a post is copied: a record carries templated facts (place, fish, gear,
depth, catch, ice) and the link to the post; author names, usernames and phone numbers are never read into it.

Python 3.8+ standard library only.
"""
import datetime as dt
import email.utils
import hashlib
import html as htmlmod
import math
import re
import urllib.parse
import xml.etree.ElementTree as ET

MSK = dt.timezone(dt.timedelta(hours=3))  # Moscow time, no DST since 2014

# ------------------------------------------------------------------------------------ area (build_data.py)

CENTER = (60.1037113, 32.2939775)  # Новая Ладога / устье Волхова
CORE_KM = 55
BBOX = (59.85, 30.90, 60.80, 33.40)  # lat_min, lon_min, lat_max, lon_max
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


def hav(a, b, c, d):
    """Distance in metres between (a, b) and (c, d), degrees."""
    r = 6371008.8
    p1, p2 = math.radians(a), math.radians(c)
    dp, dl = p2 - p1, math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def offset(lat, lon, dist_m, bearing_deg):
    r = 6371008.8
    br = math.radians(bearing_deg)
    la1, lo1 = math.radians(lat), math.radians(lon)
    la2 = math.asin(math.sin(la1) * math.cos(dist_m / r) + math.cos(la1) * math.sin(dist_m / r) * math.cos(br))
    lo2 = lo1 + math.atan2(math.sin(br) * math.sin(dist_m / r) * math.cos(la1),
                           math.cos(dist_m / r) - math.sin(la1) * math.sin(la2))
    return round(math.degrees(la2), 5), round(math.degrees(lo2), 5)


def in_bbox(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def sector_of(lat, lon):
    return min(SECTORS, key=lambda s: hav(lat, lon, s[1], s[2]))[0]


def area_fields(lat, lon):
    """sector, dist (km from CENTER) and zone, computed as scripts/build_data.py does."""
    dist = round(hav(CENTER[0], CENTER[1], lat, lon) / 1000, 1)
    return {"sector": sector_of(lat, lon), "dist": dist, "zone": "core" if dist <= CORE_KM else "ext"}


# ---------------------------------------------------------------------------------- gazetteer (anchors.py)

L = r"(?<![а-яёА-ЯЁ])"   # left word edge for Cyrillic
R = r"(?![а-яёА-ЯЁ])"    # right word edge

# key, regex, lat, lon, precision_m, label, where the coordinate comes from. Order matters: specific features first.
A = [
    ("gabanov", r"габанов", 60.70000, 32.83333, 1500, "мыс Габанов (Свирская губа)", "Лоция: мыс Габанов"),
    ("svir_buoy", r"свирск\w+\s+бу[йя]|поворотн\w+\s+бу[йя]", 60.53500, 32.71333, 1000, "поворотный буй Свирский", "Лоция: светящий буй Свирский"),
    ("storozh", L + r"сторожен|" + L + r"сторожно" + R, 60.53141, 32.62598, 1500, "Стороженский маяк / риф", "OSM: Стороженский маяк"),
    ("lisya", L + r"лись[ейяюи]" + R + r"|лисьей", 60.50363, 32.84890, 1000, "протока Лисья (Свирица)", "OSM/Nominatim: р. Лисья"),
    ("zagubye", r"загуб", 60.43175, 32.76461, 1500, "Загубье", "OSM/Nominatim: Загубье"),
    ("bugrov", r"бугровск|бугровый", 59.93852, 31.22647, 1200, "Бугровский маяк", "OSM: Бугровский маяк"),
    ("nazia_mouth", r"усть\w*\s+(?:р\.?\s*|речк\w*\s+|реки\s+)?назии", 59.90865, 31.35940, 900, "устье Назии", "OSM/Nominatim: р. Назия (устье)"),
    ("zelentsy", r"зеленц|зеленец", 59.99108, 31.36280, 1500, "о-ва Зеленцы", "метка каталога ПКР «о-ва Зеленцы»"),
    ("karedzhi", r"кареджи|кареджск", 60.11680, 31.38478, 1500, "о. Кареджи", "метка каталога ПКР «о-в Кареджи»"),
    ("zheleznitsa", r"железниц", 60.07422, 31.15911, 1800, "банка Железница", "Лоция: банка Железница"),
    ("sukho", r"(?-i:" + L + r"Сухо" + R + r")|о\.\s?сухо|остров\w*\s+сухо|маяк\w*\s+сухо", 60.40838, 32.08859, 1500, "о. Сухо", "метка каталога ПКР «о-в Сухо»"),
    ("ptinov", r"птинов|" + L + r"птина" + R, 60.22927, 32.08567, 1500, "о. Птинов", "метка каталога ПКР «о-в Птинов»"),
    ("varetsk", r"варецк", 60.27479, 32.06684, 2500, "Варецкие банки", "метка каталога ПКР «Варецкие банки»"),
    ("volkhov_mouth", r"усть\w*\s+(?:р\.?\s*|реки\s+)?волхов|волхов\w*\s+усть", 60.12400, 32.32984, 800, "устье Волхова", "Wikimapia/OSM: устье р. Волхов"),
    ("syas_mouth", r"усть\w*\s+(?:р\.?\s*|реки\s+)?сяс", 60.15307, 32.49024, 900, "устье Сяси", "Wikimapia/OSM: устье р. Сясь"),
    ("berezye", r"березь", 60.10221, 32.32600, 400, "Березье (правый берег Волхова у Новой Ладоги)", "OSM/Nominatim: Березье"),
    ("nemyatovo", r"немятов", 60.10858, 32.33756, 600, "Немятово (правый берег Волхова)", "OSM/Nominatim: Немятово-2"),
    ("vch", r"воинск\w+\s+част|" + L + r"в/?ч" + R + r"|конец\s+остров",60.09457, 32.31568, 400, "Волхов у заброшенной воинской части", "координата автора канала @fisher47region"),
    ("yacht", r"яхт.?клуб", 60.10370, 32.31608, 300, "Новая Ладога, яхт-клуб", "координата автора канала @fisher47region"),
    ("yushkovo", r"юшков", 60.07303, 32.33205, 900, "Юшковский рейд (Волхов)", "Лоция: Юшковский рейд"),
    ("issad", r"иссад", 60.06080, 32.34918, 800, "Иссад (Волхов)", "OSM/Nominatim: Иссад"),
    ("polyashi", r"поляш", 60.05146, 32.34437, 400, "Поляши (Волхов)", "координата автора канала @fisher47region"),
    ("babino", L + r"бабино" + R, 60.02845, 32.33611, 800, "Бабино (Волхов)", "OSM/Nominatim: Бабино"),
    ("gorchak", r"горчаковщ", 60.01387, 32.33001, 300, "Горчаковщина (Волхов)", "координата автора канала @fisher47region"),
    ("kurgany", r"курган", 60.01218, 32.30372, 300, "Курганы (Волхов у Старой Ладоги)", "координата автора канала @fisher47region"),
    ("staraya", r"стар\w+\s+ладог|староладож|ст\.\s?ладог", 60.01252, 32.32089, 1000, "Старая Ладога (Волхов)", "метка канала @fishingspb1"),
    ("syasstroy", r"сясьстро", 60.13971, 32.56375, 1200, "Сясьстрой (р. Сясь)", "OSM/Nominatim: Сясьстрой"),
    ("syas", L + r"сяс[ьи]" + R + r"|сяське|сясьск", 60.14215, 32.51458, 1500, "р. Сясь (низовье)", "метка канала @fishingspb1"),
    ("sviritsa", r"свириц", 60.47000, 32.90638, 1500, "Свирица", "OSM/Nominatim: Свирица"),
    ("svir_bay", r"свирск\w+\s+губ", 60.51888, 32.79990, 4000, "Свирская губа", "метка каталога ПКР «Свирица»"),
    ("zaostr", r"заостров", 60.30186, 32.60663, 1500, "Заостровье", "OSM/Nominatim: Заостровье"),
    ("kirikovo", r"кириков|шуряг", 60.33552, 32.57451, 2000, "Кириково / Шурягская губа", "метка каталога ПКР «Кириково»"),
    ("voronovo", r"воронов[оау]" + R, 60.27138, 32.64382, 1500, "Вороново", "метка канала @fishingspb1"),
    ("dubno", r"дубно" + R + r"|дубенск|дубненск|дубнинск", 60.23461, 31.98335, 2000, "Дубно", "метка каталога ПКР «Дубно»"),
    ("sumskoe", r"сумск", 60.22193, 31.89513, 1500, "Сумское / мыс Сумский", "OSM: мыс Сумский"),
    ("kivgoda", r"кивгод", 60.24832, 31.67943, 1500, "Кивгода", "Wikimapia: Кивгодский остров"),
    ("ligovo", r"лигов", 60.24097, 31.77885, 2000, "Лигово", "метка каталога ПКР «Лигово»"),
    ("chernoe", r"(?-i:" + L + r"Ч[её]рно[ем]" + R + r")(?!\s+мор)|д\.\s?ч[её]рно|ч[её]рн\w+\s+сатам|ладога.ч[её]рно", 60.13373, 31.56895, 2000, "Чёрное", "метка каталога ПКР «Черное»"),
    ("lednevo", r"ледн[её]в", 60.10892, 31.48545, 2500, "Леднево", "метка каталога ПКР «Леднево»"),
    ("kobona", r"кобон|кабон", 60.01865, 31.51182, 2500, "Кобона", "метка каталога ПКР «Кобона»"),
    ("lavrovo", L + r"лаврово" + R + "|" + L + r"р[её]гово" + R, 59.95971, 31.51781, 2500, "Лаврово", "метка каталога ПКР «Лаврово»"),
    ("shaldikha", r"шальдих", 59.91912, 31.43934, 2000, "Нижняя Шальдиха", "метка каталога ПКР «Ниж. Шальдиха»"),
    ("nazia", r"назия|назии|назию", 59.92749, 31.34767, 2000, "Назия", "метка каталога ПКР «Назия»"),
    ("koshkino", r"кошкин|им\.?\s*морозова|имени\s+морозова|морозовк", 59.97638, 31.07685, 1500, "Кошкино", "метка каталога ПКР «Кошкино - им. Морозова»"),
    ("petrokr", r"петрокреп", 59.95371, 31.06032, 2000, "бухта Петрокрепость", "метка каталога ПКР «Петрокрепость»"),
    ("neva_source", r"исток\w*\s+невы|шлиссельбург|орешек|" + L + r"ореха" + R, 59.95300, 31.03400, 800, "исток Невы (Шлиссельбург)", "OSM: крепость Орешек / исток Невы"),
    ("gavan", r"бухт\w+\s+гавань|баз\w+\s+(?:отдыха\s+)?[«\"]?гавань", 60.24514, 30.95123, 2000, "бухта Гавань", "метка каталога ПКР «бухта Гавань»"),
    ("glubokaya", r"бухт\w+\s+глубок|ганнибал", 60.01107, 31.10082, 1500, "бухта Глубокая", "метка каталога ПКР «бухта Глубокая»"),
    ("kokorevo", r"кокорев|коккорев|4[34]\W{0,3}(?:-?(?:й|ой|ем|ом))?\s*км\.?\s*дорог", 60.05713, 31.08028, 1500, "Коккорево (44-й км Дороги жизни)", "метка каталога ПКР «Кокорево(44-ый км)»"),
    ("osinovets", r"осиновец", 60.11880, 31.08061, 1200, "Осиновец", "OSM: Осиновецкий маяк"),
    ("morye", L + r"морь[еяю]" + R, 60.16376, 31.03207, 1500, "Морье", "OSM/Nominatim: Морье"),
    ("ladoga_station", L + r"ст\.?\s*ладожское\s+озеро|станци\w+\s+ладожское",60.12243, 31.09073, 1500, "ст. Ладожское Озеро", "метка каталога ПКР"),
    ("krenitsy", r"крениц|криниц", 60.13315, 32.28498, 2500, "Креницы", "метка каталога ПКР «Креницы»"),
    ("novaya_ladoga_river", r"нов\w+\s+ладог|н\.\s?ладог", 60.10250, 32.32200, 700, "Волхов у Новой Ладоги", "OSM: русло Волхова напротив Новой Ладоги"),
    # monitor: places that 47news and the rescuers name in incident reports (after the research list, so the order of
    # the fishing anchors above is unchanged).
    ("knyazhoy", r"мыс\w*\s+княж|" + L + r"княжно" + R, 60.22640, 32.12240, 2000, "мыс Княжой", "OSM: мыс Княжой (в сводках «мыс Княжно»)"),
    ("svir_mouth", r"усть\w*\s+(?:р\.?\s*|реки\s+)?свир", 60.47000, 32.90638, 2000, "устье Свири (Свирица)", "OSM/Nominatim: Свирица"),
]
ANCHORS = [(k, re.compile(rx, re.I), la, lo, pr, label, how) for k, rx, la, lo, pr, label, how in A]
BY_KEY = {k: (la, lo, pr, label, how) for k, rx, la, lo, pr, label, how in A}
BY_KEY["protoka7"] = (60.13661, 32.22611, 1000, "протока «7 км» (выход из Новоладожского канала)",
                      "координата из списка стоянок iv70/fishing-club (агенты report_sites, forums_old)")
BY_KEY["novaya_ladoga_lake"] = (60.15586, 32.33723, 2500, "Волховская губа у Новой Ладоги", "метка каталога ПКР «Новая Ладога»")

SPECIFIC = {"protoka7", "gabanov", "svir_buoy", "storozh", "lisya", "bugrov", "nazia_mouth", "zelentsy", "karedzhi",
            "zheleznitsa", "sukho", "ptinov", "varetsk", "volkhov_mouth", "syas_mouth", "berezye", "nemyatovo", "vch",
            "yacht", "yushkovo", "issad", "polyashi", "babino", "gorchak", "kurgany", "sumskoe", "kivgoda", "gavan",
            "osinovets", "morye"}

# fisher.spb.ru catalog: category 5 (Ладожское озеро) water id → default anchor (None: placed by the text).
CATALOG_DEFAULT = {
    157: "varetsk", 159: "gavan", 160: "glubokaya", 161: "dubno", 162: "kirikovo", 163: "kobona", 164: "kokorevo",
    165: "koshkino", 166: "krenitsy", 169: "ladoga_station", 170: "lavrovo", 171: "lednevo", 172: "ligovo",
    173: "nazia", 174: "shaldikha", 175: "novaya_ladoga_lake", 176: "ptinov", 177: "svir_bay", 178: "sukho",
    179: "chernoe", 186: "petrokr", 188: "zelentsy", 205: "karedzhi", 192: None, 190: None, 183: None,
}
# Northern waters of the same catalog (Береговое, зал. Владимировский, Кузнечное-Березово, Куркиеки, о-в Койонсаари).
CATALOG_NORTH = (156, 158, 167, 168, 189)

# North-west / north Ladoga and other waters: a report naming only these is outside the area.
NW_EXCLUDE = re.compile(r"золот\w+\s+берег|запорожск|бурн[аойу]|пятиречь|приозерск|тайпал|соловь[её]в|вуокс|лахденпох|сортавал|"
                        r"питкярант|шхер|суходольск|удальцов|финск\w+\s+мол|бухт\w+\s+далёк|бухт\w+\s+далек|раухал|кузнечн|куркиек|"
                        r"синявинск\w+\s+карьер|финск\w+\s+залив", re.I)
# gazetteer.py: texts about north Ladoga, Karelia, Onega, the game «Русская рыбалка», the upper Volkhov.
EXCLUDE = re.compile(
    r"русская рыбалка|\bрр4\b|\bрр 4\b|rf4|russian fishing|карели|куркиек|видлиц|уксунлахт|шхер|тиурул|приозерск|"
    r"сортавал|питкярант|лахденпох|онежск|онега|вуокс|суходольск|грузино|кириши|волхов[е]?\s+выше|выше\s+гэс|ниже\s+гэс|волховск\w*\s+гэс|"
    r"мандрог|подпорож|свирьстро|лодейн|валаам|коневец|мегрег|олонец|чудов|новгород|таймен|ленка\b|ленок",
    re.I)
# tg_extract.py: the Gulf of Finland, the city, Onega.
OUTSIDE = re.compile(r"финск\w*\s+залив|сбфз|лахта|горская|сестрорецк|кронштадт|южн\w+\s+дамб|вуокс|суходольск|"
                     r"карельск\w+\s+перешеек|онежск\w*\s+озер|морск\w+\s+канал", re.I)


def hits_in_text_order(text):
    """Anchors found in the text, ordered by the position of their first match."""
    found = []
    for k, rx, la, lo, pr, label, how in ANCHORS:
        m = rx.search(text or "")
        if m:
            found.append((m.start(), k))
    return [k for _, k in sorted(found)]


KM7_PLACE = re.compile(r"проток\w*\s+7|7\s*(?:-?(?:й|ой|ом|ым))?\s*(?:км|километр)\w*[^.]{0,60}(?:трост|камыш|остров|проток)|"
                       r"(?:вых\w*|вышел|через)\s+(?:в\s+|через\s+)?7\s*(?:-?(?:й|ой|ом))?\s*км|"
                       r"(?:трост|камыш|остров|проток)[^.]{0,60}7\s*(?:-?(?:й|ой|ом))?\s*(?:км|километр)", re.I)


def anchors_in(text, km7=True):
    hits = hits_in_text_order(text)
    if "svir_buoy" in hits and not re.search(r"свир", text or "", re.I):
        hits.remove("svir_buoy")
    if km7 and KM7_PLACE.search(text or ""):
        hits.insert(0, "protoka7")
    return hits


def dist_km(a, b):
    return hav(BY_KEY[a][0], BY_KEY[a][1], BY_KEY[b][0], BY_KEY[b][1]) / 1000.0


def choose(hits, default):
    """fisher_extract.choose: a specific feature inside the catalog place wins over the catalog pin."""
    if default:
        spec = [h for h in hits if h in SPECIFIC and dist_km(h, default) <= 12]
        if spec:
            return spec[0], "text (уточнение внутри места каталога)"
        return default, "catalog" if not hits else "catalog (+упомянуты другие места)"
    spec = [h for h in hits if h in SPECIFIC]
    if spec:
        return spec[0], "text"
    return hits[0], "text"


def nearest_anchor(lat, lon, keys=None):
    best, bk = None, None
    for k, v in BY_KEY.items():
        if keys is not None and k not in keys:
            continue
        d = hav(lat, lon, v[0], v[1])
        if best is None or d < best:
            best, bk = d, k
    return bk, (best or 0.0) / 1000.0


# -------------------------------------------------------------- fish, gear, depth, catch (common_extract.py)

FISH = [("судак", "Судак"), ("судач", "Судак"), ("пикал", "Судак"), ("клыкаст", "Судак"), ("щук", "Щука"), ("щуч", "Щука"),
        ("окун", "Окунь"), ("окуш", "Окунь"), ("полосат", "Окунь"), ("горбач", "Окунь"),
        ("подлещ", "Лещ"), ("лещ", "Лещ"), ("плотв", "Плотва"), ("плотиц", "Плотва"), ("сорог", "Плотва"),
        ("сиг", "Сиг"), ("ряпушк", "Ряпушка"), ("рипус", "Ряпушка"), ("корюшк", "Корюшка"), ("корюх", "Корюшка"),
        ("налим", "Налим"), ("жерех", "Жерех"), ("язь", "Язь"), ("язя", "Язь"), ("язи", "Язь"), ("подъязик", "Язь"),
        ("густер", "Густера"), ("уклей", "Уклейка"), ("бел[ьи](?![а-яё])", "Уклейка"), ("ерш", "Ёрш"), ("ёрш", "Ёрш"), ("ерши", "Ёрш"),
        ("синец", "Синец"), ("синц", "Синец"), ("чехон", "Чехонь"), ("карас", "Карась"), ("сом", "Сом"), ("голавл", "Голавль"),
        ("елец", "Елец"), ("ельц", "Елец"), ("красноперк", "Краснопёрка"), ("краснопёрк", "Краснопёрка"),
        ("лин[ьяеи](?![а-яё])", "Линь"), ("лин(?:ей|ём|ем|ями|ям|ьк[а-яё]*)(?![а-яё])", "Линь"),
        ("сырт", "Сырть"), ("форел", "Форель"), ("беглянк", "Форель"), ("хариус", "Хариус"), ("пескар", "Пескарь")]
FISH_RE = [(re.compile(r"(?<![а-яё])" + stem, re.I), name) for stem, name in FISH]
# words that contain fish stems but are not fish
NOT_FISH = re.compile(r"сомнен|сомне|сомнит|сомк|сиганул|сигнал|сигар|линия|лини[ия]|линей[кн]|щукар|окунул|окунать|"
                      r"белоснеж|белый|белые|белых|бель[её]|ершист", re.I)

METHODS = [("мормыш", "мормышка"), ("безмотыл", "безмотылка"), ("блесн", "блесна"), ("блесен", "блесна"), ("балансир", "балансир"),
           ("жерлиц", "жерлицы"), ("поставуш", "поставушки"), ("поплав", "поплавок"), ("фидер", "фидер"), ("донк", "донка"),
           ("спиннинг", "спиннинг"), ("джиг", "джиг"), ("троллинг", "троллинг"), ("тролил", "троллинг"), ("троли", "троллинг"),
           ("дорожк", "дорожка"), ("воблер", "воблер"), ("отводн", "отводной"), ("кастинг", "спиннинг"), ("нахлыст", "нахлыст"),
           ("бортовух", "бортовая удочка"), ("кивок", "мормышка"), ("кольц", "кольцо")]
ICE = re.compile(r"л[её]д|подл[её]дн|лунк|палатк|мотособак|собак[аеу]|аэролодк|сверл|бур[аеи]л?|жерлиц|балансир|мормыш|безмотыл|развозк", re.I)


def fish_in(text):
    t = NOT_FISH.sub(" ", text or "")
    out = []
    for rx, name in FISH_RE:
        if rx.search(t) and name not in out:
            out.append(name)
    return out


def methods_in(text):
    t = (text or "").lower()
    out = []
    for stem, name in METHODS:
        if stem in t and name not in out:
            out.append(name)
    return out


NUM = r"(\d+(?:[.,]\d+)?)"
DEPTH_RES = [
    re.compile(r"глубин\w*\s*(?:около|примерно|порядка|от|до|в|—|-|:)?\s*" + NUM + r"(?:\s*(?:-|–|÷|до|…|\.\.)\s*" + NUM + r")?\s*(?:м\b|метр)", re.I),
    re.compile(r"(?:на|по)\s+" + NUM + r"(?:\s*(?:-|–|÷|…)\s*" + NUM + r")?\s*(?:-?х|-?ти|-?и)?\s*(?:м\b|метр(?:ах|ов|а)?\b)(?!\s*/\s*с)", re.I),
    re.compile(r"от\s+" + NUM + r"\s*(?:м\.?)?\s*до\s+" + NUM + r"\s*(?:м\b|метр)", re.I),
]


# monitor: «На 18 метрах поймал пару линьков» in a feeder report is the casting distance, not the depth.
DISTANCE_CTX = re.compile(r"дистанц|заброс|кида[лтю]|отбро", re.I)
FEEDER_CTX = re.compile(r"фидер|донк|кормушк|поплав", re.I)


def depth_in(text):
    t = text or ""
    for i, rx in enumerate(DEPTH_RES):
        m = rx.search(t)
        if m and i == 1:  # «на / по N м» without the word «глубина»
            n = float(m.group(1).replace(",", "."))
            if DISTANCE_CTX.search(t[max(0, m.start() - 100):m.end() + 40]) or (n >= 16 and FEEDER_CTX.search(t)):
                continue
        if m:
            a = m.group(1).replace(",", ".")
            b = (m.group(2) or "").replace(",", ".") if m.lastindex and m.lastindex >= 2 else ""
            try:
                fa = float(a)
                fb = float(b) if b else None
            except ValueError:
                continue
            if not (0.2 <= fa <= 40) or (fb is not None and not (0.2 <= fb <= 45)):
                continue
            if "/с" in t[m.end():m.end() + 3]:  # wind speed «м/с»
                continue
            s = (a if fb is None else f"{a}–{b}") + " м"
            return s.replace(".", ",")
    return ""


CATCH_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(кг|килограмм|шт|штук|хвост\w*|рыб\b)", re.I)


def catch_in(text):
    m = CATCH_RE.findall(text or "")
    if not m:
        return ""
    bits = []
    for n, u in m[:2]:
        u = u.lower()
        u = "кг" if u.startswith("к") else ("шт." if (u.startswith("ш") or u.startswith("хвост") or u.startswith("рыб")) else u)
        bits.append(f"{n.replace('.', ',')} {u}")
    return ", ".join(bits)


ICE_STRICT = re.compile(r"со\s+льда|(?<![а-яё])л[её]д(?:а|у|ом|е|ы|ов|янк\w*|ост\w*|ок)?(?![а-яё])|подл[её]дн|лунк|мотособак|"
                        r"аэролодк|аэросан|сверл|шнек|пешн|жерлиц|балансир|безмотыл", re.I)
OPEN_STRICT = re.compile(r"лодк|катер|спиннинг|джиг|троллинг|тролил|дорожк|фидер|донк|с берега|забродник|весл|мотор|слип|воблер|пвх", re.I)


def season_of(text, d):
    """ice / open_water by month first, words only decide the shoulder months."""
    m = d.month
    ice_w = bool(ICE_STRICT.search(text or ""))
    open_w = bool(OPEN_STRICT.search(text or ""))
    if m in (1, 2, 3):
        return "open_water" if (open_w and not ice_w) else "ice"
    if m in (6, 7, 8, 9, 10):
        return "open_water"
    if ice_w and not open_w:
        return "ice"
    if open_w and not ice_w:
        return "open_water"
    if ice_w and open_w:
        return "ice" if m in (12, 4) and re.search(r"со\s+льда|лунк|л[её]д\s+(?:стоит|держ|толщин)", text or "", re.I) else "open_water"
    return "open_water" if m in (5, 11) else ""


# -------------------------------------------------------------------------------------------- ice facts

_CM = r"(\d{1,3})(?:\s*(?:-|–|—|\.\.|до)\s*(\d{1,3}))?\s*(?:см|сантиметр\w*)(?![а-яё])"
ICE_CM_RES = [
    re.compile(r"толщин\w*\s+(?:льда|л[её]да)\s*(?:[:—–-]|около|примерно|порядка|до|от|~|составля\w+|был[аи]?|уже|всего|где-то)?\s*"
               r"(?:около\s+|примерно\s+|порядка\s+|~\s*)?" + _CM, re.I),
    re.compile(r"(?<![а-яё])л[её]д(?:а|ом)?\s+(?:толщиной\s+|по\s+|уже\s+|всего\s+|местами\s+|стоит\s+|около\s+|примерно\s+|порядка\s+|"
               r"до\s+|от\s+|~\s*|—\s*|-\s*|:\s*)*" + _CM, re.I),
    re.compile(_CM[:-len(r"(?![а-яё])")] + r"\s+(?:льда|л[её]д(?![а-яё])|прочного\s+льда|крепкого\s+льда)", re.I),
]
ICE_FLAGS = [
    ("трещины", re.compile(r"трещин|треснул|трещат", re.I)),
    ("промоины", re.compile(r"промоин|полынь|полыни|полынью|майн[аыу]|открыт\w+\s+вод", re.I)),
    ("вода на льду", re.compile(r"вод\w*\s+(?:на|по|поверх)\s+льд|наледь|налед|с\s+выходом\s+воды|вода\s+выступ|снежн\w+\s+каш", re.I)),
    ("торосы", re.compile(r"торос", re.I)),
    ("отрыв / подвижка", re.compile(r"отрыв|оторв|откол|подвижк|дрейф\w*\s+льд|льдин\w*\s+(?:унес|отнес|дрейф)|отжим", re.I)),
]


def ice_facts(text):
    """{"cm": "15–20", "flags": [...]} from an angler's ice report, or None."""
    t = text or ""
    cm = ""
    for rx in ICE_CM_RES:
        m = rx.search(t)
        if not m:
            continue
        a, b = int(m.group(1)), int(m.group(2)) if m.group(2) else None
        if not (1 <= a <= 150) or (b is not None and not (a < b <= 160)):
            continue
        cm = f"{a}–{b}" if b else str(a)
        break
    flags = [name for name, rx in ICE_FLAGS if rx.search(t)]
    out = {}
    if cm:
        out["cm"] = cm
    if flags:
        out["flags"] = flags
    return out or None


def ice_phrase(ice):
    if not ice:
        return ""
    bits = []
    if ice.get("cm"):
        bits.append(f"лёд {ice['cm']} см")
    bits += ice.get("flags") or []
    return ", ".join(bits)


# -------------------------------------------------------------------------------------------------- dates

RU_MONTHS = {"января": 1, "январь": 1, "февраля": 2, "февраль": 2, "марта": 3, "март": 3, "апреля": 4,
             "апрель": 4, "мая": 5, "май": 5, "июня": 6, "июнь": 6, "июля": 7, "июль": 7, "августа": 8,
             "август": 8, "сентября": 9, "сентябрь": 9, "октября": 10, "октябрь": 10, "ноября": 11,
             "ноябрь": 11, "декабря": 12, "декабрь": 12}
MONTH_RE = "(" + "|".join(sorted(RU_MONTHS, key=len, reverse=True)) + ")"
TEXT_DATE_DAYS = 40      # a date written at the start of a post counts when it is at most this many days old


def mkdate(y, mo, d):
    try:
        y = int(y)
        y = y + 2000 if y < 100 else y
        return dt.date(y, int(mo), int(d))
    except (ValueError, TypeError):
        return None


def parse_date_any(s, default_year=None):
    """ISO date/datetime, dd.mm.yyyy, «24 сентября 2026» (or «24 сентября» with default_year) → date or None."""
    s = (s or "").strip()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return mkdate(m.group(1), m.group(2), m.group(3))
    m = re.search(r"(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?!\d)", s)
    if m:
        return mkdate(m.group(3), m.group(2), m.group(1))
    m = re.search(r"(?<!\d)(\d{1,2})\s+" + MONTH_RE + r"(?:\s+(\d{4}))?", s, re.I)
    if m and (m.group(3) or default_year):
        return mkdate(m.group(3) or default_year, RU_MONTHS[m.group(2).lower()], m.group(1))
    try:
        t = email.utils.parsedate_to_datetime(s)
        if t is not None:
            return (t.astimezone(MSK) if t.tzinfo else t).date()
    except (TypeError, ValueError, IndexError):
        pass
    return None


YESTERDAY = re.compile(r"(?<![а-яё])вчера(?![а-яё])|вчерашн", re.I)
# monitor: «.» or «/» only («5,8 м» is a depth, not the 5th of August), not followed by a unit («8.5 кг»).
HEAD_DATE = re.compile(r"^[^\w]*(?:за\s+)?(?:(\d{1,2})\s*[-–]\s*)?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)(?![.,]\d)"
                       r"(?!\s*(?:кг|км|м|см|мм|гр?|шт|ч|час|мин|%)(?![а-яё]))", re.I)


# «01.03.-04.03.2026»: a range written with two dates, the last one counts.
HEAD_RANGE2 = re.compile(r"^[^\w]*(\d{1,2})[./](\d{1,2})\.?\s*(?:[-–]|и)\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)")
# tg_extract: a full date with the year anywhere in the first lines («Отчёт от 04.11.24», «Креницы. 21.01.26 Среда»).
DATE_IN = re.compile(r"(?<![\d.,])(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?![\d,])")


def _in_window(cand, post_date):
    return cand is not None and dt.timedelta(0) <= post_date - cand <= dt.timedelta(days=TEXT_DATE_DAYS)


def _head_date(text, post_date):
    first = (text or "").lstrip()[:40]
    m = HEAD_RANGE2.match(first)
    if m:
        cand = mkdate(m.group(5) or post_date.year, m.group(4), m.group(3))
        if cand and not m.group(5) and cand > post_date:
            cand = mkdate(post_date.year - 1, m.group(4), m.group(3))
        if _in_window(cand, post_date):
            return cand
    m = HEAD_DATE.match(first)
    if m:
        cand = mkdate(m.group(4) or post_date.year, m.group(3), m.group(2))
        if cand and not m.group(4) and cand > post_date:  # «28.12» written in January
            cand = mkdate(post_date.year - 1, m.group(3), m.group(2))
        if _in_window(cand, post_date):
            return cand
    return None


def report_date(text, post_date, source="pkr"):
    """(date, basis) of a report. fisher.spb.ru (fisher_extract): «вчера» in the first 300 characters → the day
    before the post, else a dd.mm(.yy) date at the start. Telegram (tg_extract): a date at the start (a range
    «19-20.09.26» → its last day) or a full dd.mm.yy date in the first 220 characters, else «вчера». A written date
    counts only within TEXT_DATE_DAYS before the post; otherwise the post date."""
    t = text or ""
    if source == "pkr":
        if YESTERDAY.search(t[:300]):
            return post_date - dt.timedelta(days=1), "text:вчера"
        cand = _head_date(t, post_date)
        return (cand, "text:date") if cand else (post_date, "post")
    cand = _head_date(t, post_date)
    if cand:
        return cand, "text:date"
    for m in DATE_IN.finditer(t[:220]):
        cand = mkdate(m.group(3), m.group(2), m.group(1))
        if _in_window(cand, post_date):
            return cand, "text:date"
    if YESTERDAY.search(t[:220]):
        return post_date - dt.timedelta(days=1), "text:вчера"
    return post_date, "post"


# ----------------------------------------------------------------------------------------------- templates

MON = ["янв.", "февр.", "март", "апр.", "май", "июнь", "июль", "авг.", "сент.", "окт.", "нояб.", "дек."]
ZERO = re.compile(r"по нулям|по нолям|\bноль\b|\b0\s+поклев|ни одной поклев|не клевал|без рыбы|рыбы нет|пусто|тишина|ни тычка", re.I)
FISH_ACC = {"Судак": "судак", "Щука": "щука", "Окунь": "окунь", "Лещ": "лещ", "Плотва": "плотва", "Сиг": "сиг",
            "Ряпушка": "ряпушка", "Корюшка": "корюшка", "Налим": "налим", "Жерех": "жерех", "Язь": "язь",
            "Густера": "густера", "Уклейка": "уклейка", "Ёрш": "ёрш", "Синец": "синец", "Чехонь": "чехонь",
            "Карась": "карась", "Сом": "сом", "Голавль": "голавль", "Елец": "елец", "Краснопёрка": "краснопёрка",
            "Линь": "линь", "Сырть": "сырть", "Форель": "форель", "Хариус": "хариус", "Пескарь": "пескарь"}
FEMININE = ("Щука", "Плотва", "Густера", "Уклейка", "Корюшка", "Ряпушка", "Сырть", "Чехонь", "Форель", "Краснопёрка")


def fish_phrase(fish):
    names = [FISH_ACC.get(f, f.lower()) for f in fish]
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " и " + names[-1]


def month_label(d):
    y, m = int(d[:4]), int(d[5:7])
    return f"{MON[m - 1]} {y}"


def title_for(label, fish, date):
    fs = ", ".join(f.lower() for f in fish[:2]) if fish else "рыбалка"
    return f"{label}: {fs} ({month_label(date)})"


def comment_for(season, label, fish, depth, methods, catch, text, place_note, ice=None):
    """Templated comment (build_points_2026.comment_for): season, place, fish, depth, gear, catch, ice, how placed."""
    s = {"ice": "Со льда", "open_water": "По открытой воде"}.get(season, "")
    parts = []
    if fish:
        if fish[0] not in FEMININE or len(fish) > 1:
            parts.append(("ловились " if len(fish) > 1 else "ловился ") + fish_phrase(fish))
        else:
            parts.append("ловилась " + fish_phrase(fish))
    if depth:
        parts.append(f"глубина {depth}")
    if methods:
        parts.append("снасти: " + ", ".join(methods[:3]))
    if catch:
        parts.append(f"в отчёте {catch}")
    if ZERO.search(text or "") and not catch:
        parts.append("клёв слабый или без улова")
    ip = ice_phrase(ice)
    if ip:
        parts.append(ip)
    head = (s + ", " if s else "") + label
    body = "; ".join(parts) if parts else "отчёт о рыбалке"
    c = f"{head}: {body}"
    if place_note:
        c += f"; {place_note}"
    return c[0].upper() + c[1:] + "."


def compact(rec):
    """Drop empty fields (None, "", [], {})."""
    return {k: v for k, v in rec.items() if v not in (None, "", [], {})}


# -------------------------------------------------------------------------- fishing reports: fisher.spb.ru

LOWER_VOLKHOV = {"novaya_ladoga_river", "berezye", "nemyatovo", "vch", "yacht", "yushkovo", "issad", "polyashi", "babino",
                 "gorchak", "kurgany", "staraya", "volkhov_mouth"}
SVIR_LOWER = {"sviritsa", "lisya", "zagubye", "svir_bay", "gabanov", "svir_buoy", "storozh", "svir_mouth"}
NEVA_SRC = {"neva_source", "petrokr", "koshkino"}
SYAS_LOWER = {"syasstroy", "syas_mouth", "syas"}
UPPER_VOLKHOV = re.compile(r"гэс|волхов[\s-]*2|волхове?\s*2|мост|плеханов|званк|извоз|кириш|грузин|пчев|чудов|новгород|обухов", re.I)
UPPER_VOLKHOV_TG = re.compile(UPPER_VOLKHOV.pattern + r"|гадово|подберез", re.I)
NOT_REPORT_PKR = re.compile(r"потерял|потеряна|потерян|нашедш|нашел\s+(?:кто|ли)|кто\s+нашел|вознагражден|верните|продам|куплю|"
                            r"продаю|погиб|утонул|скончал|похорон|памят", re.I)
CATCHY = re.compile(r"клю[ёеюя]|клев|клёв|поклев|поклёв|поймал|пойма|улов|ловил|ловили|вытащ|взял[аи]?\b|сход|засек|засёк|"
                    r"отловил|наловил|"
                    r"надёрг|надерг|натаск|словил|изловл|зацепил", re.I)  # monitor: more words for «caught»
CATCHY_TG = re.compile(CATCHY.pattern + r"|отобрал|забрал", re.I)
# monitor: decimals («8,21 км по навигатору» is 8.21, not 21) and no digit glued on the left.
KM = re.compile(r"(?<![\d.,])(\d{1,2}(?:[.,]\d{1,2})?)(?:\s*[-–]\s*(\d{1,2}(?:[.,]\d{1,2})?))?\s*(?:-?(?:й|ой|ом|ый|ти|и|ем))?\s*"
                r"(?:км\b|км\.|километр)", re.I)
KM_NOT_DIST = re.compile(r"дорог\w*\s+жизни|км\s*/\s*ч|км\.?\s*ч\b|скорост|по воде|намотал|проехал|проплыл", re.I)
PKR_BASE = "https://fisher.spb.ru/news/message.php?messageId="
PKR_SRC = "fisher.spb.ru (Питерский клуб рыбаков)"


def _num(s):
    return float(s.replace(",", "."))


def km_offset(key, text, when, month_ice):
    """Креницы / Кобона: «N км» from the usual ice exit, as fisher_extract (direction is not given)."""
    m = KM.search(text or "")
    if not m or key not in ("krenitsy", "kobona") or not month_ice:
        return None
    a = _num(m.group(1))
    b = _num(m.group(2)) if m.group(2) else a
    dist = (a + b) / 2.0
    ctx = text[max(0, m.start() - 25):m.end() + 25]
    if not (1 <= dist <= 25) or KM_NOT_DIST.search(ctx):
        return None
    d = round(dist, 1)
    ds = f"{d:g}".replace(".", ",")
    if key == "krenitsy":
        la, lo = offset(60.1211, 32.2968, dist * 1000, 330)
        return la, lo, int(max(1500, dist * 400)), (f"≈{ds} км от парковки у сараев Крениц по льду; направление не указано — "
                                                   "условно на ССЗ, как у точек 2005–2015 гг."), ds
    la, lo = offset(60.0212, 31.5426, dist * 1000, 350)
    return la, lo, int(max(1500, dist * 350)), (f"≈{ds} км от устья р. Кобоны; направление не указано — условно на север "
                                               "в озеро."), ds


def route_prec(key, hits, prec, lat=None, lon=None):
    """A report that names several nearby places (a route) gets a wider circle."""
    la = BY_KEY[key][0] if lat is None else lat
    lo = BY_KEY[key][1] if lon is None else lon
    near = [hav(la, lo, BY_KEY[h][0], BY_KEY[h][1]) / 1000 for h in hits if h != key and h in BY_KEY]
    near = [x for x in near if x <= 25]
    if near:
        prec = int(max(prec, min(6000, max(near) * 1000 / 2)))
    return prec


def pkr_extract(msg, category, water):
    """One fisher.spb.ru catalog message → (record or None, reason).
    msg: {"id": int, "date": date (post), "text": str, "place": catalog place name}. Private keys start with «_»."""
    text = msg.get("text") or ""
    hits = anchors_in(text)
    if category == 5:
        if water in CATALOG_NORTH:
            return None, "north"
        default = CATALOG_DEFAULT.get(water)
        if not default:
            if (EXCLUDE.search(text) or NW_EXCLUDE.search(text)) or not hits:
                return None, "no_place_or_outside"
        key, why = choose(hits, default)
    elif category in (2, 7):
        if water == 134:
            lower = [h for h in hits if h in LOWER_VOLKHOV]
            if not lower or (UPPER_VOLKHOV.search(text) and not re.search(
                    r"нов\w+\s+ладог|березь|немятов|устье|юшков|иссад|поляш|курган", text, re.I)):
                return None, "volkhov_not_lower"
            key, why = choose(lower, None)
        elif water == 143:
            lower = [h for h in hits if h in SVIR_LOWER]
            if not lower:
                return None, "svir_not_lower"
            key, why = choose(lower, None)
        elif water in (191, 28):
            src = [h for h in hits if h in NEVA_SRC]
            if not src:
                return None, "neva_not_source"
            key, why = choose(src, None)
        elif water == 145:
            s = [h for h in hits if h in SYAS_LOWER]
            if not s:
                return None, "syas_not_lower"
            key, why = choose(s, None)
        else:
            return None, "other_river"
    else:
        return None, "other_category"
    if NOT_REPORT_PKR.search(text) and not CATCHY.search(text):
        return None, "not_report"
    la, lo, prec, label, how = BY_KEY[key]
    pd = msg["date"]
    d, basis = report_date(text, pd)
    km_note = ""
    km = km_offset(key, text, d, bool(ICE.search(text)) or pd.month in (12, 1, 2, 3, 4))
    if km:
        la, lo, prec, km_note, ds = km
        label = f"{label}, ~{ds} км"
    prec = route_prec(key, hits, prec)  # fisher_extract: distances between the named places themselves
    fish, methods, depth, catch = fish_in(text), methods_in(text), depth_in(text), catch_in(text)
    if not (bool(fish or catch) and bool(CATCHY.search(text) or catch)):
        return None, "not_catch_report"
    season = season_of(text, d)
    ice = ice_facts(text) if (season == "ice" or d.month in (11, 12, 1, 2, 3, 4)) else None
    others = [BY_KEY[h][3] for h in hits if h != key and h in BY_KEY]
    if km_note:
        note = km_note
    elif why == "catalog":
        note = f"точка — метка места «{label}» в каталоге ПКР, в отчёте место точнее не указано"
    elif why.startswith("catalog"):  # monitor: say which other places the report names
        note = f"точка — метка места «{label}» в каталоге ПКР; в отчёте упомянуты также: {', '.join(others[:3])}"
    else:
        note = f"место по тексту отчёта ({how})"
    ds = d.isoformat()
    rec = {"id": f"pkr:{msg['id']}", "lat": round(la, 6), "lon": round(lo, 6), "kind": "fishing", "cls": "C",
           "prec": int(prec), "fish": fish, "date": ds, "season": season, "title": title_for(label, fish, ds),
           "comment": comment_for(season, label, fish, depth, methods, catch, text, note, ice),
           "depth": depth, "method": ", ".join(methods), "catch": catch, "src": PKR_SRC,
           "url": f"{PKR_BASE}{msg['id']}", "sid": str(msg["id"]), "place": BY_KEY[key][3]}
    rec.update(area_fields(la, lo))
    rec["ice"] = ice
    rec = compact(rec)
    rec["_text"] = text
    rec["_anchor"] = key
    return rec, "ok"


# ------------------------------------------------------------------------------- fishing reports: Telegram

TG_SOURCES = {  # channel → canonical source name as in site/data/points.json
    "rybalka_spb_lenoblasti": "Telegram: Рыболовная сводка СПб",
    "fisher47region": "Telegram: Рыбалка 47 регион (@fisher47region)",
    "fishingspb1": "Telegram: Отчёты Рыбалка СПб",
    "damfishspb": "Telegram: @damfishspb",
    "gid_rybalka_na_ladoge": "Telegram: Гид по рыболовным местам Ладоги",
    "feeder_spb": "Telegram: Рыбалка на фидер в СПб (@feeder_spb)",
    "lovipokaneustanech": "Telegram: DiKaYa RyBaLkA 47Region (@lovipokaneustanech)",
    "rvfisher47": "Telegram: ОКУНЕННЫЙ ДВИЖ (@rvfisher47)",
    "acclenobl": "Telegram: Аварийно-спасательная служба ЛО (t.me/acclenobl)",
    "novosti_s_vodoemov": "Telegram: Новости с водоемов (ПКР)",  # aggregator: last, deduplicated against the others
}
TG_INCIDENT_CHANNELS = {"acclenobl"}
TG_AGGREGATORS = {"novosti_s_vodoemov"}
NOT_REPORT_TG = re.compile(r"продам|продаю|продаётся|продается|скидк|акци[яи]|тариф|бронир|записыва|свободн\w+\s+мест|есть\s+\d\s+мест|"
                           r"погиб|утонул|провалил|спасател|аварийно|розыгрыш|вакансия|аренд", re.I)
STRONG_CATCH = re.compile(r"поймал|улов|клевал", re.I)
COORD = re.compile(r"(?<![\d.])(5[89]|6[01])[.,](\d{3,8})\s*[,;/ ]\s*(3[0-3])[.,](\d{3,8})(?!\d)")
COORD_LINE = re.compile(r"Координаты\s*([^:\n]{0,40}?)\s*:\s*(-?\d{1,2}[.,]\d{3,})\s*[,;]?\s*(-?\d{1,3}[.,]\d{3,})", re.I)
PARKING_LABEL = re.compile(r"парковк|стоянк|машин|авто(?!р)|слип|спуск", re.I)  # «Координаты парковки: …»
PARKING_CTX = re.compile(r"парковк|стоянк|слип|спуск", re.I)   # tg_extract: 60 characters before a bare pair
# build_points_2026 «canal_far»: the Новоладожский канал by Синявино, about 3 km from the lake, is not our water.
CANAL_FAR = (59.90, 59.915, 31.15, 31.25)
HEADER = re.compile(r"^\s*[\d.]+\s*(?:\d{1,2}:\d{2})?\s*\|\s*([^|]{2,60})\|")
PLACE_LINE = re.compile(r"^\s*(?:🚩|📍|🌊|🏝️?|🏡)\s*(.+)$", re.M)
NEAR_ANCHOR_KM = 10.0   # a published coordinate without a named place must be this close to a known place …
LAKE_RULE = (60.15, 30.95, 32.95)  # … or lie in the open lake: lat ≥ 60.15 and 30.95 ≤ lon ≤ 32.95
MAP_PIN_PREC = 700


def upper_volkhov_coord(la, lo):
    return 32.20 <= lo <= 32.45 and la < 59.99


def coord_ok(la, lo, has_hits):
    if not in_bbox(la, lo) or upper_volkhov_coord(la, lo):
        return False
    if CANAL_FAR[0] <= la <= CANAL_FAR[1] and CANAL_FAR[2] <= lo <= CANAL_FAR[3]:
        return False
    if has_hits:
        return True
    _, km = nearest_anchor(la, lo)
    return km <= NEAR_ANCHOR_KM or (la >= LAKE_RULE[0] and LAKE_RULE[1] <= lo <= LAKE_RULE[2])


def map_point(url):
    """(lat, lon) of a Yandex / Google maps link, or None (parse_common.yandex_point)."""
    u = urllib.parse.unquote((url or "").replace("&amp;", "&"))
    if "yandex" in u:
        for key in ("whatshere[point]=", "pt=", "ll="):
            i = u.find(key)
            if i >= 0:
                m = re.match(r"(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)", u[i + len(key):])
                if m:
                    return float(m.group(2)), float(m.group(1))
    m = re.search(r"google\.[a-z.]+/maps.*?[@?&/](?:q=|ll=|@)?(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})", u)
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.search(r"geo:(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})", u)
    if m:
        return float(m.group(1)), float(m.group(2))
    return None


def place_label(la, lo, hits):
    """Label of a published coordinate: a named place within 15 km, else the nearest anchor within 15 km."""
    for h in hits:
        if h in BY_KEY and hav(la, lo, BY_KEY[h][0], BY_KEY[h][1]) <= 15000:
            return BY_KEY[h][3], h
    k, km = nearest_anchor(la, lo)
    if k and km <= 15:
        return BY_KEY[k][3], k
    return sector_of(la, lo), None


def orig_link(hrefs):
    """The «источник» link of an aggregator post (VK wall post, fisher.spb.ru page, …): used only for deduplication."""
    for h in hrefs or []:
        if re.search(r"vk\.(?:com|ru)/wall-?\d+_\d+|fisher\.spb\.ru/|ok\.ru/|dzen\.ru/", h or ""):
            return h
    return ""


def tg_extract(msg, channel):
    """One Telegram post → (list of records, reason). msg: {"id", "date": date (post), "text", "hrefs", "maps"}."""
    text = msg.get("text") or ""
    src = TG_SOURCES.get(channel, f"Telegram: @{channel}")
    url = f"https://t.me/{channel}/{msg['id']}"
    if not text.strip():
        return [], "empty"
    if channel in TG_AGGREGATORS and any("fisher.spb.ru" in (h or "") for h in msg.get("hrefs") or []):
        return [], "repost_of_pkr"  # the club's own reports come from fisher.spb.ru directly
    if NOT_REPORT_TG.search(text) and not STRONG_CATCH.search(text):
        return [], "not_report"
    if OUTSIDE.search(text) or re.match(r"\s*мосты", text, re.I):
        return [], "outside"
    hits = anchors_in(text)
    hm = HEADER.match(text.replace("\n", " | "))
    header_key = None
    if hm:
        hh = anchors_in(hm.group(1))
        header_key = hh[0] if hh else None
    for pl in PLACE_LINE.findall(text):  # «🚩 Река Волхов, г.Новая Ладога», «📍 д. Кошкино»
        hh = anchors_in(pl)
        if hh:
            header_key = header_key or hh[0]
            break
    # coordinates: «Координаты <что>: lat, lon» lines (their label tells a parking from a place), then bare pairs
    pts = []
    for label, a, b in COORD_LINE.findall(text):
        la, lo = float(a.replace(",", ".")), float(b.replace(",", "."))
        pts.append((la, lo, "launch" if PARKING_LABEL.search(label) else "fishing", 30))
    for m in COORD.finditer(text):
        a, b, c, d = m.groups()
        la, lo = float(f"{a}.{b}"), float(f"{c}.{d}")
        if any(abs(la - p[0]) < 1e-6 and abs(lo - p[1]) < 1e-6 for p in pts):
            continue
        ctx = text[max(0, m.start() - 60):m.start()]
        pts.append((la, lo, "launch" if PARKING_CTX.search(ctx) else "fishing", 30))
    pins = []
    for la, lo in msg.get("maps") or []:
        pins.append((la, lo))
    had_fishing_pt = any(p[2] == "fishing" for p in pts)
    pts = [p for p in pts if coord_ok(p[0], p[1], bool(hits))]
    if had_fishing_pt and not any(p[2] == "fishing" for p in pts):
        return [], "coord_outside"  # the post gives its place, and it is not ours (the canal by Синявино, Вуокса, …)
    pins = [p for p in pins if coord_ok(p[0], p[1], bool(hits))]
    if (EXCLUDE.search(text) or NW_EXCLUDE.search(text)) and not hits and not pts:
        return [], "outside"
    lower = [h for h in hits if h in LOWER_VOLKHOV and h != "novaya_ladoga_river"]
    if re.search(r"волхов", text, re.I) and UPPER_VOLKHOV_TG.search(text) and not pts and not lower:
        return [], "volkhov_not_lower"
    if not hits and not pts and not pins:
        return [], "no_place"
    fish, catch = fish_in(text), catch_in(text)
    coord_post = any(p[2] == "fishing" for p in pts)
    if not (fish or catch) or not (CATCHY_TG.search(text) or catch or (coord_post and fish)):
        return [], "not_catch_report"
    pd = msg["date"]
    d, basis = report_date(text, pd, source="tg")
    ds = d.isoformat()
    methods, depth = methods_in(text), depth_in(text)
    season = season_of(text, d)
    ice = ice_facts(text) if (season == "ice" or d.month in (11, 12, 1, 2, 3, 4)) else None
    base = {"kind": "fishing", "fish": fish, "date": ds, "season": season, "depth": depth,
            "method": ", ".join(methods), "catch": catch, "src": src, "url": url, "sid": str(msg["id"])}
    out = []
    fishing_pts = [p for p in pts if p[2] == "fishing"]
    for i, (la, lo, kind, prec) in enumerate(fishing_pts):
        label, key = place_label(la, lo, ([header_key] if header_key else []) + hits)
        rec = dict(base, id=f"tg:{channel}/{msg['id']}" + (f"#{i + 1}" if i else ""), lat=round(la, 6), lon=round(lo, 6),
                   cls="A", prec=prec, place=label, title=title_for(label, fish, ds),
                   comment=comment_for(season, label, fish, depth, methods, catch, text,
                                       "координаты опубликованы в посте", ice))
        rec.update(area_fields(la, lo))
        rec["ice"] = ice
        out.append(rec)
    if not fishing_pts:
        key = None
        if hits or header_key:
            spec = [h for h in hits if h in SPECIFIC]
            key = header_key or (spec[0] if spec else hits[0])
        if key and not (re.search(r"волхов", text, re.I) and key == "novaya_ladoga_river" and UPPER_VOLKHOV_TG.search(text)):
            la, lo, prec, label, how = BY_KEY[key]
            note = f"место по тексту поста ({how})"
            km = km_offset(key, text, d, bool(ICE.search(text)) or d.month in (12, 1, 2, 3, 4)) if key == "krenitsy" else None
            if km:
                la, lo, prec, note, dsk = km
                label = f"{label}, ~{dsk} км"
            prec = route_prec(key, hits, prec, la, lo)
            if pins:  # the channel's «На карте» pin: the place of the report, approximately
                pla, plo = pins[0]
                if hav(pla, plo, la, lo) <= 15000:
                    la, lo, prec, note = pla, plo, MAP_PIN_PREC, "точка — метка «На карте» из поста (примерно)"
            rec = dict(base, id=f"tg:{channel}/{msg['id']}", lat=round(la, 6), lon=round(lo, 6), cls="C", prec=int(prec),
                       place=BY_KEY[key][3], title=title_for(label, fish, ds),
                       comment=comment_for(season, label, fish, depth, methods, catch, text, note, ice))
            rec.update(area_fields(la, lo))
            rec["ice"] = ice
            out.append(rec)
        elif pins:
            pla, plo = pins[0]
            label, key = place_label(pla, plo, hits)
            rec = dict(base, id=f"tg:{channel}/{msg['id']}", lat=round(pla, 6), lon=round(plo, 6), cls="C",
                       prec=MAP_PIN_PREC, place=label, title=title_for(label, fish, ds),
                       comment=comment_for(season, label, fish, depth, methods, catch, text,
                                           "точка — метка «На карте» из поста (примерно)", ice))
            rec.update(area_fields(pla, plo))
            rec["ice"] = ice
            out.append(rec)
    for i, (la, lo, kind, prec) in enumerate(p for p in pts if p[2] == "launch"):
        label, key = place_label(la, lo, ([header_key] if header_key else []) + hits)
        rec = {"id": f"tg:{channel}/{msg['id']}#p" + (str(i + 1) if i else ""), "lat": round(la, 6), "lon": round(lo, 6),
               "kind": "launch", "cls": "A", "prec": 50, "date": ds, "title": f"Парковка / выход к воде: {label}",
               "comment": f"Парковка рыбаков у места ловли ({label}): координаты опубликованы в отчёте о рыбалке.",
               "src": src, "url": url, "sid": str(msg["id"]), "place": label}
        rec.update(area_fields(la, lo))
        out.append(rec)
    if not out:
        return [], "no_place"
    res = []
    for r in out:
        r = compact(r)
        r["_text"] = text
        res.append(r)
    return res, "ok"


# --------------------------------------------------------------------------------------------- incidents

NEWS47_SRC = "47news.ru"
ICE_CTX = re.compile(r"(?<![а-яё])л[её]д(?![а-яё])|(?<![а-яё])льд|подл[её]дн|снегоход|мотособак|мотобуксир|мотосан|аэролодк|"
                     r"аэробот|воздушн\w+\s+подушк|хивус|полынь|промоин|трещин|зимн\w+\s+рыбалк", re.I)
WATER_CTX = re.compile(r"лодк|лодоч|катер|маломерн|байдар|каяк|(?<![а-яё])сап(?:борд\w*|[аеуы]|ом)?(?![а-яё])|яхт|гидроцикл|моторк|"
                       r"плавсредств|(?<![а-яё])мотор|(?<![а-яё])судн\w*|судов\w*\s+ход|на\s+воде|волн[аыуе]|шторм", re.I)
WATER_BODY = re.compile(r"ладож\w*\s+озер|ладог|(?<![а-яё])озер|(?<![а-яё])рек[аеиу]|канал|губ[аеуы](?![а-яё])|бухт|проток|залив|"
                        r"акватори|волхов|свир|сяс|назия|назии|(?<![а-яё])нев[аеуы](?![а-яё])", re.I)
EVENT = re.compile(r"провалил|провалив(?!ани)|ушл?[аио]?\s+под\s+(?:л[её]д|воду)|ушёл\s+под|оторвал|оторва|отколол|откол|дрейф|унесл|отнесл|"
                   r"вынесл|снесл|эвакуир|спасл|спасен|спасён|спасали|спасают|сняли|снял\w*\s+со\s+льд|вытащ|доставил\w*\s+(?:на\s+берег|к\s+берегу)|"
                   r"вывезл|отбуксир|застрял|заблудил|потерял\w*\s+(?:направлен|ориентир|дорог)|пропал|не\s+(?:мог|смог)\w*\s+(?:вернуться|выбраться|найти|добраться)|"
                   r"утонул|утонувш|погиб|тело\s|тела\s|опрокин|перевернул|заглох|сломал|поломк|без\s+хода|терпящ|бедстви|травм|отрезал|отрезан|"
                   r"оказал\w*\s+на\s+льдин|на\s+(?:оторвавш|отколовш|дрейфующ)\w*\s+льдин|столкнов|пострадал|потерял\w*\s+ход|не\s+вернул|"
                   r"уплыл|потерял(?:ся|ась|ись)|заблуди|найден\w*\s+м[её]ртв|проломил|(?<![а-яё])ищут", re.I)
# Patrols, ice monitoring, warnings and memos: not an incident unless something did happen to somebody.
SOFT_NOT_INCIDENT = re.compile(r"патрулир|мониторинг|рейд|профилакт|предупрежда|напомина|памятк|разъяснительн|смотр\w*\s+готовност|"
                               r"ледовзрывн|подрыв|штраф|заплатил|запрет|прогноз|ледообразован|ледостав|процент\w*\s+льда|"
                               r"ледов\w+\s+обстановк|ледоход", re.I)
STRONG_EVENT = re.compile(r"провалил(?:ся|ась|ись|ось)|ушл?[аио]?\s+под\s+л[её]д|ушёл\s+под|оторвал\w*|оторва\w*\s+льдин|отколол|отколов|"
                          r"унесл|дрейфовал|погиб|утонул|заблудил|перевернул|опрокинул|сломал|заглох|застрял|травм|сняли\s+со\s+льдин|"
                          r"оказал\w*\s+на\s+(?:\S+\s+)?льдин|проломил", re.I)
# Where the rescuers took the people is not where it happened («доставили на берег в посёлок Назия»).
DELIVERY = re.compile(r"доставил|доставлен|транспортир|вывезл|вывезен|отвезл|сопроводил|эвакуирова\w*\s+(?:на\s+берег\s+)?(?:в|к)\s|"
                      r"передал\w*\s+(?:родственник|скор|врач|медик)", re.I)
# A Ladoga incident that names no place but names the rescue unit gets the unit's area, clearly marked as such.
UNIT_AREAS = [
    (re.compile(r"шлиссельбург", re.I), 60.000, 31.300, 15000, "юго-запад озера, район ПСО Шлиссельбург"),
    (re.compile(r"нов\w+\s+ладог", re.I), 60.170, 32.200, 20000, "Волховская губа, район ПСО Новая Ладога"),
]
UNIT_FALLBACK = True
NOT_INCIDENT = re.compile(r"купал|купани|пляж|бассейн|пожар|(?<![а-яё])(?:с|за)?горел[аио]?(?![а-яё])|возгоран|(?<![а-яё])дтп(?![а-яё])|кювет|"
                          r"столкнул\w*\s+с\s+(?:авто|машин|грузов)|"
                          r"(?<![а-яё])суд(?:ом|у|е|ебн\w*|ья|ей)?(?![а-яё])|приговор|осужд|осудят|обвин|уголовн\w+\s+дел|следств|прокуратур|"
                          r"задержан|арестован|похищ|украл|кража|лесн\w+\s+массив|в\s+лесу|грибник|ягод|охотник|медвед|бпла|беспилотник|"
                          r"годовщин|памятн|память|(?<![а-яё])год\s+назад|в\s+прошлом\s+году|лет\s+назад|учени[яй]|тренировк|"
                          r"соревновани|турнир|(?<![а-яё])собак[аиуе]\s+(?:провалил|оказал)|провалил\w*\s+собак|нерп|"
                          r"(?<![а-яё])лос[ьяю](?![а-яё])|животн|наград|(?<![а-яё])вор(?:ы|а|ов)?(?![а-яё])|похитил|"
                          r"ограничил\w*\s+свобод", re.I)
FOREIGN_WATER = re.compile(r"онежск|финск\w*\s+залив|вуокс|приозерск|сортавал|лахденпох|карели|(?<![а-яё])лодейн|подпорож|свирьстро|"
                           r"(?<![а-яё])кириш|волхов[уе]?\s+(?:выше|у\s+моста)|в\s+(?:городе\s+|г\.\s*)?волхове|отрадн|кировске|"
                           r"невск\w+\s+дубровк|черте\s+города|петербург\w*\s+(?:на\s+)?(?:нев|канал|рек)|тихвин|тосн|луг[аеи](?![а-яё])|"
                           r"выборг|копорск|сосновый\s+бор|комсомольск\w+\s+озер|сертолов|токсов|кавголов|агалатов|колтуш|карьер|"
                           r"ладожск\w+\s+мост|рек\w*\s+паш|р\.\s*паш|сланц|гатчин|кингисепп|лужск|волосов|ломоносов|киришск|тихвинск|"
                           r"подпорожск|лодейнопольск|малукс", re.I)
# tg_extract.OUTSIDE without «лахта»: 47news and the rescuers mean the village Лахта of the Волховский район.
OUTSIDE_INC = re.compile(r"финск\w*\s+залив|сбфз|горская|сестрорецк|кронштадт|южн\w+\s+дамб|вуокс|суходольск|"
                         r"карельск\w+\s+перешеек|онежск\w*\s+озер|морск\w+\s+канал", re.I)
# «рыбаки из Тихвина», «житель Всеволожска»: where people come from is not where it happened.
HOMETOWN = re.compile(r"(?:(?<![а-яёА-ЯЁ])[Ии]з|[Жж]ител\w+|[Уу]роженц\w+)\s+(?:г\.\s*|города\s+|посёлка\s+|поселка\s+)?[А-ЯЁ][а-яё]+")
LEADING_OLD = re.compile(r"^\s*(?:как\s+(?:ранее\s+)?(?:писал|сообщал|рассказывал)\w*|напомним|ранее\s+47news|ранее\s+в\s+|ранее,?\s)", re.I)
ICE_TYPES = [
    ("detach", re.compile(r"оторвал\w*\s+(?:от\s+берега\s+)?льдин|оторва\w*\s+льдин|отколов\w*\s+льдин|откол\w*\s+льдин|"
                          r"льдин\w*\s+(?:с\s+\S+\s+)?(?:оторв|откол|унес|отнес|вынес|дрейф)|дрейфующ\w+\s+льдин|на\s+льдин|со\s+льдин|"
                          r"с\s+(?:оторвавш|отколовш|треснувш|дрейфующ)\w*\s+льдин|льдину\s+(?:с\s+\S+\s+)?(?:оторвал|унесл|отнесл)|отрыв\w*\s+льд", re.I)),
    ("fall", re.compile(r"провалил|провалив(?!ани)|ушл?[аио]?\s+под\s+(?:л[её]д|воду)|ушёл\s+под|в\s+полынью|под\s+л[её]д|проломил", re.I)),
    ("crack", re.compile(r"трещин|треснул", re.I)),
    ("polynya", re.compile(r"промоин|полынь|отрезал\w*\s+(?:\S+\s+){0,3}(?:открыт\w+\s+)?вод|открыт\w+\s+вод", re.I)),
    ("breakdown", re.compile(r"поломк|сломал\w*\s+(?:\S+\s+)?(?:снегоход|мотособак|мотобуксир|техник|мотор|транспорт)|заглох|"
                             r"вышл?\w*\s+из\s+строя|кончил\w*\s+(?:топлив|бензин)", re.I)),
    ("lost", re.compile(r"заблуди|потерял\w*\s+(?:направлен|ориентир|дорог)|не\s+(?:мог|смог)\w*\s+(?:найти|вернуться|добраться)|"
                        r"сбил\w*\s+с\s+пути|пропал|потерял(?:ся|ась|ись)|потерявш", re.I)),
    ("injury", re.compile(r"травм|сломал\w*\s+(?:ногу|руку)|перелом|плохо\s+стал|стало\s+плохо|приступ|обморож|переохлажд|инсульт|инфаркт", re.I)),
]
WATER_TYPES = [
    ("capsize", re.compile(r"опрокин|перевернул", re.I)),
    ("drift", re.compile(r"дрейф|унесл|отнесл|снесл|вынесл|не\s+(?:мог|смог|удавал)\w*\s+(?:повернуть|вернуться|выгрести|пристать)", re.I)),
    ("breakdown", re.compile(r"заглох|поломк|сломал|без\s+хода|вышл?\w*\s+из\s+строя|кончил\w*\s+(?:топлив|бензин)|повредил\w*\s+(?:винт|корпус)|"
                             r"пробил|тонущ|течь|затонул", re.I)),
    ("lost", re.compile(r"пропал|заблудил|не\s+(?:мог|смог)\w*\s+найти|потерял\w*\s+(?:направлен|ориентир|дорог)", re.I)),
    ("injury", re.compile(r"травм|перелом|плохо\s+стал|стало\s+плохо|приступ|переохлажд|инсульт|инфаркт", re.I)),
]
TYPE_TITLE = {
    ("ice", "detach"): "отрыв льдины", ("ice", "fall"): "провал под лёд", ("ice", "crack"): "трещина во льду",
    ("ice", "polynya"): "промоины у берега", ("ice", "breakdown"): "поломка техники на льду",
    ("ice", "lost"): "заблудились на льду", ("ice", "injury"): "травма на льду", ("ice", "other"): "происшествие на льду",
    ("water", "capsize"): "опрокидывание лодки", ("water", "drift"): "лодку унесло", ("water", "breakdown"): "лодка без хода",
    ("water", "lost"): "пропали на воде", ("water", "injury"): "травма на воде", ("water", "other"): "происшествие на воде",
}
TYPE_SENTENCE = {
    ("ice", "detach"): "Оторвало льдину с людьми", ("ice", "fall"): "Провал под лёд",
    ("ice", "crack"): "Трещина во льду отрезала людей от берега", ("ice", "polynya"): "Промоины отрезали людей от берега",
    ("ice", "breakdown"): "Поломка техники на льду", ("ice", "lost"): "Люди заблудились на льду",
    ("ice", "injury"): "Травма или недомогание на льду", ("ice", "other"): "Происшествие на льду",
    ("water", "capsize"): "Опрокинулась лодка", ("water", "drift"): "Лодку с людьми унесло или не могли вернуться к берегу",
    ("water", "breakdown"): "Лодка потеряла ход", ("water", "lost"): "Пропали или потерялись на воде",
    ("water", "injury"): "Травма или недомогание на воде", ("water", "other"): "Происшествие на воде",
}
NUM_WORDS = {"один": 1, "одного": 1, "одна": 1, "одну": 1, "двое": 2, "двоих": 2, "двух": 2, "два": 2, "две": 2, "пара": 2, "пару": 2,
             "трое": 3, "троих": 3, "трёх": 3, "трех": 3, "три": 3, "троица": 3, "троицу": 3, "трио": 3,
             "четверо": 4, "четверых": 4, "четырёх": 4, "четырех": 4, "четыре": 4, "квартет": 4,
             "пятеро": 5, "пятерых": 5, "пяти": 5, "пять": 5, "шестеро": 6, "шестерых": 6, "шести": 6, "шесть": 6,
             "семеро": 7, "семерых": 7, "семи": 7, "семь": 7, "восемь": 8, "восьмерых": 8, "восьми": 8,
             "девять": 9, "девяти": 9, "десять": 10, "десяти": 10, "десятерых": 10}
COLLECTIVE = {"двое", "трое", "четверо", "пятеро", "шестеро", "семеро", "квартет", "троица", "троицу", "трио"}
PEOPLE_NOUN = (r"(?:человек\w*|чел\.|люд(?:ей|и|ям)|рыбак\w*|рыболов\w*|мужчин\w*|любител\w*|пострадавш\w*|подрост\w*|женщин\w*|"
               r"пассажир\w*|турист\w*|отдыхающ\w*|дет(?:ей|и)|ребен\w*|ребён\w*|друз\w+|товарищ\w*|жител\w*|пенсионер\w*)")
PEOPLE_RE = re.compile(r"(?<![\w-])(\d{1,3}|" + "|".join(sorted(NUM_WORDS, key=len, reverse=True)) + r")(?:-?х)?\s+"
                       r"(?:[а-яё-]+\s+){0,2}?" + PEOPLE_NOUN, re.I)
COLLECTIVE_RE = re.compile(r"(?<![а-яё])(" + "|".join(sorted(COLLECTIVE, key=len, reverse=True)) + r")(?![а-яё])", re.I)
SINGLE_RE = re.compile(r"(?<![а-яё])(?:мужчин[аеуы]?|рыбак[ау]?|рыболов[ау]?|женщин[аеуы]|пенсионер[ау]?|подрост[о]?к[ау]?|"
                       r"снегоходчик[ау]?|водител[ья]|лодочник[ау]?)(?![а-яё])", re.I)
DIED = re.compile(r"(?<![а-яё])(?:погиб(?:л[иао]|ш\w+)?(?![а-яё])|утонул\w*|утонувш|тело\s|тела\s|скончал|умер(?:л[иа])?(?![а-яё])|"
                  r"не\s+спасли|не\s+удалось\s+спасти|без\s+признаков\s+жизни|найден\w*\s+м[её]ртв)", re.I)
# The rescue unit's home town is not the place of the incident («ПСО г. Шлиссельбург», «спасатели Новой Ладоги»).
UNIT_TOWN = re.compile(r"(?:(?:поисково|пожарно|аварийно)-спасательн\w+\s+(?:отряд|подразделени|служб|част|станци)\w*|(?<![а-яё])(?:псо|псч|пч)(?![а-яё])|"
                       r"(?<![а-яё])отряд\w*|спасател\w*|спасательн\w+\s+станци\w*|дежурн\w+\s+смен\w*)"
                       r"(?:\s+(?:из|№\s*\d+|г\.|гор\.|города|пос\.|пгт|поисково-спасательного|отряда))*\s*[«\"]?"
                       r"(?:Шлиссельбург\w*|Нов\w+\s+Ладог\w*|Волхов\w*|Приозерск\w*|Кировск\w*|Лодейно\w*\s+Пол\w*|Тосно|Сясьстро\w*)[»\"]?"
                       r"(?:\s+и\s+(?:г\.\s*)?(?:Шлиссельбург\w*|Нов\w+\s+Ладог\w*|Волхов\w*|Приозерск\w*|Кировск\w*))?", re.I)
# Generic phrases of the fishing gazetteer that do not name a place in a news text.
INCIDENT_SKIP_ANCHORS = {"yacht", "vch", "kurgany"}
SAVED = re.compile(r"(?<![а-яё])(?:спасл|спасен|спасён|эвакуир|доставил\w*\s+(?:\S+\s+){0,2}?(?:на\s+берег|к\s+берегу|к\s+месту|в\s|до\s)|"
                   r"доставлен|сняли|снял\w*\s+со|вытащ|вывезл|отбуксир|вернули|сопроводил|проводил\w*\s+(?:\S+\s+)?(?:к|до)\s|"
                   r"помогли\s+(?:\S+\s+)?(?:добраться|выбраться|вернуться)|обнаружили\s+(?:\S+\s+){0,2}?и\s+(?:доставил|эвакуир|вывезл))", re.I)
SELF = re.compile(r"выбрал\w*\s+(?:из\s+воды\s+)?(?:сам|самостоятельно)|самостоятельно\s+(?:выбрал|добрал|вышл|вернул)|сам\w*\s+добрал", re.I)
SEARCH = re.compile(r"(?<![а-яё])ищут|поиски\s+(?:продолж|пропавш|ведутся|идут|мужчин|рыбак)|продолжа\w+\s+поиск|пропал\w*\s+без\s+вести|"
                    r"не\s+(?:найден|обнаружен)", re.I)
CANAL = re.compile(r"канал", re.I)


NOT_PEOPLE_NUM = re.compile(r"(?<!\d)\d{1,2}\s+" + MONTH_RE + r"|\d+(?:[.,]\d+)?\s*(?:км|м|метр\w*|см|кг|лет|год\w*|час\w*|мин\w*|%|"
                            r"сут\w*|раз\w*|единиц\w*|кв\.?)(?![а-яё])|\d{1,2}[.:]\d{2}", re.I)


def people_count(text):
    t = NOT_PEOPLE_NUM.sub(" ", text or "")
    m = PEOPLE_RE.search(t)
    if m:
        w = m.group(1).lower()
        n = int(w) if w.isdigit() else NUM_WORDS.get(w)
        if n and 1 <= n <= 500:
            return n
    m = COLLECTIVE_RE.search(t)
    if m:
        return NUM_WORDS.get(m.group(1).lower())
    if SINGLE_RE.search(t) and not re.search(r"рыбак(?:и|ов|ам)|мужчин(?:ы|ам)?(?=\s)|людей|люди|человек", t, re.I):
        return 1
    return None


def outcome_of(text, people):
    one = people == 1
    if DIED.search(text):
        return "погиб" if one else "есть погибшие"
    if SELF.search(text):
        return "выбрался сам" if one else "выбрались сами"
    if SAVED.search(text):
        return "спасён" if one else "спасены"
    if SEARCH.search(text):
        return "идут поиски"
    return ""


def incident_kind(text, when):
    """ice / water by the words and the month (ice from November to May, open water from April to December)."""
    ice_w = bool(ICE_CTX.search(text))
    water_w = bool(WATER_CTX.search(text))
    ice_months = when.month in (11, 12, 1, 2, 3, 4, 5)
    if ice_w and ice_months and not (water_w and re.search(r"опрокин|перевернул|лодк\w*\s+(?:унесл|отнесл|заглох)", text, re.I)
                                      and when.month not in (12, 1, 2, 3)):
        return "ice"
    if water_w and when.month in (4, 5, 6, 7, 8, 9, 10, 11, 12):
        return "water"
    if ice_w and ice_months:
        return "ice"
    return None


def incident_type(kind, text):
    for name, rx in (ICE_TYPES if kind == "ice" else WATER_TYPES):
        if rx.search(text):
            return name
    return "other"


def lead_paragraphs(paras, limit=6):
    """The paragraphs about this event: «Как ранее писал 47news…» / «Напомним…» paragraphs are left out."""
    out = [p for p in paras if p and not LEADING_OLD.search(p)]
    return out[:limit]


AREA_HINT = re.compile(r"ладог|ладожск(?!\w*\s+мост)|волхов|свир|сяс|назия|назии|новоладожск|староладожск|шлиссельбург|"
                       r"кировск\w+\s+район|волховск\w+\s+район|всеволожск\w+\s+район", re.I)
SIGNAL = re.compile(ICE_CTX.pattern + "|" + WATER_CTX.pattern + r"|рыбак|рыболов|спасател|мчс|утонул|утопа|пропал|тело", re.I)
RECHECK_REASONS = ("no_water", "no_event", "no_kind", "no_place", "not_ours")


def news_candidate(title, summary):
    """A news item worth a look at its article: our water or area is named and something happened on water or ice."""
    t = f"{title or ''} {summary or ''}"
    if NOT_INCIDENT.search(t) or FOREIGN_WATER.search(t):
        return False
    area = AREA_HINT.search(t) or [h for h in anchors_in(t, km7=False) if h not in INCIDENT_SKIP_ANCHORS]
    return bool(area) and bool(SIGNAL.search(t))


def incident_extract(title, text, published, src, url, rid, sid):
    """An incident report (47news item or article, the rescuers' post) → (record or None, reason).
    published: date of the publication (the incident date unless the text says «вчера»)."""
    full = f"{title or ''}\n{text or ''}".strip()
    if not full:
        return None, "empty"
    if NOT_INCIDENT.search(full):
        return None, "not_incident"
    if SOFT_NOT_INCIDENT.search(full) and not STRONG_EVENT.search(full):
        return None, "not_incident"  # a patrol, a warning, a memo
    if not WATER_BODY.search(full) and not ICE_CTX.search(full):
        return None, "no_water"
    if not EVENT.search(full):
        return None, "no_event"
    kind = incident_kind(full, published)
    if not kind:
        return None, "no_kind"
    placed = UNIT_TOWN.sub(" ", full)  # «ПСО г. Шлиссельбург» is who helped, not where
    where_from = HOMETOWN.sub(" ", placed)
    if FOREIGN_WATER.search(where_from) or OUTSIDE_INC.search(where_from):
        return None, "outside"
    sentences = re.split(r"(?<=[.!?])\s+|\n+", placed)
    main = " ".join(s for s in sentences if not DELIVERY.search(s))
    hits = [h for h in anchors_in(main, km7=False) if h not in INCIDENT_SKIP_ANCHORS]
    if not hits:  # only the sentence about where they were taken names a place: better than nothing
        hits = [h for h in anchors_in(placed, km7=False) if h not in INCIDENT_SKIP_ANCHORS]
    typ = incident_type(kind, full)
    people = people_count(full)
    outcome = outcome_of(full, people)
    d = published - dt.timedelta(days=1) if YESTERDAY.search(full[:400]) else published
    area_note = ""
    if not hits:
        if not re.search(r"ладог|ладожск", placed, re.I):
            return None, "not_ours"
        area = None
        if UNIT_FALLBACK:
            for um in UNIT_TOWN.finditer(full):
                area = next((a for a in UNIT_AREAS if a[0].search(um.group(0))), None)
                if area:
                    break
        if not area:
            return None, "no_place"  # on Lake Ladoga, but where: not placed (see the log)
        _, la, lo, prec, label = area
        where, area_note = "Ладога, место не указано", f"точка условная: {label}"
    else:
        if (EXCLUDE.search(placed) or NW_EXCLUDE.search(placed)) and not [h for h in hits if h != "novaya_ladoga_river"]:
            return None, "outside"
        spec = [h for h in hits if h in SPECIFIC]
        key = spec[0] if spec else hits[0]
        if key == "novaya_ladoga_river" and re.search(r"волхов", placed, re.I) and UPPER_VOLKHOV_TG.search(placed):
            return None, "volkhov_not_lower"
        la, lo, prec, label, how = BY_KEY[key]
        where = label + (" (канал)" if CANAL.search(full) and kind == "ice" and typ == "fall" else "")
    title_out = f"{where}: {TYPE_TITLE[(kind, typ)]}" + (f", {people} чел." if people else "")
    bits = [f"{TYPE_SENTENCE[(kind, typ)]} — {where}"]
    if people:
        bits.append(f"{people} чел.")
    if outcome:
        bits.append(outcome)
    if area_note:
        bits.append(area_note)
    comment = "; ".join(bits) + "."
    rec = {"id": rid, "lat": round(la, 6), "lon": round(lo, 6), "kind": f"{kind}_incident", "type": typ, "people": people,
           "cls": "C", "prec": int(max(prec, 1500)), "date": d.isoformat(), "title": title_out, "comment": comment,
           "place": label, "src": src, "url": url, "sid": sid}
    rec.update(area_fields(la, lo))
    return compact(rec), "ok"


# ------------------------------------------------------------------------------------------------- parsers

_WS = re.compile(r"[ \t\r\f\v  -​  　]+")


def norm_ws(s):
    return _WS.sub(" ", s or "").strip()


def html_text(h):
    """Tags out, <br> and </p> to new lines, entities unescaped, spaces collapsed (lines kept)."""
    h = re.sub(r"<br\s*/?>|</p>|</div>", "\n", h or "", flags=re.I)
    h = re.sub(r'<i class="emoji"[^>]*><b>(.*?)</b></i>', r"\1", h)
    h = re.sub(r"<[^>]+>", " ", h)
    h = htmlmod.unescape(h)
    lines = [norm_ws(x) for x in h.split("\n")]
    out, blank = [], False
    for x in lines:
        if x:
            out.append(x)
            blank = False
        elif not blank and out:
            out.append("")
            blank = True
    return "\n".join(out).strip()


def decode(body):
    """fisher.spb.ru cuts long texts inside a UTF-8 character: decode with replacement."""
    if isinstance(body, str):
        return body
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        return body.decode("utf-8", "replace")


PKR_TOTAL = re.compile(r"Всего сообщений:(?:&nbsp;?|\s)*<b>(\d+)</b>")


def parse_pkr_page(page):
    """A fisher.spb.ru «Новости с водоемов» catalog page → {"total": int|None, "messages": [...]}, newest first.
    Each message: id, place (catalog place), date (date), time ("HH:MM"), text. The author is not read."""
    page = decode(page)
    m = PKR_TOTAL.search(page)
    out = []
    blocks = re.split(r'<div class="news-message" id="pp(\d+)">', page)
    for i in range(1, len(blocks), 2):
        b = blocks[i + 1]
        loc = re.search(r'news-message-location"><strong>(.*?)</strong>', b, re.S)
        date = re.search(r'news-message-date">\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*(\d{1,2}:\d{2})?', b, re.S)
        text = re.search(r'news-message-text clearfix">(.*?)</div>', b, re.S)
        d = mkdate(date.group(3), date.group(2), date.group(1)) if date else None
        if not d:
            continue
        out.append({"id": int(blocks[i]), "place": html_text(loc.group(1)) if loc else "", "date": d,
                    "time": date.group(4) or "", "text": html_text(text.group(1)) if text else ""})
    return {"total": int(m.group(1)) if m else None, "messages": out}


def parse_tg_page(page, channel):
    """A public t.me/s/<channel> page → messages (oldest first as on the page): id, datetime, date (Moscow), text,
    hrefs (links inside the text), maps (map points of the post). Author signatures are not read separately."""
    page = decode(page)
    msgs = []
    for c in page.split('<div class="tgme_widget_message_wrap')[1:]:
        m = re.search(r'data-post="([^"/]+)/(\d+)"', c)
        if not m or m.group(1).lower() != channel.lower():
            continue
        pid = int(m.group(2))
        tm = re.search(r'<time datetime="([^"]+)"', c)
        when = None
        if tm:
            try:
                when = dt.datetime.fromisoformat(tm.group(1).replace("Z", "+00:00")).astimezone(MSK)
            except ValueError:
                when = None
        text_html = ""
        i = c.find('class="tgme_widget_message_text js-message_text"')
        if i >= 0:
            ends = [c.find(k, i) for k in ("tgme_widget_message_reactions", "tgme_widget_message_footer",
                                           'class="tgme_widget_message_info')]
            ends = [e for e in ends if e >= 0] or [len(c)]
            text_html = c[i:min(ends)]
            text_html = text_html[text_html.find(">") + 1:]
            text_html = re.sub(r"<[^>]*$", "", text_html)
        hrefs = [htmlmod.unescape(x) for x in re.findall(r'href="([^"]+)"', text_html)]
        maps = []
        for h in [htmlmod.unescape(x) for x in re.findall(r'href="([^"]+)"', c)]:
            if re.search(r"yandex\.[a-z]+/maps|google\.[a-z.]+/maps|maps\.google|geo:", h):
                p = map_point(h)
                if p and p not in maps:
                    maps.append(p)
        msgs.append({"id": pid, "datetime": when, "date": when.date() if when else None, "text": html_text(text_html),
                     "hrefs": hrefs, "maps": maps})
    return msgs


def tg_older_link(page):
    """The «before» id of the older-messages link, or None."""
    m = re.search(r'data-before="(\d+)"', decode(page))
    return int(m.group(1)) if m else None


def rss_items(xml_bytes):
    """RSS 2.0 → [{"id", "title", "url", "published" (aware datetime|None), "summary"}]. DOCTYPE/ENTITY refused."""
    if isinstance(xml_bytes, str):
        xml_bytes = xml_bytes.encode("utf-8")
    if b"<!DOCTYPE" in xml_bytes[:2000] or b"<!ENTITY" in xml_bytes:
        raise ValueError("RSS with DOCTYPE/ENTITY refused")
    root = ET.fromstring(xml_bytes)
    items = []
    for it in root.iter("item"):
        link = norm_ws(it.findtext("link") or it.findtext("guid") or "")
        pub = it.findtext("pubDate")
        try:
            published = email.utils.parsedate_to_datetime(pub).astimezone(MSK) if pub else None
        except (TypeError, ValueError, IndexError):
            published = None
        m = re.search(r"/(\d+)/?(?:[?#].*)?$", link)
        items.append({"id": m.group(1) if m else hashlib.sha1(link.encode()).hexdigest()[:12],
                      "title": " ".join(htmlmod.unescape(it.findtext("title") or "").split()), "url": link,
                      "published": published, "summary": " ".join(html_text(it.findtext("description") or "").split())})
    return items


def parse_47news_article(page):
    """47news.ru article page → {"title", "published" (datetime|None), "paras": [...]}; None when truncated."""
    page = decode(page)
    i = page.find('class="article-full"')
    if i < 0:
        return None
    j = page.find('class="article-text"', i)
    k = page.find("</div>", j) if j >= 0 else -1
    if j < 0 or k < 0:
        return None
    body = page[j:k]
    paras = [html_text(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", body, re.S)]
    paras = [norm_ws(p) for p in paras if p and p.strip()]
    title = re.search(r"<h1[^>]*>(.*?)</h1>", page[i:], re.S)
    pub = re.search(r'"datePublished"\s*:\s*"([^"]+)"', page[i:j])
    published = None
    if pub:
        try:
            published = dt.datetime.fromisoformat(pub.group(1)).astimezone(MSK)
        except ValueError:
            published = None
    return {"title": html_text(title.group(1)) if title else "", "published": published, "paras": paras}


CDATA = re.compile(r"<!\[CDATA\[(.*?)\]\]>", re.S)


def uncdata(s):
    return CDATA.sub(lambda m: m.group(1), s or "")


def extract_notice_items(page, item_rx, base=""):
    """Items of an official page by the target's regex (named groups url, title, optional date / summary)."""
    rx = re.compile(item_rx, re.S | re.I)
    out, seen = [], set()
    for m in rx.finditer(decode(page)):
        g = {k: uncdata(v) for k, v in m.groupdict().items()}
        url = htmlmod.unescape((g.get("url") or "").strip())
        title = " ".join(html_text(g.get("title") or "").split())
        if not url or not title:
            continue
        url = urllib.parse.urljoin(base, url) if base else url
        if url in seen:
            continue
        seen.add(url)
        out.append({"url": url, "title": title, "date_raw": norm_ws(html_text(g.get("date") or "")),
                    "summary": norm_ws(html_text(g.get("summary") or ""))})
    return out


# ------------------------------------------------------------------------------------------------- dedupe

def norm_url(u):
    """Comparable form of a link: no scheme, no «www.», no «/s/» of t.me previews, no «?single», lower case."""
    u = (u or "").strip().lower()
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    u = re.sub(r"^t\.me/s/", "t.me/", u)
    u = re.sub(r"^(?:m\.)?vk\.(?:com|ru)/", "vk.com/", u)
    u = re.sub(r"\?(?:single|embed=1)$", "", u)
    return u.rstrip("/")


def word_hashes(text):
    """Words of four letters or more as short hashes: enough to recognise a repost. Only words written in lower case
    are kept, so names (capitalised) never enter the index even as hashes: the GitHub copy's state is public, and a
    hash of a single word can be looked up in a dictionary. Latin nicknames and numbers are never indexed."""
    ws = {m.group(0).lower() for m in re.finditer(r"(?<![А-Яа-яЁё])[а-яё][а-яё]{3,}(?![А-Яа-яЁё])", text or "")}
    return sorted({hashlib.md5(w.encode("utf-8")).hexdigest()[:8] for w in ws})


class TextIndex:
    """build_points_2026.TextIndex over hashed words, with a date window (reposts of the same report)."""

    MIN_WORDS = 6

    def __init__(self, entries=None):
        self.docs, self.inv = [], {}
        for e in entries or []:
            self._add(e.get("k"), e.get("d"), e.get("w") or [])

    def _add(self, key, date, ws):
        ws = set(ws)
        if len(ws) < self.MIN_WORDS:
            return
        i = len(self.docs)
        self.docs.append((key, date, ws))
        for w in ws:
            self.inv.setdefault(w, []).append(i)

    def add(self, key, date, text):
        self._add(key, date, word_hashes(text))

    def best(self, text, date=None, days=3, exclude_key=None):
        ws = set(word_hashes(text))
        if len(ws) < self.MIN_WORDS:
            return 0.0, None
        cnt = {}
        for w in ws:
            for i in self.inv.get(w, ()):
                cnt[i] = cnt.get(i, 0) + 1
        best, bk = 0.0, None
        for i, c in cnt.items():
            k, d, dws = self.docs[i]
            if k == exclude_key:
                continue
            if date and d and abs((dt.date.fromisoformat(d) - dt.date.fromisoformat(date)).days) > days:
                continue
            sim = c / min(len(ws), len(dws))
            if sim > best:
                best, bk = sim, k
        return best, bk

    def entries(self, since=None):
        return [{"k": k, "d": d, "w": sorted(ws)} for k, d, ws in self.docs if not since or (d or "") >= since]
