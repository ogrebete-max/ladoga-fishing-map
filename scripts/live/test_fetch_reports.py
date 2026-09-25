#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Offline tests of the report monitor (reports_extract.py, fetch_reports.py) on saved fixtures (no network):

    python scripts/live/test_fetch_reports.py
    cd scripts/live && python -m unittest -v test_fetch_reports

fixtures/reports/: a fisher.spb.ru catalog page (Кошкино, 24.09.2026, 4 messages, the authors replaced by a fake
name), t.me/s pages of @rybalka_spb_lenoblasti and @acclenobl (trimmed), the 47news RSS (5 real items + 4 test
items), the 47news article 283454 of 28.02.2026, a synthetic official page, feed and watch.json, a mini points.json.
"""
import datetime as dt
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fetch_reports as fr  # noqa: E402
import reports_extract as rx  # noqa: E402

FIX = os.path.join(HERE, "fixtures", "reports")
MSK = rx.MSK
FAKE_AUTHOR = "Тестов Тест"   # the name put in place of the forum authors in the fixture
RSL = "rybalka_spb_lenoblasti"
EMPTY_PKR = ('<html><body><div class="news-total">Всего сообщений:&nbsp;<b>0</b></div></body></html>').encode()
EMPTY_TG = b'<html><body><section class="tgme_channel_history js-message_history"></section></body></html>'


def fx(name):
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


def at(y, mo, d, h=0, mi=0):
    return dt.datetime(y, mo, d, h, mi, tzinfo=MSK)


def D(s):
    return dt.date.fromisoformat(s)


def tg_page(channel, posts, older=None):
    """A t.me/s page in the real markup. posts: [(id, ISO datetime UTC, text HTML)]."""
    wraps = []
    for pid, when, text in posts:
        wraps.append(
            '<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message '
            f'text_not_supported_wrap js-widget_message" data-post="{channel}/{pid}">'
            '<div class="tgme_widget_message_bubble">'
            f'<div class="tgme_widget_message_text js-message_text" dir="auto">{text}</div>'
            '<div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info '
            f'short js-message_info"><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" '
            f'href="https://t.me/{channel}/{pid}"><time datetime="{when}" class="time">10:00</time></a></span></div>'
            '</div></div></div></div>')
    more = (f'<a href="/s/{channel}?before={older}" class="tme_messages_more js-messages_more" data-before="{older}"></a>'
            if older else "")
    return ('<html><body><section class="tgme_channel_history js-message_history">' + more + "".join(wraps)
            + "</section></body></html>").encode("utf-8")


def tg_msg(channel, pid, when, text, hrefs=()):
    html = text.replace("\n", "<br/>") + "".join(f' <a href="{h}">источник</a>' for h in hrefs)
    return rx.parse_tg_page(tg_page(channel, [(pid, when, html)]), channel)[0]


class FakeHttp:
    """Serves fixtures instead of the network. routes: exact URL, then URL substring (longest first) → body;
    fail: URL substring → error. Unknown fisher.spb.ru / t.me pages are empty pages, anything else is a 404."""

    def __init__(self, routes=None, fail=None):
        self.routes = dict(routes or {})
        self.fail = dict(fail or {})
        self.urls = []
        self.count = 0
        self.per_host = {}

    def get(self, url, timeout=20.0, retries=2, conditional=False, validate=None, max_bytes=8 << 20):
        self.urls.append(url)
        self.count += 1
        host = re.sub(r"^https?://([^/]+).*$", r"\1", url)
        self.per_host[host] = self.per_host.get(host, 0) + 1
        for key, err in self.fail.items():
            if key in url:
                raise fr.FetchError(err)
        body = self.routes.get(url)
        if body is None:
            for key in sorted(self.routes, key=len, reverse=True):
                if not key.startswith("http") and key in url:
                    body = self.routes[key]
                    break
        if body is None:
            if "fisher.spb.ru" in url:
                body = EMPTY_PKR
            elif "t.me/s/" in url:
                body = EMPTY_TG
            else:
                raise fr.FetchError("HTTP 404 Not Found")
        if validate is not None and not validate(body):
            raise fr.FetchError("incomplete response")
        return fr.Response(url, 200, {"Content-Type": "text/html; charset=utf-8"}, body)

    def hits(self, sub):
        return [u for u in self.urls if sub in u]


def vps_routes():
    return {"category=5&water=165&StartValue=0": fx("pkr_5_165_p0.html"),
            "47news.ru/rss/": fx("news47_rss.xml"),
            "47news.ru/articles/283454/": fx("news47_article_283454.html")}


def known():
    return fr.Known(json.loads(fx("points_known.json").decode("utf-8")))


# ------------------------------------------------------------------------------------------------ parsers

class Parsers(unittest.TestCase):
    def test_fisher_catalog_page(self):
        page = rx.parse_pkr_page(fx("pkr_5_165_p0.html"))
        self.assertEqual(page["total"], 1130)
        self.assertEqual([m["id"] for m in page["messages"]], [115870, 115865, 115832, 115819])
        m = page["messages"][0]
        self.assertEqual((m["date"], m["time"], m["place"]), (D("2026-08-28"), "03:06", "Кошкино - им. Морозова"))
        self.assertIn("отводной джиг", m["text"])
        self.assertEqual(set(m), {"id", "place", "date", "time", "text"})  # no author field at all
        self.assertFalse([x for x in page["messages"] if FAKE_AUTHOR in json.dumps(x, default=str, ensure_ascii=False)])

    def test_fisher_page_cut_inside_a_character(self):
        # the real page of 24.09.2026 had a UTF-8 character cut by the site's text trimming
        broken = fx("pkr_5_165_p0.html").replace("Сегодня, часов".encode(), b"\xd0 \xbd" + "часов".encode())
        self.assertEqual(len(rx.parse_pkr_page(broken)["messages"]), 4)

    def test_telegram_page(self):
        body = fx("tg_rybalka_spb_lenoblasti.html")
        msgs = rx.parse_tg_page(body, RSL)
        self.assertEqual([m["id"] for m in msgs], [26696, 26702, 26713, 26720, 26723])
        m = msgs[0]
        self.assertEqual(m["datetime"].isoformat(), "2026-09-22T10:20:19+03:00")  # 07:20:19 UTC
        self.assertTrue(m["text"].startswith("21.09.26\n🚩 Река Волхов, г.Новая Ладога"))
        self.assertIn("Координаты локации: 60.116429, 32.326642", m["text"])
        self.assertEqual(rx.tg_older_link(body), 26691)
        self.assertEqual([m["id"] for m in rx.parse_tg_page(fx("tg_acclenobl.html"), "acclenobl")], [3853, 3855, 3868, 3869])
        self.assertEqual(rx.parse_tg_page(body, "other_channel"), [])

    def test_rss_and_article(self):
        items = rx.rss_items(fx("news47_rss.xml"))
        self.assertEqual(len(items), 9)
        it = next(i for i in items if i["id"] == "900001")
        self.assertEqual(it["published"], at(2026, 9, 24, 7, 30))
        self.assertTrue(it["title"].startswith("У Кобоны перевернулась лодка"))
        art = rx.parse_47news_article(fx("news47_article_283454.html"))
        self.assertEqual(art["title"], "Спасатели вытащили со льда Ладоги мужчину на снегоходе")
        self.assertEqual(art["published"], at(2026, 2, 28, 18, 59))
        self.assertEqual(len(art["paras"]), 5)
        lead = rx.lead_paragraphs(art["paras"])
        self.assertEqual(len(lead), 4)  # «Как ранее писал 47news, … утонул лыжник …» is about another case
        self.assertFalse([p for p in lead if "лыжник" in p])
        self.assertIsNone(rx.parse_47news_article(fx("news47_article_283454.html")[:900]))
        with self.assertRaises(ValueError):
            rx.rss_items(b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><rss></rss>')

    def test_notice_items_and_dates(self):
        target = json.loads(fx("watch_test.json"))["targets"][0]
        items = rx.extract_notice_items(fx("notices_list.html").decode("utf-8"), target["item"], target["base"])
        self.assertEqual([i["url"] for i in items][:2], ["https://sztu.example.test/news/1001/", "https://sztu.example.test/news/1000/"])
        self.assertEqual(len(items), 5)  # the repeated item is listed once
        self.assertEqual([rx.parse_date_any(i["date_raw"]) for i in items[:3]],
                         [D("2026-09-24"), D("2026-09-20"), D("2026-09-18")])
        self.assertEqual(rx.parse_date_any("Thu, 24 Sep 2026 07:30:00 +0300"), D("2026-09-24"))
        self.assertEqual(rx.parse_date_any("24 сентября", default_year=2026), D("2026-09-24"))
        self.assertIsNone(rx.parse_date_any("вчера"))

    def test_urls_compare(self):
        self.assertEqual(rx.norm_url("https://t.me/s/fisher47region/2275?single"), "t.me/fisher47region/2275")
        self.assertEqual(rx.norm_url("https://47news.ru/articles/283454/"), rx.norm_url("47news.ru/articles/283454"))


# ---------------------------------------------------------------------------------------- fishing reports

def pkr(text, date="2026-02-10", mid=900100, cat=5, water=163):
    return rx.pkr_extract({"id": mid, "date": D(date), "text": text, "place": ""}, cat, water)


def tg(text, channel="feeder_spb", pid=500, when="2026-09-23T08:00:00+00:00", hrefs=()):
    return rx.tg_extract(tg_msg(channel, pid, when, text, hrefs), channel)


class FishingReports(unittest.TestCase):
    def test_club_report_at_the_catalog_pin(self):
        m = rx.parse_pkr_page(fx("pkr_5_165_p0.html"))["messages"][0]
        rec, why = rx.pkr_extract(m, 5, 165)
        self.assertEqual(why, "ok")
        # the same fields as the record the research put in site/data/points.json for this message
        self.assertEqual({k: rec[k] for k in ("id", "lat", "lon", "kind", "cls", "prec", "fish", "date", "season", "title",
                                              "method", "src", "url", "sid", "sector", "dist", "zone", "place")},
                         {"id": "pkr:115870", "lat": 59.97638, "lon": 31.07685, "kind": "fishing", "cls": "C", "prec": 1500,
                          "fish": ["Щука", "Окунь"], "date": "2026-08-28", "season": "open_water",
                          "title": "Кошкино: щука, окунь (авг. 2026)", "method": "джиг, воблер, отводной",
                          "src": "fisher.spb.ru (Питерский клуб рыбаков)",
                          "url": "https://fisher.spb.ru/news/message.php?messageId=115870", "sid": "115870",
                          "sector": "Шлиссельбург / бухта Петрокрепость", "dist": 69.1, "zone": "ext", "place": "Кошкино"})
        self.assertEqual(rec["comment"], "По открытой воде, Кошкино: ловились щука и окунь; снасти: джиг, воблер, отводной; "
                                         "точка — метка места «Кошкино» в каталоге ПКР, в отчёте место точнее не указано.")

    def test_not_reports(self):
        self.assertEqual(pkr("Продам лодку ПВХ 3,6 м и мотор, место хранения Кобона. Торг.")[1], "not_report")
        self.assertEqual(pkr("Погиб наш товарищ, светлая память. Похороны в субботу.")[1], "not_report")
        self.assertEqual(pkr("Кто знает, как сейчас лёд у Кобоны? Собираемся в субботу.")[1], "not_catch_report")
        self.assertEqual(tg("Продаю эхолот Lowrance, отдам недорого, самовывоз из Новой Ладоги.")[1], "not_report")
        self.assertEqual(tg("Розыгрыш призов среди подписчиков! Ладога ждёт.")[1], "not_report")
        # a report that also mentions a lost item stays a report (fisher_extract)
        rec, why = pkr("16.02-18.02 зеленцы глубина 4 м, изловлено 13 кг, основной клёв днём. Потерял шнек, если кто "
                       "найдет — верните.",
                       date="2026-02-19")
        self.assertEqual((why, rec["place"], rec["date"]), ("ok", "о-ва Зеленцы", "2026-02-18"))

    def test_dates_written_in_the_text(self):
        rec, _ = pkr("Вчера на Кобоне поймал 12 окуней на балансир.", date="2026-02-10")
        self.assertEqual(rec["date"], "2026-02-09")
        rec, _ = pkr("12.01 на Кобоне поймал 12 окуней на балансир.", date="2026-02-10")
        self.assertEqual(rec["date"], "2026-01-12")
        rec, _ = pkr("12.11 на Кобоне поймал 12 окуней на балансир.", date="2026-02-10")  # 90 days back: no
        self.assertEqual(rec["date"], "2026-02-10")
        rec, _ = pkr("5.8 кг плотвы за день у Кобоны, клевало на мормышку.", date="2026-08-20")
        self.assertEqual(rec["date"], "2026-08-20")  # a weight, not the 5th of August
        recs, _ = tg("19-20.09.26\n🚩 Ладожское озеро, д. Чёрное\nПоймали щуку на 3 кг с лодки.")
        self.assertEqual(recs[0]["date"], "2026-09-20")
        recs, _ = tg("Отчёт от 21.09.26. Курганы. Поймал двух лещей на фидер.")
        self.assertEqual(recs[0]["date"], "2026-09-21")

    def test_published_coordinates(self):
        recs, why = tg("21.09.26\n🚩 Река Волхов, д. Иссад\n\nЛещ 2 кг на фидер\n\n🧭 Координаты локации: 60.060800, 32.349180\n\n"
                       "#волхов #лещ #рыбалка", channel=RSL, pid=26800)
        self.assertEqual(why, "ok")
        self.assertEqual(len(recs), 1)
        r = recs[0]
        self.assertEqual((r["id"], r["cls"], r["prec"], r["lat"], r["lon"], r["place"]),
                         (f"tg:{RSL}/26800", "A", 30, 60.0608, 32.34918, "Иссад (Волхов)"))
        self.assertEqual((r["title"], r["method"], r["catch"], r["src"]),
                         ("Иссад (Волхов): лещ (сент. 2026)", "фидер", "2 кг", "Telegram: Рыболовная сводка СПб"))
        self.assertTrue(r["comment"].endswith("координаты опубликованы в посте."))

    def test_parking_coordinates_are_not_a_fishing_place(self):
        recs, why = tg("19-20.09.26\n🚩 Ладожское озеро, южный берег, д. Чёрное, Кировский район\n\nСвою рыбку поймала: щука "
                       "на спиннинг с лодки.\n\n🧭 Координаты парковки: 60.137864, 31.614352\n\n#ладога #щука", channel=RSL, pid=26801)
        self.assertEqual(why, "ok")
        fishing = [r for r in recs if r["kind"] == "fishing"]
        launch = [r for r in recs if r["kind"] == "launch"]
        self.assertEqual(len(fishing), 1)
        self.assertEqual((fishing[0]["cls"], fishing[0]["place"], fishing[0]["lat"]), ("C", "Чёрное", 60.13373))
        self.assertEqual((launch[0]["id"], launch[0]["cls"], launch[0]["lat"], launch[0]["lon"]),
                         (f"tg:{RSL}/26801#p", "A", 60.137864, 31.614352))
        self.assertEqual(launch[0]["title"], "Парковка / выход к воде: Чёрное")

    def test_author_line_before_a_pin_is_not_a_parking(self):
        # «Автор …» once made the pair after it a parking («авто»)
        recs, _ = tg("Сегодня устье Волхова. Рыбка проклюнулась, ловы от 10 шт.\nАвтор Никола Ижорский\n📍 60.125667, 32.342443")
        self.assertEqual([(r["kind"], r["cls"]) for r in recs], [("fishing", "A")])

    def test_depth_is_not_a_casting_distance(self):
        self.assertEqual(rx.depth_in("Коллеги кормили ближнюю дистанцию. На 18 метрах поймал пару линьков"), "")
        self.assertEqual(rx.depth_in("Фидер, ловил на 25 метрах, лещ"), "")
        self.assertEqual(rx.depth_in("Оттолкнулся от берега. Точку выбрал на 5,5 м, ближе к бакену"), "5,5 м")
        self.assertEqual(rx.depth_in("Глубина 5,8 м. Палатка, прикормка"), "5,8 м")

    def test_ice_facts(self):
        rec, _ = pkr("Сегодня на Кобоне, лёд 25-30 см, у берега трещины и вода на льду. Поймал 12 окуней на мормышку, "
                     "глубина 4 м.", date="2026-02-10")
        self.assertEqual(rec["ice"], {"cm": "25–30", "flags": ["трещины", "вода на льду"]})
        self.assertEqual((rec["season"], rec["depth"]), ("ice", "4 м"))
        self.assertIn("лёд 25–30 см, трещины, вода на льду", rec["comment"])
        self.assertEqual(rx.ice_facts("толщина льда 15 см, торосы"), {"cm": "15", "flags": ["торосы"]})
        self.assertEqual(rx.ice_facts("под ногами 15–20 см льда"), {"cm": "15–20"})
        self.assertIsNone(rx.ice_facts("щука 60 см, отпустили"))
        rec, _ = pkr("Лёд 20 см. Поймал 3 окуня.", date="2026-08-10")  # summer: no ice block
        self.assertNotIn("ice", rec)

    def test_kilometres_on_the_ice(self):
        rec, _ = pkr("22го снова поудил окуня в Кобоне. Зашёл на 2,5-3 км, на 5ой лунке нашёлся окунь, около 5 кг поднял.",
                     date="2026-02-23")
        self.assertIn("Кобона, ~2,8 км", rec["title"])
        self.assertAlmostEqual(rx.hav(rec["lat"], rec["lon"], 60.0212, 31.5426), 2750, delta=30)

    def test_other_waters_and_the_upper_volkhov(self):
        self.assertEqual(pkr("Волхов у моста, ниже ГЭС поймал леща на фидер.", cat=2, water=134)[1], "volkhov_not_lower")
        self.assertEqual(pkr("Ездили в Свирьстрой, поймали окуня.", cat=2, water=143)[1], "svir_not_lower")
        self.assertEqual(pkr("Пятиречье, поймал щуку 3 кг.", water=183)[1], "no_place_or_outside")
        self.assertEqual(pkr("Отчёт", water=167)[1], "north")
        self.assertEqual(tg("Вуокса, Лосево. Поймал щуку на воблер.")[1], "outside")
        self.assertEqual(tg("🚩 Онежское озеро\nПоймали окуня.\nКоординаты: 61.500000, 35.200000")[1], "outside")
        self.assertEqual(tg("03.05.26 🚩 Новоладожский канал, Синявино\nПоймал плотву.\n🧭 Координаты локации: 59.909691, "
                            "31.206377")[1], "coord_outside")
        self.assertEqual(tg("🚩 Река Волхов\nПоймал леща, 0 рыб у соседей.")[1], "no_place")

    def test_club_reposts_in_the_aggregator_are_skipped(self):
        recs, why = tg("23.03.2026\nд.Кошкино\nПоймал окуня на джиг.", channel="novosti_s_vodoemov",
                       hrefs=("https://fisher.spb.ru/news/message-bycatalog.php?category=5&water=165",))
        self.assertEqual((recs, why), ([], "repost_of_pkr"))

    def test_real_telegram_page(self):
        res = {m["id"]: rx.tg_extract(m, RSL) for m in rx.parse_tg_page(fx("tg_rybalka_spb_lenoblasti.html"), RSL)}
        self.assertEqual({k: v[1] for k, v in res.items()},
                         {26696: "ok", 26702: "no_place", 26713: "outside", 26720: "not_report", 26723: "ok"})
        r = res[26696][0][0]
        self.assertEqual((r["cls"], r["lat"], r["lon"], r["title"]),
                         ("A", 60.116429, 32.326642, "Волхов у Новой Ладоги: судак, лещ (сент. 2026)"))
        self.assertEqual(sorted(r["kind"] for r in res[26723][0]), ["fishing", "launch"])


# ------------------------------------------------------------------------------------------------ incidents

def inc(text, date="2026-03-03", title=""):
    return rx.incident_extract(title, text, D(date), "TG", "https://t.me/acclenobl/1", "tg:acclenobl/1", "tg:acclenobl/1")


class Incidents(unittest.TestCase):
    def test_article_placed_by_the_mchs_sentence(self):
        art = rx.parse_47news_article(fx("news47_article_283454.html"))
        rec, why = rx.incident_extract(art["title"], "\n".join(rx.lead_paragraphs(art["paras"])), art["published"].date(),
                                       rx.NEWS47_SRC, "https://47news.ru/articles/283454/", "news47:283454", "47news:283454")
        self.assertEqual(why, "ok")
        self.assertEqual((rec["kind"], rec["type"], rec["people"], rec["place"], rec["date"]),
                         ("ice_incident", "breakdown", 1, "Нижняя Шальдиха", "2026-02-28"))
        self.assertEqual(rec["title"], "Нижняя Шальдиха: поломка техники на льду, 1 чел.")
        self.assertEqual(rec["comment"], "Поломка техники на льду — Нижняя Шальдиха; 1 чел.; спасён.")

    def test_news_items(self):
        items = {i["id"]: i for i in rx.rss_items(fx("news47_rss.xml"))}
        i = items["900001"]
        rec, why = rx.incident_extract(i["title"], i["summary"], i["published"].date(), rx.NEWS47_SRC, i["url"], "news47:900001", "x")
        self.assertEqual((rec["kind"], rec["type"], rec["people"], rec["title"]),
                         ("water_incident", "capsize", 2, "Кобона: опрокидывание лодки, 2 чел."))
        for k in ("900002", "900003"):  # a swimmer, a road accident
            self.assertEqual(rx.incident_extract(items[k]["title"], items[k]["summary"], D("2026-09-23"), "", "", "", "")[1],
                             "not_incident")
        i = items["283454"]  # the RSS text names no place: the article is worth reading
        self.assertEqual(rx.incident_extract(i["title"], i["summary"], D("2026-02-28"), "", "", "", "")[1], "no_place")
        self.assertTrue(rx.news_candidate(i["title"], i["summary"]))
        self.assertFalse([k for k in ("293375", "293367", "293351", "293334", "293335")
                          if rx.news_candidate(items[k]["title"], items[k]["summary"])])

    def test_rescuers_posts(self):
        rec, _ = inc("Сегодня, 3 апреля, дежурная смена поисково-спасательного отряда г. Шлиссельбург получила информацию о "
                     "том, что на оторвавшейся льдине Ладожского озера в районе деревни Леднево находятся люди. Спасатели "
                     "обнаружили на льдине 12 человек и доставили их к берегу.", date="2026-04-03")
        self.assertEqual((rec["title"], rec["comment"]),
                         ("Леднево: отрыв льдины, 12 чел.", "Оторвало льдину с людьми — Леднево; 12 чел.; спасены."))
        # the unit's town and the place they were taken to are not the place of the incident
        rec, _ = inc("Вечером спасатели поисково-спасательного отряда г. Новая Ладога получили сообщение: у двух рыбаков "
                     "заглох мотор лодки у острова Птинов. Лодку отбуксировали, рыбаков доставили в Новую Ладогу.",
                     date="2026-08-15")
        self.assertEqual((rec["kind"], rec["type"], rec["place"], rec["people"]), ("water_incident", "breakdown", "о. Птинов", 2))
        rec, _ = inc("Двое рыбаков провалились под лёд у деревни Кобона, выбрались самостоятельно.", date="2026-01-20")
        self.assertEqual((rec["type"], rec["comment"]), ("fall", "Провал под лёд — Кобона; 2 чел.; выбрались сами."))

    def test_no_place_but_the_unit(self):
        m = next(x for x in rx.parse_tg_page(fx("tg_acclenobl.html"), "acclenobl") if x["id"] == 3869)
        rec, _ = inc(m["text"], date="2026-02-28")
        self.assertEqual((rec["title"], rec["prec"], rec["place"]),
                         ("Ладога, место не указано: поломка техники на льду, 1 чел.", 15000,
                          "юго-запад озера, район ПСО Шлиссельбург"))
        self.assertIn("точка условная", rec["comment"])
        self.assertEqual(inc("На Ладожском озере оторвало льдину с тремя рыбаками, их сняли спасатели.")[1], "no_place")

    def test_not_incidents(self):
        self.assertEqual(inc("Спасатели провели патрулирование водоёмов и напомнили рыбакам у Кобоны о запрете выхода на лёд.")[1],
                         "not_incident")
        self.assertEqual(inc("Весенний лёд таит опасность: спасатели предупреждают рыбаков у Кобоны, что лёд теряет "
                             "прочность и растёт вероятность проваливания под лёд.")[1], "not_incident")
        self.assertEqual(inc("Спасатели оказали помощь собаке: на Новоладожском канале собака провалилась под лёд.")[1],
                         "not_incident")
        self.assertEqual(inc("Мужчина провалился под лёд озера Комсомольское Приозерского района.")[1], "outside")
        self.assertEqual(inc("На Онежском озере оторвало льдину с пятью рыбаками.")[1], "outside")
        rec, _ = inc("Трое рыбаков из Тихвина провалились под лёд на Ладоге неподалёку от деревни Дубно, выбрались сами.")
        self.assertEqual(rec["place"], "Дубно")  # where they came from is not where it happened

    def test_people(self):
        self.assertEqual(rx.people_count("4 марта двое рыбаков оказались на льдине"), 2)
        self.assertEqual(rx.people_count("в 300 метрах от берега мужчина провалился"), 1)
        self.assertEqual(rx.people_count("Квартет на мотособаке провалился под лед"), 4)
        self.assertEqual(rx.people_count("сняли более 80 рыбаков"), 80)
        self.assertIsNone(rx.people_count("рыбаков сняли со льдины"))


# ---------------------------------------------------------------------------------------------------- dedupe

def fishing_rec(**kw):
    rec = {"id": "tg:x/1", "lat": 60.0, "lon": 31.5, "kind": "fishing", "cls": "C", "prec": 2000, "date": "2026-09-20",
           "title": "t", "comment": "c", "src": "Telegram: @damfishspb", "url": "https://t.me/damfishspb/1", "sid": "1",
           "place": "Кобона"}
    rec.update(kw)
    return rec


class Dedupe(unittest.TestCase):
    def setUp(self):
        self.store = fr.Store({}, {}, known(), D("2026-09-24"))

    def test_text_index(self):
        idx = rx.TextIndex()
        text = "Сегодня Волхов выдал по полной, лещи ровные от полутора до двух килограммов, много сходов на фидере"
        idx.add("a", "2026-09-20", text)
        self.assertGreaterEqual(idx.best(text + " Всем удачи", "2026-09-22")[0], 0.6)
        self.assertEqual(idx.best(text, "2026-09-27")[0], 0.0)  # more than 3 days apart
        self.assertFalse([w for e in idx.entries() for w in e["w"] if re.search("[а-я]", w)])  # hashes only
        # names are capitalised and never indexed, not even as hashes (the GitHub copy's state is public)
        name = rx.word_hashes("Драгомир")
        self.assertEqual(name, [])
        self.assertEqual(len(rx.word_hashes("Спасибо Драгомир Горчаг за место, поймал пару лещей")), 4)  # место, поймал, пару, лещей

    def test_rules(self):
        s = self.store
        self.assertEqual(s._reject(fishing_rec(url="https://t.me/rybalka_spb_lenoblasti/26696", src="x")), "in_dataset")
        self.assertEqual(s._reject(fishing_rec(url="https://fisher.spb.ru/news/message.php?messageId=115832", src=rx.PKR_SRC)),
                         "in_dataset")
        self.assertEqual(s._reject(fishing_rec(url="u2", src=rx.PKR_SRC, sid="115832")), "in_dataset")
        self.assertEqual(s._reject(fishing_rec(kind="launch", lat=60.1379, lon=31.6144)), "parking_known")
        self.assertEqual(s.add_post([fishing_rec()], "tg"), 1)
        self.assertEqual(s._reject(fishing_rec(id="tg:x/2", url="u3", lat=60.0005)), "same_place_date")  # ~55 m
        self.assertIsNone(s._reject(fishing_rec(id="tg:x/3", url="u4", lat=60.01)))                      # ~1.1 km
        s.add_post([fishing_rec(id="pkr:1", src=rx.PKR_SRC, url="u5", place="Лаврово", date="2026-09-19")], "pkr")
        agg = fishing_rec(id="tg:novosti_s_vodoemov/9", src=rx.TG_SOURCES["novosti_s_vodoemov"], url="u6", place="Лаврово",
                          lat=59.96, lon=31.52)
        self.assertEqual(s._reject(agg), "aggregator_dup")
        i1 = {"id": "news47:1", "lat": 60.109, "lon": 31.485, "kind": "ice_incident", "date": "2026-03-03", "place": "Леднево",
              "src": "47news.ru", "url": "u7"}
        self.assertEqual(s.add_post([i1], "news47"), 1)
        i2 = dict(i1, id="tg:acclenobl/5", src="TG", url="u8", date="2026-03-04")
        self.assertEqual(s._reject(i2), "same_incident")
        self.assertIsNone(s._reject(dict(i2, date="2026-03-08")))
        # the club's report and its copy in a channel, placed 23 km apart (catalog pin vs the place named in the text)
        club = fishing_rec(id="pkr:115869", src=rx.PKR_SRC, url="u9", place="Креницы", lat=60.13315, lon=32.28498,
                           date="2026-08-26", fish=["Щука", "Окунь"], depth="1–1,5 м", catch="2,5 кг")
        self.assertEqual(s.add_post([club], "pkr"), 1)
        copy = dict(club, id=f"tg:{RSL}/26344", src=rx.TG_SOURCES[RSL], url="u10", place="Сумское / мыс Сумский",
                    lat=60.22193, lon=31.89513)
        self.assertEqual(s._reject(copy), "same_facts")
        self.assertEqual(s._reject(dict(copy, date="2026-08-28")), "same_facts")  # the channel dates it by its post
        self.assertIsNone(s._reject(dict(copy, date="2026-08-31")))
        self.assertIsNone(s._reject(dict(copy, catch="3 кг", depth="")))

    def test_one_post_several_places_and_reposts(self):
        text = ("Сегодня Волхов выдал по полной, лещи ровные от полутора до двух килограммов, "
                "много сходов на фидере у деревни Иссад")
        a = fishing_rec(id="tg:feeder_spb/1", url="https://t.me/feeder_spb/1", lat=60.0608, lon=32.3492)
        b = dict(a, id="tg:feeder_spb/1#p", kind="launch", lat=60.07, lon=32.36)
        self.assertEqual(self.store.add_post([a, b], "tg", text=text, orig="https://vk.com/wall-1_2"), 2)
        c = fishing_rec(id="tg:fishingspb1/7", src=rx.TG_SOURCES["fishingspb1"], url="https://t.me/fishingspb1/7")
        self.assertEqual(self.store.add_post([c], "tg", text=text + " Всем НХНЧ"), 0)                  # the same text
        d = fishing_rec(id="tg:damfishspb/8", url="https://t.me/damfishspb/8", lat=60.2)
        self.assertEqual(self.store.add_post([d], "tg", text="совсем другой текст про окуня на Ладоге сегодня у берега "
                                                             "клевало хорошо", orig="https://vk.ru/wall-1_2/"), 0)  # same source link
        self.assertEqual(self.store.stats["tg"]["repost"], 2)


# -------------------------------------------------------------------------------------------------- pipeline

class Pipeline(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ladoga_reports_test_")
        self.log = []

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_once(self, now, d=None, name="reports", http=None, **kw):
        http = http or FakeHttp(vps_routes())
        kw.setdefault("watch_path", os.path.join(self.dir, "no-watch.json"))
        out = fr.run(d or self.dir, name=name, now=now, http=http, log=self.log.append, **kw)
        with open(os.path.join(d or self.dir, f"{name}.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), out)
        return out, http

    def test_first_run_then_cached(self):
        out, http = self.run_once(at(2026, 9, 24, 7, 15), only={"pkr", "news47"}, since=D("2026-08-01"))
        ids = [r["id"] for r in out["reports"]]
        self.assertEqual(ids, ["pkr:115870", "pkr:115865", "pkr:115832", "pkr:115819"])  # newest first
        self.assertEqual([r["id"] for r in out["incidents"]], ["news47:900001", "news47:283454"])
        self.assertEqual(out["incidents"][1]["place"], "Нижняя Шальдиха")
        self.assertEqual(len(http.hits("fisher.spb.ru")), len(fr.PKR_WATERS))  # one page per water
        self.assertEqual(http.hits("47news.ru/articles/"), ["https://47news.ru/articles/283454/"])  # only when needed
        self.assertEqual((out["v"], out["mode"], out["errors"], out["notices"]), (1, "offseason", {}, []))
        self.assertEqual(out["checked"]["pkr"], "2026-09-24T07:15:00+03:00")
        self.assertEqual(out["next_check"], "2026-09-29T04:15:00+03:00")  # 5 days minus the 3 h slack
        self.assertTrue(all(r["added"] == "2026-09-24" for r in out["reports"] + out["incidents"]))
        self.assertEqual({s["id"] for s in out["sources"]} >= {"pkr", "news47", "tg:acclenobl"}, True)
        # the next day: the forum is not due, the RSS is read, the article is not read again
        out2, http2 = self.run_once(at(2026, 9, 25, 7, 12), only={"pkr", "news47"})
        self.assertEqual(http2.urls, ["https://47news.ru/rss/"])
        self.assertEqual(out2["reports"], out["reports"])
        self.assertEqual(out2["incidents"], out["incidents"])
        self.assertTrue([x for x in self.log if x.startswith("pkr") and "cached" in x])
        # five days later minus the slack: due again
        _, http3 = self.run_once(at(2026, 9, 29, 7, 5), only={"pkr"})
        self.assertEqual(len(http3.hits("fisher.spb.ru")), len(fr.PKR_WATERS))

    def test_season_cadence(self):
        self.assertEqual((fr.season_mode(at(2026, 12, 10)), fr.check_days(at(2026, 12, 10))), ("season", 3))
        self.assertEqual((fr.season_mode(at(2026, 7, 10)), fr.check_days(at(2026, 7, 10))), ("season", 3))
        self.assertEqual((fr.season_mode(at(2026, 5, 10)), fr.check_days(at(2026, 5, 10))), ("offseason", 5))
        st = {"ok": at(2026, 12, 10, 7, 10).timestamp()}
        self.assertFalse(fr.due(st, at(2026, 12, 12, 7, 10), 3, False)[0])
        self.assertTrue(fr.due(st, at(2026, 12, 13, 7, 5), 3, False)[0])       # the timer's random delay is absorbed
        self.assertTrue(fr.due(st, at(2026, 12, 11, 7, 10), 3, True)[0])       # --force
        st_err = {"ok": st["ok"], "try": at(2026, 12, 11, 7, 10).timestamp(), "error": "timeout"}
        self.assertTrue(fr.due(st_err, at(2026, 12, 12, 7, 10), 3, False)[0])  # a failure is retried the next day

    def test_append_only_and_failures(self):
        out, _ = self.run_once(at(2026, 9, 24, 7, 15), only={"pkr", "news47"}, since=D("2026-08-01"))
        # the club page no longer shows the messages, the RSS fails: nothing is lost, the errors are reported
        http = FakeHttp({}, fail={"47news.ru": "HTTP 503 Service Unavailable"})
        out2, _ = self.run_once(at(2026, 10, 1, 7, 15), http=http, only={"pkr", "news47"}, force=True)
        self.assertEqual([r["id"] for r in out2["reports"]], [r["id"] for r in out["reports"]])
        self.assertEqual([r["id"] for r in out2["incidents"]], [r["id"] for r in out["incidents"]])
        self.assertEqual(out2["errors"], {"news47": "HTTP 503 Service Unavailable"})
        self.assertEqual(out2["checked"]["news47"], out["checked"]["news47"])  # the last good read stays
        http = FakeHttp(vps_routes(), fail={"fisher.spb.ru": "URLError: timed out"})
        out3, _ = self.run_once(at(2026, 10, 2, 7, 15), http=http, only={"pkr"}, force=True)
        self.assertIn("pkr", out3["errors"])
        self.assertEqual(len(out3["reports"]), 4)

    def test_known_dataset(self):
        out, _ = self.run_once(at(2026, 9, 24, 7, 15), only={"pkr", "news47"}, known=known(), since=D("2026-08-01"))
        self.assertEqual([r["id"] for r in out["reports"]], ["pkr:115870", "pkr:115865", "pkr:115819"])  # 115832 is on the map
        self.assertEqual([r["id"] for r in out["incidents"]], ["news47:900001"])            # 283454 too
        self.assertTrue([x for x in self.log if "in_dataset" in x])

    def tg_routes(self):
        feeder = tg_page("feeder_spb", [
            (7001, "2026-09-20T06:00:00+00:00", "Сегодня Иссад на Волхове. Лещи от полутора до двух кг, поймал семь штук на "
                                                "фидер, клевало с рассвета до обеда, много сходов.<br/>📱 Автор: Иван Рыболовов, "
                                                "тел. +7 921 123-45-67"),
            (7002, "2026-09-21T06:00:00+00:00", "Розыгрыш призов среди подписчиков!")], older=7000)
        novosti = tg_page("novosti_s_vodoemov", [
            (5101, "2026-09-21T09:00:00+00:00", "20.09.2026<br/>Иссад<br/>Сегодня Иссад на Волхове. Лещи от полутора до двух "
                                                "кг, поймал семь штук на фидер, клевало с рассвета до обеда, много сходов."),
            (5102, "2026-09-21T10:00:00+00:00", '23.03.2026<br/>д.Кошкино<br/>Поймал окуня. <a href="https://fisher.spb.ru/news/'
                                                'message-bycatalog.php?category=5&amp;water=165">источник</a>')])
        return {f"https://t.me/s/{RSL}": fx("tg_rybalka_spb_lenoblasti.html"),
                "https://t.me/s/acclenobl": fx("tg_acclenobl.html"),
                "https://t.me/s/feeder_spb": feeder, "https://t.me/s/novosti_s_vodoemov": novosti}

    def test_telegram_copy_and_relay(self):
        gh = os.path.join(self.dir, "gh")
        tg_out, http = self.run_once(at(2026, 9, 24, 6, 40), d=gh, name="tg", http=FakeHttp(self.tg_routes()),
                                     only={"tg"}, since=D("2026-02-01"), keep_days=120)
        ids = [r["id"] for r in tg_out["reports"]]
        self.assertEqual(sorted(ids), sorted([f"tg:{RSL}/26723", f"tg:{RSL}/26723#p", f"tg:{RSL}/26696", "tg:feeder_spb/7001"]))
        self.assertEqual([r["id"] for r in tg_out["incidents"]], ["tg:acclenobl/3869"])
        self.assertTrue([x for x in self.log if x.startswith("tg") and "repost" in x])  # the aggregator's copy of 7001
        self.assertEqual(tg_out["checked"], {"tg": "2026-09-24T06:40:00+03:00"})
        self.assertEqual(len(http.hits(f"t.me/s/{RSL}")), 2)  # page 0 and one older page
        with open(os.path.join(gh, "tg_state.json"), encoding="utf-8") as f:
            st = json.load(f)
        self.assertEqual(st["tg"]["channels"][RSL]["top"], 26723)
        # a channel with nothing newer than --since still has its newest id remembered
        quiet = os.path.join(self.dir, "quiet")
        self.run_once(at(2026, 9, 24, 6, 40), d=quiet, name="tg", http=FakeHttp(self.tg_routes()), only={"tg"})
        with open(os.path.join(quiet, "tg_state.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["tg"]["channels"]["acclenobl"]["top"], 3869)  # all its posts are from February
        # the next forced run reads one page per channel: the newest posts are already known
        _, http2 = self.run_once(at(2026, 9, 25, 6, 40), d=gh, name="tg", http=FakeHttp(self.tg_routes()), only={"tg"},
                                 force=True)
        self.assertEqual(len(http2.hits(f"t.me/s/{RSL}")), 1)
        # the server merges the copy on every run; the static dataset already has 26696
        relay = "https://raw.githubusercontent.com/ogrebete-max/ladoga-fishing-map/live-tg/tg.json"
        routes = dict(vps_routes(), **{relay: fx_file(os.path.join(gh, "tg.json"))})
        vps, http3 = self.run_once(at(2026, 9, 24, 7, 15), http=FakeHttp(routes), relay_tg=relay, known=known(),
                                   only={"tg", "news47"})
        self.assertEqual(http3.hits("t.me"), [])
        # 26696 is in the static dataset, the parking of 26723 is 20 m from a known one
        self.assertEqual(sorted(r["id"] for r in vps["reports"]), sorted([f"tg:{RSL}/26723", "tg:feeder_spb/7001"]))
        self.assertTrue([x for x in self.log if x.startswith("tg") and "parking_known 1" in x and "in_dataset 1" in x])
        self.assertIn("tg:acclenobl/3869", [r["id"] for r in vps["incidents"]])
        self.assertEqual(vps["checked"]["tg"], "2026-09-25T06:40:00+03:00")  # when the copy last read Telegram
        self.assertTrue(all(r["added"] == "2026-09-24" for r in vps["reports"]))
        # a broken copy: an error, nothing lost
        vps2, _ = self.run_once(at(2026, 9, 25, 7, 15), http=FakeHttp(dict(vps_routes(), **{relay: b"<html>"})),
                                relay_tg=relay, only={"tg"})
        self.assertIn("relay", vps2["errors"]["tg"])
        self.assertEqual(len(vps2["reports"]), len(vps["reports"]))

    def test_failed_page_is_read_again(self):
        gh = os.path.join(self.dir, "gh")
        routes = self.tg_routes()
        http = FakeHttp(routes, fail={f"s/{RSL}?before=": "URLError: timed out"})
        out, _ = self.run_once(at(2026, 9, 24, 6, 40), d=gh, name="tg", http=http, only={"tg"}, since=D("2026-02-01"))
        self.assertIn(f"{RSL}: URLError: timed out", out["errors"]["tg"])
        self.assertNotIn("more than", out["errors"]["tg"])
        with open(os.path.join(gh, "tg_state.json"), encoding="utf-8") as f:
            self.assertNotIn("top", json.load(f)["tg"]["channels"][RSL])  # not advanced past the unread posts
        n = len(out["reports"])
        out2, http2 = self.run_once(at(2026, 9, 25, 6, 40), d=gh, name="tg", http=FakeHttp(routes), only={"tg"},
                                    since=D("2026-02-01"))
        self.assertEqual(out2["errors"], {})
        self.assertEqual(len(out2["reports"]), n)  # read again, nothing twice
        self.assertTrue([x for x in self.log if "have" in x])

    def test_privacy(self):
        gh = os.path.join(self.dir, "gh")
        self.run_once(at(2026, 9, 24, 6, 40), d=gh, name="tg", http=FakeHttp(self.tg_routes()), only={"tg"},
                      since=D("2026-02-01"))
        self.run_once(at(2026, 9, 24, 7, 15), only={"pkr", "news47"})
        blobs = []
        for d, n in ((gh, "tg"), (self.dir, "reports")):
            for f in (f"{n}.json", f"{n}_state.json"):
                with open(os.path.join(d, f), encoding="utf-8") as fh:
                    blobs.append(fh.read())
        for bad in (FAKE_AUTHOR, "Иван", "Рыболовов", "921", "u=1", "profile", "Никола"):
            self.assertFalse([b for b in blobs if bad in b], bad)
        # comments are templates: no long piece of a post is copied
        page = rx.parse_pkr_page(fx("pkr_5_165_p0.html"))
        texts = [m["text"] for m in page["messages"]]
        out = json.loads(blobs[2])
        for r in out["reports"] + out["incidents"]:
            for t in texts:
                for i in range(0, max(1, len(t) - 30), 10):
                    self.assertNotIn(t[i:i + 30], r["comment"])

    def test_notices(self):
        watch = os.path.join(FIX, "watch_test.json")
        routes = {"https://sztu.example.test/news/": fx("notices_list.html"), "https://vb.example.test/rss/": fx("notices_rss.xml")}
        out, _ = self.run_once(at(2026, 9, 24, 7, 15), http=FakeHttp(routes), only={"notices"}, watch_path=watch)
        self.assertEqual([(n["id"].split(":")[0], n.get("date"), n["topic"]) for n in out["notices"]],
                         [("sztu", "2026-09-24", "rules"), ("vb", "2026-09-22", "navigation"), ("sztu", "2026-09-20", "rules")])
        n = out["notices"][0]
        self.assertEqual((n["title"], n["url"], n["src"], n["added"]),
                         ("Запрет на вылов судака в Ладожском озере с 1 октября", "https://sztu.example.test/news/1001/",
                          "Росрыболовство, Северо-Западное ТУ — новости (тест)", "2026-09-24"))
        self.assertEqual(out["checked"]["notices"], "2026-09-24T07:15:00+03:00")
        self.assertIn("notices:sztu", {s["id"] for s in out["sources"]})
        # every target has its own interval: nothing is due the next day, the feed is due after 3 days
        _, http = self.run_once(at(2026, 9, 25, 7, 15), http=FakeHttp(routes), only={"notices"}, watch_path=watch)
        self.assertEqual(http.urls, [])
        out3, http = self.run_once(at(2026, 9, 27, 7, 15), http=FakeHttp(routes), only={"notices"}, watch_path=watch)
        self.assertEqual(http.urls, ["https://vb.example.test/rss/"])
        self.assertEqual(len(out3["notices"]), 3)  # nothing twice
        # no watch.json: skipped quietly
        out4, _ = self.run_once(at(2026, 9, 28, 7, 15), http=FakeHttp({}), only={"notices"})
        self.assertEqual(out4["errors"], {})
        self.assertTrue([x for x in self.log if "no watch.json" in x])

    def test_notices_are_capped(self):
        store = fr.Store({"notices": [{"id": f"x:{i}", "date": f"2026-0{1 + i % 9}-1{i % 10}", "title": "t", "url": f"u{i}"}
                                      for i in range(80)]}, {}, fr.Known(), D("2026-09-24"))
        ctx = fr.Ctx(at(2026, 9, 24), {}, FakeHttp({}), store, False, 1e12, D("2026-08-25"), self.log.append)
        fr.collect_notices(ctx, [])
        self.assertEqual(len(store.notices), fr.KEEP_NOTICES)
        self.assertEqual(store.notices[0]["date"], "2026-09-18")

    def test_keep_days_and_lock(self):
        store = fr.Store({"reports": [fishing_rec(id="a", date="2026-01-01", added="2026-05-01"),
                                      fishing_rec(id="b", date="2026-01-01", added="2026-09-01"),
                                      fishing_rec(id="c", date="2026-09-01", added="2026-09-02")]}, {}, fr.Known(), D("2026-09-24"))
        store.prune(120)  # what the copy found in the last 120 days, whatever the report's own date
        self.assertEqual([r["id"] for r in store.reports], ["b", "c"])
        lock = fr._lock(self.dir, "reports")
        try:
            with self.assertRaises(fr.LockBusy):
                fr._lock(self.dir, "reports")
        finally:
            lock.close()

    def test_command_line(self):
        import contextlib
        import io
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(fr.main(["--out", self.dir, "--only", "notices", "--watch", os.path.join(self.dir, "none.json")]), 0)
            self.assertEqual(fr.main(["--out", self.dir, "--only", "forum"]), 2)
            self.assertEqual(fr.main(["--out", self.dir, "--since", "yesterday"]), 2)
        self.assertIn("no watch.json", out.getvalue())
        with open(os.path.join(self.dir, "reports.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["reports"], [])


def fx_file(path):
    with open(path, "rb") as f:
        return f.read()


if __name__ == "__main__":
    unittest.main()
