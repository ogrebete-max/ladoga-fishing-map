#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Offline tests of fetch_live.py parsers and pipeline on saved fixtures (no network):

    cd scripts/live && python -m unittest -v test_fetch_live
"""
import datetime as dt
import gzip
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fetch_live as fl  # noqa: E402

FIX = os.path.join(HERE, "fixtures")
MSK = fl.MSK


def fx_bytes(name):
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


def fx_text(name, enc="utf-8"):
    return fx_bytes(name).decode(enc)


def at(y, mo, d, h=0, mi=0):
    return dt.datetime(y, mo, d, h, mi, tzinfo=MSK)


def post(table, name):
    return next(p for p in table["posts"] if p["post"] == name)


def place(review, pid):
    return next(p for p in review["places"] if p["id"] == pid)


def ims_stream(date_key):
    """A gzip IMS 4-km file rebuilt from the saved real rows (all other rows are zeros)."""
    data = json.loads(fx_text("ims_rows.json"))
    rows, c0 = data["files"][date_key], data["c0"]
    last = max(int(r) for r in rows)
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=1) as gz:
        gz.write(b"Julian day of IMS data log: test\nFormat: I1\nDimensions: 6144 x 6144\n")
        zero = b"0" * fl.IMS_N + b"\n"
        for n in range(last + 5):
            w = rows.get(str(n))
            if w is None:
                gz.write(zero)
            else:
                gz.write((b"0" * c0 + w.encode() + b"0" * (fl.IMS_N - c0 - len(w))) + b"\n")
    return buf.getvalue()


class TextHelpers(unittest.TestCase):
    def test_html_to_lines_cells_and_entities(self):
        lines = fl.html_to_lines("<p>А&nbsp;б</p><br><table><tr><td> 1 </td><td>2</td></tr></table><script>x</script>")
        self.assertEqual(lines, ["А б", "1", "2"])

    def test_sentences_keep_abbreviations(self):
        s = fl.split_sentences("Толщина 32-37 см. В районе м. Стороженский толщина льда 41-46 см. Уровень р. Нева – ст. "
                               "Петрокрепость – 328 см БС.")
        self.assertEqual(len(s), 3)
        self.assertTrue(s[1].startswith("В районе м. Стороженский"))
        self.assertTrue(s[2].startswith("Уровень р. Нева – ст. Петрокрепость"))

    def test_trim(self):
        self.assertEqual(fl.trim("  a  b ", 10), "a b")
        t = fl.trim("слово " * 50, 40)
        self.assertLessEqual(len(t), 40)
        self.assertTrue(t.endswith("…"))


class WinterForecast(unittest.TestCase):
    """Forecast on 14.03.2026: table of posts, ice review on Ladoga, storm forecast (research sample)."""

    @classmethod
    def setUpClass(cls):
        cls.html = fx_text("mchs_forecast_20260314.html")
        cls.lines = fl.html_to_lines(fl.extract_article(cls.html))
        cls.f = fl.parse_forecast(cls.lines, 2026)

    def test_page_meta_and_completeness(self):
        meta = fl.parse_page_meta(self.html)
        self.assertEqual(meta["title"], "Оперативный ежедневный прогноз ЧС на 14 марта 2026 года")
        self.assertEqual(meta["published"], at(2026, 3, 13, 13, 36))
        self.assertEqual(fl.forecast_target_date(meta["title"]), dt.date(2026, 3, 14))
        self.assertTrue(fl.forecast_complete(self.lines))
        self.assertTrue(fl.page_complete(self.html.encode()))

    def test_truncated_page_is_detected(self):
        # the 23.02.2026 page broke off at 15 KB twice
        self.assertIsNone(fl.extract_article(self.html[:6000]))
        self.assertFalse(fl.page_complete(self.html[:6000].encode()))
        cut = next(i for i, ln in enumerate(self.lines) if ln.startswith("ОБЗОР ЛЕДОВОЙ"))
        self.assertFalse(fl.forecast_complete(self.lines[:cut + 3]))

    def test_level_table(self):
        start = next(i for i, ln in enumerate(self.lines) if fl.TABLE_RE.search(ln))
        full = fl.parse_level_table(fl._cut_block(self.lines, start))
        self.assertEqual(len(full["posts"]), 23)  # «имеются 23 стационарных гидрометеорологических поста»
        kin = post(full, "Луга-Кингисепп")
        self.assertEqual((kin["zero_m_bs"], kin["level_cm"], kin["change_cm"]), (-0.06, 154, 10))
        self.assertTrue(kin["est"])  # «154*», «10*»
        t = self.f["table"]  # in live.json: the Ladoga basin only (no Луга, Оредеж, Нарва, Тосна)
        self.assertEqual(t["time"], "2026-03-12T08:00:00+03:00")
        self.assertEqual(len(t["posts"]), 16)
        self.assertFalse([p for p in t["posts"] if re.match(r"Луга|Оредеж|Нарва|Тосна", p["post"])])
        nev = post(t, "Нева-Петрокрепость")
        self.assertEqual((nev["zero_m_bs"], nev["level_cm"], nev["change_cm"], nev["norm_cm"]), (0, 398, 3, 434))
        self.assertEqual(nev["ice"], "разводья")
        self.assertTrue(nev["lake"])
        self.assertNotIn("unfav_cm", nev)
        svir = post(t, "Н.Л.К.-Свирица")
        self.assertEqual((svir["level_cm"], svir["change_cm"], svir["norm_cm"], svir["unfav_cm"], svir["danger_cm"]),
                         (431, 1, 480, 570, 600))
        self.assertNotIn("ice", svir)  # «Нет св» = no data
        syas = post(t, "С.Л.К.-Сясьские Рядки")
        self.assertEqual((syas["level_cm"], syas["change_cm"], syas["norm_cm"]), (414, -2, 463))
        self.assertEqual(post(t, "Дымка-Домачево")["ice"], "вода на льду;ледяной покров с полыньями 2 бал.")
        self.assertEqual(post(t, "Пчевжа- Белая")["level_cm"], 153)

    def test_ice_review(self):
        r = self.f["ice_review"]
        self.assertEqual(r["obs_date"], "2026-03-12")
        self.assertEqual(r["sat_date"], "2026-03-11")
        self.assertEqual(r["cover_pct"], 70)
        self.assertIn("Дрейф льда от слабого до умеренного", r["forecast"])
        self.assertTrue(r["forecast"].startswith("Прогноз до 16 марта 2026 года"))
        self.assertIn("Толщина льда в районе Осиновецкого маяка 40-45 см", r["text"])
        cm = {p["id"]: [(v["min"], v["max"]) for v in p.get("cm", [])] for p in r["places"]}
        self.assertEqual(cm["osinovets"], [(40, 45)])
        self.assertEqual(cm["kobona"], [(32, 37)])
        self.assertEqual(cm["syasskie_ryadki"], [(43, 48)])
        self.assertEqual(cm["storozhno"], [(41, 46), (31, 36)])
        self.assertEqual(cm["svir_bay"], [])  # «на льду вода до 10 см» is not ice thickness
        self.assertEqual(cm["torpakovka"], [])
        self.assertEqual(cm["volkhov_bay"], [])
        sto = place(r, "storozhno")
        self.assertEqual([v.get("at") for v in sto["cm"]], ["100 м от берега", "500 м от берега"])
        self.assertEqual(sto["label"], "41–46 / 31–36 см")
        self.assertIn("лед местами торосистый", sto["text"])
        self.assertIn("промоины", place(r, "torpakovka")["text"])
        self.assertEqual(place(r, "kobona")["label"], "32–37 см")
        self.assertAlmostEqual(place(r, "kobona")["lat"], 60.035)
        self.assertTrue(place(r, "petrokrepost_bay")["text"].startswith("В бухте Петрокрепость, в районе истока р. Нева"))
        self.assertLessEqual(max(len(p["text"]) for p in r["places"]), 220)
        for p in r["places"]:
            self.assertTrue(59.8 < p["lat"] < 60.8 and 30.9 < p["lon"] < 33.0, p)

    def test_storm_forecast(self):
        s = self.f["storm"]
        self.assertEqual(s["valid"], "от 21:00 13 марта 2026 г. до 21:00 14 марта 2026 г.")
        self.assertTrue(s["text"].startswith("Ветер:\nюго-западный, южный 6-11 м/с, , порывы 12-14 м/с\nВысота волн:"))
        self.assertEqual(s["valid_from"], "2026-03-13T21:00:00+03:00")
        self.assertEqual(s["valid_to"], "2026-03-14T21:00:00+03:00")
        self.assertEqual(s["wind"], "юго-западный, южный 6-11 м/с, , порывы 12-14 м/с")  # as is
        self.assertEqual(s["wind_ms"], [6, 11])
        self.assertEqual(s["gusts_ms"], [12, 14])
        self.assertEqual(s["waves"], {"1": "- м", "2": "вне льда до 0,5 м", "3": "вне льда 0,2-0,6 м",
                                      "4": "- м", "5": "вне льда до 0,5 м"})
        self.assertEqual(s["visibility"], "4-10 км, в дымке до 1-2 км")
        self.assertEqual(s["precip"], "без осадков, ночью дымка")
        self.assertTrue(s["air_temp"].startswith("ночью +1...+4 гр."))

    def test_no_summer_sentence_in_winter(self):
        self.assertIsNone(self.f["sentence"])
        self.assertIsNone(self.f["hydro"])


class TableAndReviewVariants(unittest.TestCase):
    def test_single_line_rows(self):
        lines = ["Сведения об уровнях воды (в см над «0» поста) на гидрологических постах Ленинградской области "
                 "на 08 часов утра 12.03.2026",
                 "Река-Пункт Отметка \"0\" поста, мБС Уровень, см Изменение за сутки Норма за март "
                 "Неблагоприятная отметка Опасная отметка Ледовые явления",
                 "Нева-Петрокрепость 0 398 3 434 - - разводья",
                 "Н.Л.К.-Свирица 0 431 1 480 570 600 Нет св",
                 "С.Л.К.-Сясьские Рядки 0 414 -2 463 - - Нет св"]
        t = fl.parse_level_table(lines)
        self.assertEqual([p["post"] for p in t["posts"]], ["Нева-Петрокрепость", "Н.Л.К.-Свирица", "С.Л.К.-Сясьские Рядки"])
        self.assertEqual(post(t, "Нева-Петрокрепость")["ice"], "разводья")
        self.assertEqual(post(t, "Н.Л.К.-Свирица")["danger_cm"], 600)
        self.assertEqual(post(t, "С.Л.К.-Сясьские Рядки")["change_cm"], -2)

    def test_ice_review_continuation(self):
        lines = ["ОБЗОР ЛЕДОВОЙ ОБСТАНОВКИ НА ЛАДОЖСКОМ ОЗЕРЕ",
                 "В районе Кобоны лед неподвижный. Местами лед трубчатый. Толщина льда 30-35 см. На юго-востоке "
                 "озера плавучий лед. Высота снега на льду 10 см."]
        k = place(fl.parse_ice_review(lines, 2026), "kobona")
        self.assertEqual([(v["min"], v["max"]) for v in k["cm"]], [(30, 35)])
        self.assertEqual(k["text"], "В районе Кобоны лед неподвижный. Местами лед трубчатый. Толщина льда 30-35 см.")

    def test_ice_review_2013_grammar(self):
        lines = fx_text("mchs_ice_review_20130315.txt").splitlines()
        r = fl.parse_ice_review(lines, 2013)
        cm = {p["id"]: [(v["min"], v["max"]) for v in p.get("cm", [])] for p in r["places"]}
        self.assertEqual(cm["petrokrepost_bay"], [(55, 70)])
        self.assertEqual(cm["volkhov_bay"], [(55, 65)])
        self.assertEqual(cm["svir_bay"], [(40, 65)])
        self.assertEqual(r["cover_pct"], 90)
        # «Высота снега на льду в среднем 10-15 см» is snow, and lake-wide: attached to no place
        self.assertFalse(any("Высота снега" in p["text"] for p in r["places"]))
        self.assertIn("Дрейф льда будет преимущественно", r["forecast"])


class SummerRss(unittest.TestCase):
    """RSS of 23.09.2026: 10 items, forecasts for 22–24.09 (only 24.09 has the level sentence), 4 warnings."""

    @classmethod
    def setUpClass(cls):
        cls.items = fl.parse_rss(fx_bytes("mchs_rss_20260923.xml"))
        cls.by_id = {i["id"]: i for i in cls.items}

    def test_items(self):
        self.assertEqual(len(self.items), 10)
        kinds = [fl.classify(i["title"]) for i in self.items]
        self.assertEqual(kinds.count("forecast"), 4)
        self.assertEqual(kinds.count("warning"), 4)
        self.assertEqual(kinds.count("other"), 2)
        self.assertEqual(self.by_id[5831131]["published"], at(2026, 9, 23, 16, 25))  # «Wed, 23 Sep 26 16:25:00 +0300»
        self.assertTrue(fl.rss_complete(fx_bytes("mchs_rss_20260923.xml")))
        self.assertFalse(fl.rss_complete(fx_bytes("mchs_rss_20260923.xml")[:20000]))

    def test_summer_level_sentence(self):
        it = self.by_id[5831129]
        lines = fl.html_to_lines(it["html"])
        self.assertTrue(fl.forecast_complete(lines))
        f = fl.parse_forecast(lines, 2026)
        s = f["sentence"]["items"][0]
        self.assertEqual(s["post"], "Нева – Петрокрепость")
        self.assertEqual((s["cm"], s["bs"], s["relation"], s["mark"], s["mark_cm"]),
                         (328, True, "ниже", "неблагоприятной", 330))
        self.assertTrue(f["sentence"]["text"].startswith("Уровень р. Нева – ст. Петрокрепость – 328 см БС, "
                                                         "ниже неблагоприятной"))
        self.assertEqual(f["sentence"]["outlook"],
                         ["22 сентября – 28 сентября уровень воды будет колебаться в районе неблагоприятной отметки."])
        self.assertEqual(len(f["hydro"]), 2)
        self.assertIsNone(f["ice_review"])
        self.assertIsNone(f["storm"])
        self.assertIsNone(f["table"])
        self.assertEqual(fl.forecast_target_date(it["title"]), dt.date(2026, 9, 24))

    def test_forecast_without_level(self):
        f = fl.parse_forecast(fl.html_to_lines(self.by_id[5830491]["html"]), 2026)
        self.assertIsNone(f["sentence"])
        self.assertIsNone(f["hydro"])  # only «имеются 23 стационарных … поста» boilerplate

    def test_warnings(self):
        w = {i: fl.parse_warning(self.by_id[i], fl.html_to_lines(self.by_id[i]["html"]))
             for i in (5831131, 5830142, 5830020, 5829749)}
        self.assertEqual((w[5831131]["level"], w[5831131]["title"]),
                         ("warning", "ПРЕДУПРЕЖДЕНИЕ О НЕБЛАГОПРИЯТНЫХ МЕТЕОРОЛОГИЧЕСКИХ ЯВЛЕНИЯХ"))
        self.assertEqual((w[5830142]["level"], w[5830142]["title"]),
                         ("emergency", "ЭКСТРЕННОЕ ПРЕДУПРЕЖДЕНИЕ О МЕТЕОРОЛОГИЧЕСКИХ ЯВЛЕНИЯХ"))
        self.assertEqual(w[5831131]["text"],
                         "Согласно прогнозу ФГБУ \"Северо-Западное УГМС\" от 23.09.2026: 24 сентября Дожди, местами сильные.")
        self.assertNotIn("ice", w[5831131])  # the boilerplate consequences are not copied
        self.assertEqual((w[5831131]["valid_from"], w[5831131]["valid_to"]),
                         ("2026-09-24T00:00:00+03:00", "2026-09-25T00:00:00+03:00"))
        self.assertEqual((w[5830142]["valid_from"], w[5830142]["valid_to"]),  # «Начиная с 21-24 часов 21.09», «21-22 сентября»
                         ("2026-09-21T21:00:00+03:00", "2026-09-23T00:00:00+03:00"))
        self.assertEqual((w[5830020]["valid_from"], w[5830020]["valid_to"]),
                         ("2026-09-22T00:00:00+03:00", "2026-09-23T00:00:00+03:00"))
        self.assertEqual((w[5829749]["valid_from"], w[5829749]["valid_to"]),  # «Днем 21.09»
                         ("2026-09-21T00:00:00+03:00", "2026-09-22T00:00:00+03:00"))
        for x in w.values():
            self.assertLessEqual(len(x["text"]), 600)
            self.assertNotIn("РЕКОМЕНДАЦИИ", x["text"])
        now = at(2026, 9, 23, 17)
        self.assertEqual([i for i, x in w.items() if fl.warning_active(x, now)], [5831131, 5830142])

    def test_warning_ice_line_is_kept(self):
        item = {"id": 1, "title": "ЭКСТРЕННОЕ ПРЕДУПРЕЖДЕНИЕ О МЕТЕОРОЛОГИЧЕСКИХ ЯВЛЕНИЯХ НА ТЕРРИТОРИИ ЛЕНИНГРАДСКОЙ ОБЛАСТИ",
                "published": at(2026, 3, 13, 11), "url": "u"}
        lines = ["Согласно предупреждению ФГБУ «Северо-Западное УГМС» №5/03 от 13.03.2026:",
                 "С 21 часа 13.03 до 21 часа 14.03 ожидается усиление юго-западного ветра порывами до 15-17 м/с.",
                 "В связи со сложившейся гидрометеорологической обстановкой:",
                 "13-14 марта повышается вероятность ДТП (Источник – ветер);",
                 "13-14 марта повышается вероятность отрыва прибрежных льдин с находящимися на них людьми "
                 "на Ладожском озере (Источник – ветер, процессы разрушения льда);",
                 "РЕКОМЕНДАЦИИ ДЛЯ НАСЕЛЕНИЯ:", "ВОЗДЕРЖИТЕСЬ ОТ ВЫХОДА НА ЛЕД!"]
        w = fl.parse_warning(item, lines)
        self.assertEqual((w["valid_from"], w["valid_to"]), ("2026-03-13T21:00:00+03:00", "2026-03-14T21:00:00+03:00"))
        self.assertTrue(w["ice"].startswith("13-14 марта повышается вероятность отрыва прибрежных льдин"))
        self.assertNotIn("ДТП", w["ice"])

    def test_validity_explicit_hours(self):
        pub = at(2026, 3, 13, 12)
        f, t = fl.parse_validity("Согласно прогнозу ФГБУ «Северо-Западное УГМС» от 13.03.2026: С 21 часа 13.03 до 21 часа "
                                 "14.03 ожидается усиление ветра", "", pub)
        self.assertEqual((f, t), (at(2026, 3, 13, 21), at(2026, 3, 14, 21)))
        f, t = fl.parse_validity("В период с 12 до 18 часов 25.09 ожидается гроза", "", at(2026, 9, 25, 9))
        self.assertEqual((f, t), (at(2026, 9, 25, 12), at(2026, 9, 25, 18)))
        f, t = fl.parse_validity("С 25 по 27 сентября ожидается сильный ветер", "", at(2026, 9, 24, 15))
        self.assertEqual((f, t), (at(2026, 9, 25), at(2026, 9, 28)))


class Grealm(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with gzip.open(os.path.join(FIX, "grealm_lake000396.10d.2.txt.gz"), "rt", encoding="ascii") as f:
            cls.text = f.read()
        cls.g = fl.parse_grealm(cls.text)

    def test_columns_from_header(self):
        c = fl.grealm_columns(self.text)
        self.assertEqual((c["date"], c["height"], c["ice"], c["egm"], c["src"]), (3, 6, 14, 15, 16))

    def test_latest_anomaly_and_depth_correction(self):
        g = self.g
        self.assertEqual(g["date"], "2026-09-12")
        self.assertEqual(g["height_m"], -1.25)
        self.assertEqual(g["month_norm_m"], -0.54)   # September norm 1993–2020
        self.assertEqual(g["anomaly_m"], -0.71)      # «на 0,71 м ниже нормы сентября»
        self.assertAlmostEqual(g["longterm_mean_m"], -0.515, places=3)
        self.assertIn(g["depth_correction_m"], (-0.73, -0.74))
        self.assertTrue(g["preliminary"])            # IGDR
        self.assertFalse(g["ice_flag"])
        self.assertEqual(g["height_egm2008_m"], 3.81)
        self.assertEqual(len(g["series"]), 12)
        self.assertEqual(g["series"][-1], ["2026-09-12", -1.25, -0.71, 0])
        self.assertEqual(g["series"][0][3], 1)       # 26.05 is ice-flagged (the flag is seasonal: Feb–May)
        self.assertEqual(len(g["month_norms_m"]), 12)

    def test_layout_change_is_refused(self):
        broken = self.text.replace("Column 3: Calendar year/month/day", "Column 3: Something else")
        with self.assertRaises(ValueError):
            fl.parse_grealm(broken)
        with self.assertRaises(ValueError):
            fl.parse_grealm("\n".join(self.text.splitlines()[:80]))  # too few rows


class MurSst(unittest.TestCase):
    def test_summer(self):
        rows = fl.parse_mur_csv(fx_text("mur_volkhov_summer.csv", "latin-1"))
        p = fl.mur_point(rows, "volkhov", "Волховская губа", 60.2, 32.25)
        self.assertEqual((p["date"], p["temp_c"], p["under_ice"]), ("2026-09-16", 14.6, False))
        self.assertEqual((p["prev_date"], p["prev_c"], p["change_c"]), ("2026-09-09", 14.5, 0.1))
        self.assertNotIn("outside_lake_mask", p)

    def test_under_ice(self):
        rows = fl.parse_mur_csv(fx_text("mur_volkhov_winter.csv", "latin-1"))
        p = fl.mur_point(rows, "volkhov", "Волховская губа", 60.2, 32.25)
        self.assertTrue(p["under_ice"])
        self.assertIsNone(p["temp_c"])       # −1.8 °C is a sea-water convention, not a lake temperature
        self.assertEqual(p["ice_fraction"], 0.57)
        self.assertTrue(p["prev_under_ice"])
        self.assertNotIn("change_c", p)

    def test_query_url(self):
        u = fl.mur_url(60.2, 32.25)
        self.assertIn("analysed_sst%5Blast-7:7:last%5D%5B(60.2)%5D%5B(32.25)%5D", u)
        self.assertIn(",mask%5B", u)


class MeteoNw(unittest.TestCase):
    def test_levels(self):
        m = fl.parse_meteonw(fx_text("meteonw_lo_levelsd.html", "cp1251"))
        self.assertEqual(m["time"], "2026-09-23T09:00:00+03:00")
        self.assertEqual(m["petrokrepost_cm"], 341)
        self.assertEqual(len(m["posts"]), 7)


class VolgoBalt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = fx_text("volgobalt_konsultatsiya_202609.html")

    def test_consultation(self):
        vb = fl.parse_volgobalt(self.html, dt.date(2026, 9, 24))
        self.assertEqual((vb["period"], vb["period_status"], vb["decade"]), ("2026-09", "current", 3))
        self.assertEqual((vb["decade_from"], vb["decade_to"]), ("2026-09-21", "2026-09-30"))
        sy = next(p for p in vb["posts"] if p["id"] == "syasskie_ryadki")
        self.assertEqual((sy["name"], sy["name_src"]), ("Сясьские Рядки", "Сяськие Рядки"))  # typo on the site
        self.assertEqual((sy["project_level_bs_m"], sy["values_bs_m"], sy["level_bs_m"]), (4.0, [3.8, 3.75, 3.7], 3.7))
        sv = next(p for p in vb["posts"] if p["id"] == "svirica")
        self.assertEqual((sv["project_level_bs_m"], sv["values_bs_m"]), (4.1, [3.9, 3.85, 3.8]))
        self.assertEqual({p["id"] for p in vb["posts"]}, {"syasskie_ryadki", "svirica", "shlisselburg"})
        vol = next(d for d in vb["depths"] if d["name"] == "Ст.Ладога-Устье")
        self.assertEqual((vol["guaranteed_cm"], vol["values_cm"], vol["expected_cm"]), (350, [320, 315, 310], 310))
        self.assertFalse(any("Череповец" in d["name"] for d in vb["depths"]))
        self.assertTrue(any("ветровым воздействием" in n for n in vb["notes"]))

    def test_decades_and_depth_correction(self):
        for day, dec, m in ((5, 1, -1.3), (15, 2, -1.35), (24, 3, -1.4)):
            vb = fl.parse_volgobalt(self.html, dt.date(2026, 9, day))
            self.assertEqual(vb["decade"], dec)
            dc = fl.volgobalt_depth_correction(vb, dt.date(2026, 9, day))
            self.assertEqual(dc["m"], m)
            self.assertEqual(dc["from"], "Волго-Балт, Сясьские Рядки")
            self.assertEqual(dc["datum_bs_m"], 5.10)
        vb = fl.parse_volgobalt(self.html, dt.date(2026, 10, 3))
        self.assertEqual((vb["period_status"], vb["decade"]), ("past", 3))
        self.assertIsNotNone(fl.volgobalt_depth_correction(vb, dt.date(2026, 10, 3)))
        self.assertIsNone(fl.volgobalt_depth_correction(vb, dt.date(2026, 10, 20)))  # too old: G-REALM takes over
        vb = fl.parse_volgobalt(self.html, dt.date(2026, 8, 30))
        self.assertEqual((vb["period_status"], vb["decade"]), ("ahead", 1))


class Ims(unittest.TestCase):
    def test_projection(self):
        self.assertEqual(fl.ims_cell(61.38, 30.95), (3344, 3782))  # Valaam: the single land cell in the lake

    def test_sectors_winter_and_summer(self):
        with gzip.GzipFile(fileobj=io.BytesIO(ims_stream("2026020"))) as gz:
            s = fl.ims_summary(fl.ims_read_rows(gz, fl.ims_needed_rows()))
        self.assertEqual({k: v["state"] for k, v in s.items()},
                         {"volkhov": "ice", "svir": "ice", "petrokrepost": "ice", "south_open": "ice", "center": "water"})
        with gzip.GzipFile(fileobj=io.BytesIO(ims_stream("2026266"))) as gz:
            s = fl.ims_summary(fl.ims_read_rows(gz, fl.ims_needed_rows()))
        self.assertEqual({v["state"] for v in s.values()}, {"water"})
        self.assertEqual(s["volkhov"]["water"], 6)

    def test_valaam_is_land_in_summer(self):
        rows = json.loads(fx_text("ims_rows.json"))
        row = rows["files"]["2026266"]["3344"]
        self.assertEqual(row[3782 - rows["c0"]], "2")


def winter_rss():
    """An RSS in the МЧС format carrying the 14.03.2026 forecast (ice review, table, storm) and four warnings."""
    summer = fl.parse_rss(fx_bytes("mchs_rss_20260923.xml"))
    art = fl.extract_article(fx_text("mchs_forecast_20260314.html"))
    items = [(5700001, "Оперативный ежедневный прогноз ЧС на 14 марта 2026 года", "Fri, 13 Mar 26 13:36:00 +0300", art)]
    for k, it in enumerate(i for i in summer if fl.classify(i["title"]) == "warning"):
        items.append((5700002 + k, it["title"], f"Fri, 13 Mar 26 {10 + k:02d}:00:00 +0300", it["html"]))
    root = fl.ET.Element("rss", {"version": "2.0"})
    ch = fl.ET.SubElement(root, "channel")
    for iid, title, pub, html in items:
        it = fl.ET.SubElement(ch, "item")
        fl.ET.SubElement(it, "title").text = title
        fl.ET.SubElement(it, "pubDate").text = pub
        fl.ET.SubElement(it, "link").text = f"https://47.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/{iid}"
        fl.ET.SubElement(it, f"{{{fl.YANDEX_NS}}}full-text").text = html
    return fl.ET.tostring(root, encoding="utf-8")


class FakeHttp:
    """Serves fixtures instead of the network; `fail` maps URL substrings to errors."""

    def __init__(self, fail=None, rss=None):
        self.fail = fail or {}
        self.rss = rss
        self.count = 0
        self.urls = []
        self._ims = None

    def get(self, url, timeout=20.0, retries=2, conditional=False, validate=None, max_bytes=16 << 20, cache=None):
        self.count += 1
        self.urls.append(url)
        for key, err in self.fail.items():
            if key in url:
                raise fl.FetchError(err)
        headers = {"Content-Type": "text/html; charset=utf-8"}
        if "47.mchs.gov.ru" in url and url.endswith("/rss"):
            body = self.rss or fx_bytes("mchs_rss_20260923.xml")
        elif "earth.gsfc.nasa.gov" in url:
            body = gzip.decompress(fx_bytes("grealm_lake000396.10d.2.txt.gz"))
        elif "volgo-balt.ru" in url:
            body = fx_bytes("volgobalt_konsultatsiya_202609.html")
        elif "meteo.nw.ru" in url:
            body, headers = fx_bytes("meteonw_lo_levelsd.html"), {"Content-Type": "text/html; charset=windows-1251"}
        elif "jplMURSST41" in url:
            body = fx_bytes("mur_volkhov_summer.csv")
        elif "G02156" in url:
            if self._ims is None:
                self._ims = ims_stream("2026020")
            body = self._ims
        else:
            raise fl.FetchError("HTTP 404 Not Found")
        if validate is not None and not validate(body):
            raise fl.FetchError("incomplete response")
        return fl.Response(url, 200, headers, body)


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ladoga_live_test_")
        self.log = []

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_once(self, now, **kw):
        http = kw.pop("http", None) or FakeHttp()
        live = fl.run(self.dir, now=now, http=http, log=self.log.append, **kw)
        with open(os.path.join(self.dir, "live.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), live)
        return live, http

    def test_full_run_then_failure_keeps_previous_blocks(self):
        now = at(2026, 9, 23, 17)
        live, http = self.run_once(now)
        m = live["meta"]["blocks"]
        self.assertEqual({k: v["status"] for k, v in m.items()},
                         {"mchs": "ok", "level.grealm": "ok", "level.volgobalt": "ok", "level.meteonw": "ok",
                          "water_temp": "ok", "ice_season": "off_season"})
        self.assertEqual(live["meta"]["errors"], {})
        self.assertIsNone(live["ice_season"])
        mchs = live["mchs"]
        self.assertEqual(mchs["forecast"]["date"], "2026-09-24")
        self.assertEqual([w["id"] for w in mchs["warnings"]], [5831131, 5830142])
        self.assertIsNone(mchs["ice_review"])
        lm = live["level"]["mchs"]
        self.assertEqual(lm["petrokrepost"], {"cm_bs": 328, "date": "2026-09-23", "from": "sentence",
                                              "mark": "неблагоприятной", "mark_cm_bs": 330})
        self.assertTrue(lm["text"].startswith("Уровень р. Нева – ст. Петрокрепость – 328 см БС"))
        wt = live["water_temp"]  # the flat headline fields the app reads
        self.assertEqual((wt["open_lake_c"], wt["week_ago_c"], wt["under_ice"], wt["date"]),
                         (14.6, 14.5, False, "2026-09-16"))
        dc = live["level"]["depth_correction"]
        self.assertEqual((dc["m"], dc["source"], dc["from"]), (-1.4, "volgobalt", "Волго-Балт, Сясьские Рядки"))
        self.assertEqual(live["level"]["depth_correction_grealm"]["source"], "grealm")
        self.assertEqual(live["level"]["grealm"]["anomaly_m"], -0.71)
        self.assertEqual(live["level"]["meteonw"]["petrokrepost_cm"], 341)
        self.assertEqual(len(live["water_temp"]["points"]), 3)
        self.assertEqual(live["water_temp"]["label"], "открытое озеро")
        size = os.path.getsize(os.path.join(self.dir, "live.json"))
        self.assertLess(size, 20 * 1024)
        self.assertEqual(len(self.log), 7)  # one line per block + the summary line

        # an hour later: the RSS fails, the slow blocks are not due yet
        self.log.clear()
        live2, http2 = self.run_once(at(2026, 9, 23, 18), http=FakeHttp(fail={"/rss": "HTTP 503 Service Unavailable"}))
        m2 = live2["meta"]["blocks"]
        self.assertEqual(m2["mchs"]["status"], "stale")
        self.assertEqual(m2["mchs"]["fetched_at"], "2026-09-23T17:00:00+03:00")
        self.assertIn("503", live2["meta"]["errors"]["mchs"]["error"])
        self.assertEqual(live2["mchs"]["forecast"], mchs["forecast"])       # last good block kept, with its own date
        self.assertEqual(live2["level"]["mchs"]["petrokrepost"]["cm_bs"], 328)
        for name in ("level.grealm", "level.volgobalt", "level.meteonw", "water_temp"):
            self.assertEqual(m2[name]["status"], "cached", name)
        self.assertEqual(http2.urls, [fl.MCHS_RSS])                          # nothing else was requested
        self.assertTrue(os.path.exists(os.path.join(self.dir, "live.prev.json")))
        self.assertFalse([f for f in os.listdir(self.dir) if f.endswith(".tmp")])

        # two days later the RSS works again but the old warnings expire
        live3, _ = self.run_once(at(2026, 9, 25, 20))
        self.assertEqual([w["id"] for w in live3["mchs"]["warnings"]], [])

    def test_force_reads_ims_and_everything(self):
        live, http = self.run_once(at(2026, 9, 23, 17), force=True)
        ice = live["ice_season"]
        self.assertEqual(ice["sectors"]["volkhov"]["state"], "ice")      # the served file is the 20.01.2026 grid
        self.assertEqual(live["meta"]["blocks"]["ice_season"]["status"], "ok")
        self.assertTrue(any("ims2026266" in u for u in http.urls))       # 23.09 after 14 UTC → today's file

    def test_block_failure_without_previous_value(self):
        live, _ = self.run_once(at(2026, 9, 23, 17), http=FakeHttp(fail={"volgo-balt.ru": "HTTP 403 Forbidden"}))
        self.assertIsNone(live["level"]["volgobalt"])
        self.assertEqual(live["meta"]["blocks"]["level.volgobalt"]["status"], "error")
        self.assertEqual(live["level"]["depth_correction"]["source"], "grealm")   # fallback
        self.assertEqual(live["mchs"]["forecast"]["id"], 5831130)  # everything else still works

    def test_winter_run_stays_compact(self):
        live, http = self.run_once(at(2026, 3, 13, 18), http=FakeHttp(rss=winter_rss()), force=True)
        m = live["mchs"]
        self.assertEqual(m["ice_review"]["obs_date"], "2026-03-12")
        self.assertEqual(m["ice_review"]["date"], "2026-03-14")
        self.assertEqual(m["storm"]["valid_to"], "2026-03-14T21:00:00+03:00")
        self.assertEqual(len(m["warnings"]), 4)
        self.assertEqual(len(live["level"]["mchs"]["table"]["posts"]), 16)
        self.assertEqual(live["level"]["mchs"]["petrokrepost"],
                         {"cm_bs": 398, "date": "2026-03-12", "from": "table", "norm_cm_bs": 434})
        self.assertEqual(live["ice_season"]["sectors"]["center"]["state"], "water")
        self.assertEqual(live["meta"]["errors"], {})
        size = os.path.getsize(os.path.join(self.dir, "live.json"))
        self.assertLess(size, 20 * 1024, f"live.json is {size} bytes")
        # the storm forecast is dropped once it is over, the ice review is kept (with its date) when the RSS fails
        live2, _ = self.run_once(at(2026, 3, 15, 9), http=FakeHttp(fail={"/rss": "timeout"}))
        self.assertIsNone(live2["mchs"]["storm"])            # ended 14.03 21:00
        self.assertEqual(live2["mchs"]["ice_review"]["obs_date"], "2026-03-12")
        self.assertEqual(len(live2["mchs"]["warnings"]), 4)  # published 13.03 10–13 h: less than 48 h ago
        live3, _ = self.run_once(at(2026, 3, 15, 14), http=FakeHttp(fail={"/rss": "timeout"}))
        self.assertEqual(live3["mchs"]["warnings"], [])      # now more than 48 h ago
        self.assertEqual(live3["meta"]["blocks"]["mchs"]["status"], "stale")

    def test_only_option(self):
        live, http = self.run_once(at(2026, 9, 23, 17), only={"water_temp"})
        self.assertTrue(all("jplMURSST41" in u for u in http.urls))
        self.assertEqual(live["meta"]["blocks"]["mchs"]["status"], "cached")


if __name__ == "__main__":
    unittest.main()
