# live.json — живые данные для «Ладога · рыболовная карта»

`fetch_live.py` раз в час (systemd‑таймер на нашем сервере) собирает свежие официальные и открытые данные, которые
браузер сам взять не может (нет CORS, только http, сайты госорганов), и пишет один компактный файл `live.json`:
около 10 КБ летом, до 20 КБ зимой (обзор льда, таблица постов, шторм‑прогноз и несколько предупреждений; проверено тестом).
Только стандартная библиотека Python 3.8+, без ключей и входов.

## Что собирает

| Блок | Источник | Как часто | Что берём |
|---|---|---|---|
| `mchs` | ГУ МЧС по ЛО, RSS «Оперативная информация»: 10 записей, в `yandex:full-text` полный текст | каждый запуск | последний «Оперативный ежедневный прогноз ЧС»: обзор ледовой обстановки на Ладоге (и толщина льда у названных мест с координатами), шторм‑прогноз по районам озера, фразы гидрологии про Ладогу, Неву, Волхов, Свирь, Сясь; предупреждения и экстренные предупреждения за 48 ч (или ещё действующие) с окном действия |
| `level.mchs` | тот же прогноз | — | строка «Уровень р. Нева – ст. Петрокрепость – 328 см БС, ниже неблагоприятной отметки 330 см БС…»; зимой и весной — таблица «Сведения об уровнях воды (в см над «0» поста)» |
| `level.grealm` | G‑REALM (NASA/USDA), Ладога 000396, 10‑дневный ряд | раз в 6 ч, условный GET (ETag) | последняя высота, аномалия к норме месяца 1993–2020, отклонение от среднего 1993–2020, 12 последних значений |
| `level.volgobalt` | ФБУ «Администрация «Волго‑Балт»: «Консультация об ожидаемых уровнях и глубинах по опорным постам» (на месяц, по декадам) | раз в 12 ч | уровни Сясьские Рядки, Свирица, Шлиссельбург (м БС) и ожидаемые глубины Ст. Ладога – устье, Свирица – Вознесенье, СПб – Шлиссельбург на текущую декаду |
| `level.meteonw` | Северо‑Западное УГМС, `lo_levelsd.php` (только http) | раз в 3 ч | фактический уровень у Петрокрепости и на 6 постах Невы и залива |
| `water_temp` | MUR SST v4.1 через NOAA ERDDAP | раз в 6 ч, 3 запроса | температура открытой воды в 3 точках и неделей раньше; подо льдом — `under_ice: true` вместо −1,8 °C |
| `ice_season` | NOAA IMS 4 км | раз в сутки, ноябрь–май | лёд или вода по 5 секторам: Волховская и Свирская губы, бухта Петрокрепость, юг открытого озера, центр |

Обычный ежечасный запуск — 1 запрос (RSS) и доля секунды; полный — 8 запросов и около 10 с, около 50 запросов в сутки
на все источники. Не чаще 1 запроса в секунду на хост, User‑Agent `ladoga-fishing-map/1.0 (+https://195.133.61.136/ladoga/)`,
проверка TLS‑сертификатов всегда включена.

## Как ведёт себя при сбоях

- Каждый блок собирается отдельно: упавший источник не ломает остальные.
- Не ответил источник — в `live.json` остаётся последний удачный блок со своей датой, `meta.blocks.<блок>.status = "stale"`,
  причина — в `meta.errors`. Следующая попытка — в следующий час.
- Подблоки прогноза МЧС берутся из самого свежего прогноза, где они есть: строка про уровень бывает не каждый день
  (в прогнозе на 24.09 есть, на 22 и 23.09 нет), обзор льда — только в сезон. Старые выбрасываются: обзор льда через 30 дней,
  уровни через 14, шторм‑прогноз через 6 ч после конца действия, предупреждение через 48 ч после выхода или по окончании
  срока, если он позже.
- Страница записи МЧС скачивается, только если в RSS нет полного текста новой записи или он оборван: таймаут 20 с,
  2 повтора с паузой, проверка полноты (`</article>`, после гидрологии есть раздел «4.»), не больше 2 страниц за запуск.
- Бюджет запуска — 110 с. `live.json` пишется атомарно (временный файл + `os.replace`), прошлая версия — `live.prev.json`,
  ETag, id записей и время попыток — `state.json`. Код выхода 0, если `live.json` записан.

## Формат `live.json`

Время — ISO 8601 с `+03:00`, даты — `YYYY-MM-DD`. Тексты МЧС, УГМС и Волго‑Балта — как есть: схлопнуты пробелы, длинные
обрезаны с «…», без пересказа. Это официальные сообщения (ГК РФ ст. 1259 п. 6); ссылка и дата всегда рядом.

- `schema` — версия формата (1); `generated` — время сборки.
- `level`
  - `depth_correction` — поправка к глубинам карт, м (минус — воды меньше): `m`, `source` (`volgobalt` или `grealm`),
    `from`, `note`, `date`. По Волго‑Балту: ожидаемый уровень у Сясьских Рядков на текущую декаду минус нуль карт 5,10 м БС.
    Если консультации нет или она старше двух недель после своего месяца — по G‑REALM.
  - `depth_correction_grealm` — то же по G‑REALM (уровень минус средний за 1993–2020), для сравнения.
  - `grealm` — `date`, `height_m` (к опорному уровню Jason‑2), `anomaly_m` и `month_norm_m` (норма этого месяца за
    1993–2020: «на 0,71 м ниже нормы сентября»), `longterm_mean_m`, `depth_correction_m`, `ice_flag`, `preliminary`
    (оперативные данные IGDR, могут уточниться), `series` + `series_fields` (12 последних: дата, высота, аномалия, флаг льда),
    `month_norms_m` (12 норм). Флаг льда у этого продукта календарный (февраль–май каждый год), поэтому такие значения
    оставлены в нормах: без них норм февраля–мая просто нет.
  - `volgobalt` — `period` (месяц), `decade` (1–3), `decade_from`, `decade_to`, `period_status` (`current`, `ahead`, `past`),
    `posts[]` (`id`, `name`, `level_bs_m` на текущую декаду, `values_bs_m` по декадам, `project_level_bs_m`),
    `depths[]` (`expected_cm`, `values_cm`, `guaranteed_cm`), `notes`. На сайте «Сяськие Рядки» — исходное имя в `name_src`.
  - `mchs` — `text` (строка про уровень как есть), `sentence` (`text`, `items[]`: `post`, `cm`, `bs`, `relation`, `mark`,
    `mark_cm`; `outlook[]`),
    `table` (`time`, `posts[]`: `post`, `zero_m_bs`, `level_cm`, `change_cm`, `norm_cm`, `unfav_cm`, `danger_cm`, `ice`,
    `est` — значение со «*», `lake` — пост на озере и каналах), `petrokrepost` (`cm_bs`, `date`, `from`, `mark_cm_bs`
    или `norm_cm_bs`). В таблице — только бассейн Ладоги, без Луги, Оредежа, Нарвы и Тосны.
  - `meteonw` — `time`, `petrokrepost_cm`, `posts` (`[название, см над нулём поста]`), `terms` — условия УГМС: ссылка
    обязательна, не для коммерции и не для планирования рискованных мероприятий. Оговорку показывать.
- `mchs`
  - `forecast` — какой прогноз прочитан: `id`, `title`, `date` (на какой день), `issued`, `url`.
  - `hydro` — `text[]`: фразы раздела «3. Гидрологическая обстановка» про Ладогу, Неву, Волхов, Свирь, Сясь и их продолжения
    про уровень.
  - `ice_review` — `text` (наблюдения), `forecast` («Прогноз до …»), `obs_date` (дата наблюдений; `date` — день, на который
    вышел прогноз), `sat_date`, `cover_pct`, `places[]`
    (`id`, `name`, `lat`, `lon`, `cm[]` из `min`, `max`, `at`, `label` вида «40–45 см», `text` — фраза обзора об этом месте).
    Словарь мест — `ICE_PLACES` в коде.
  - `storm` — `valid` («от 21:00 13 марта 2026 г. до 21:00 14 марта 2026 г.»), `valid_from`, `valid_to`, `text` (весь блок
    как есть), и его части: `wind`, `wind_ms`, `gusts_ms`, `waves` (номер района озера → текст), `precip`, `visibility`,
    `air_temp`. Районы 1–5 в прогнозе не расшифрованы.
  - `warnings[]` — `id`, `level` (`emergency` — «ЭКСТРЕННОЕ»), `title`, `published`, `text` (суть явления, не больше
    600 знаков), `valid_from`, `valid_to` (если текст их даёт; по дням — с 00:00 до 24:00), `ice` (фраза про лёд и отрыв
    льдин, если есть), `url`.
  - У каждого подблока свои `date`, `issued` и `url`.
- `water_temp` — `label: "открытое озеро"`; главная точка (Волховская губа, 60,2° с. ш. 32,25° в. д.) продублирована
  наверху: `date`, `open_lake_c`, `under_ice`, `week_ago_c`, `week_ago_date`; все точки — `points[]` (`id`, `name`, `lat`,
  `lon`, `date`, `temp_c`, `under_ice`, `prev_date`, `prev_c`, `change_c` за 7 дней).
- `ice_season` — `date`, `sectors` (`volkhov`, `svir`, `petrokrepost`, `south_open`, `center`: `state` — `ice`, `water`
  или `mixed`, счётчики клеток), `file`. В июне–октябре `null`.
- `meta` — `generated`, `blocks` (блок → `status`, `fetched_at`, `source_date`, `url`), `errors` (блок → `at`, `error`),
  `requests`, `run_s`. Статусы: `ok`; `not_modified` (304); `cached` — ещё не пора идти к источнику; `partial` — часть не
  собрана; `stale` — сбой, оставлен прошлый блок; `error` — сбой, прошлого нет; `off_season`.

## Пример: настоящий запуск 24.09.2026, 10:27, с `--force`

Запуск с рабочего ПК во временную папку (путь в журнале сокращён); колонка имён — как в текущей версии.

```
mchs             ok       rss 10 items, forecast 5831130 (2026-09-24), level sentence yes, table 0 posts, ice review no, storm no, warnings 1, pages fetched 0 (2.2 s)
level.grealm     ok       2026-09-12 -1.25 m, anomaly -0.71 vs month norm, depth correction -0.74 (0.9 s)
level.volgobalt  ok       2026-09 decade 3 (current): Сясьские Рядки 3.70 m БС (project 4.00), 3 posts, 3 depth sections (4.6 s)
level.meteonw    ok       2026-09-24T09:00:00+03:00 Петрокрепость 355 cm, 7 posts (3.0 s)
water_temp       ok       volkhov 2026-09-22 13.4 °C (7 d: -1.2), 3 points (3.5 s)
ice_season       ok       2026-09-23 volkhov water, svir water, petrokrepost water, south_open water, center water (1.4 s)
wrote …/live_final/live.json: 10.3 KB, 8 requests, 15.5 s, errors: none
```

```json
{
  "schema": 1,
  "generated": "2026-09-24T10:27:18+03:00",
  "level": {
    "mchs": {
      "text": "Уровень р. Нева – ст. Петрокрепость – 328 см БС, ниже неблагоприятной отметки 330 см БС, при которой нарушается нормальная деятельность судоходства (низкая межень).",
      "sentence": {
        "date": "2026-09-24",
        "issued": "2026-09-23T16:22:00+03:00",
        "url": "https://47.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/5831130",
        "text": "Уровень р. Нева – ст. Петрокрепость – 328 см БС, ниже неблагоприятной отметки 330 см БС, при которой нарушается нормальная деятельность судоходства (низкая межень).",
        "items": [
          {
            "post": "Нева – Петрокрепость",
            "cm": 328,
            "bs": true,
            "relation": "ниже",
            "mark": "неблагоприятной",
            "mark_cm": 330
          }
        ],
        "outlook": ["22 сентября – 28 сентября уровень воды будет колебаться в районе неблагоприятной отметки."]
      },
      "table": null,
      "source": "ГУ МЧС России по Ленинградской области по данным ФГБУ «Северо-Западное УГМС»",
      "petrokrepost": {
        "cm_bs": 328,
        "date": "2026-09-23",
        "from": "sentence",
        "mark": "неблагоприятной",
        "mark_cm_bs": 330
      }
    },
    "grealm": {
      "date": "2026-09-12",
      "height_m": -1.25,
      "mission": "SEN6A",
      "ice_flag": false,
      "preliminary": true,
      "month_norm_m": -0.54,
      "anomaly_m": -0.71,
      "longterm_mean_m": -0.515,
      "depth_correction_m": -0.74,
      "norm_period": "1993–2020",
      "series_fields": ["date", "height_m", "anomaly_m", "ice_flag"],
      "series": [
        ["2026-05-26", -0.98, -0.7, 1],
        ["2026-06-05", -1.05, -0.78, 0],
        ["2026-06-14", -1.13, -0.86, 0],
        ["2026-06-24", -1.13, -0.86, 0],
        ["2026-07-04", -1.1, -0.78, 0],
        ["2026-07-14", -1.13, -0.81, 0],
        ["2026-07-24", -1.17, -0.85, 0],
        ["2026-08-03", -1.2, -0.79, 0],
        ["2026-08-13", -1.22, -0.81, 0],
        ["2026-08-23", -1.14, -0.73, 0],
        ["2026-09-02", -1.32, -0.78, 0],
        ["2026-09-12", -1.25, -0.71, 0]
      ],
      "month_norms_m": [-0.64, -0.68, -0.6, -0.42, -0.28, -0.27, -0.32, -0.41, -0.54, -0.65, -0.69, -0.69],
      "n_values": 1293,
      "height_egm2008_m": 3.81,
      "source": "G-REALM (NASA/USDA), спутниковая альтиметрия, 10-дневный ряд",
      "url": "https://earth.gsfc.nasa.gov/gwm/lake/000396",
      "data_url": "https://earth.gsfc.nasa.gov/gwm/timeseries/lake000396.10d.2.txt"
    },
    "volgobalt": {
      "title": "Консультация об ожидаемых уровнях и глубинах по опорным постам на сентябрь 2026 года",
      "period": "2026-09",
      "decades": [["2026-09-01", "2026-09-10"], ["2026-09-11", "2026-09-20"], ["2026-09-21", "2026-09-30"]],
      "posts": [
        {
          "name": "Сясьские Рядки",
          "project_level_bs_m": 4.0,
          "values_bs_m": [3.8, 3.75, 3.7],
          "id": "syasskie_ryadki",
          "name_src": "Сяськие Рядки",
          "lake": true,
          "level_bs_m": 3.7
        },
        {
          "name": "Шлиссельбург",
          "project_level_bs_m": 3.15,
          "values_bs_m": [2.8, 2.75, 2.7],
          "id": "shlisselburg",
          "level_bs_m": 2.7
        },
        {
          "name": "Свирица",
          "project_level_bs_m": 4.1,
          "values_bs_m": [3.9, 3.85, 3.8],
          "id": "svirica",
          "lake": true,
          "level_bs_m": 3.8
        }
      ],
      "depths": [
        {"name": "С-Петербург-Шлиссельбург", "guaranteed_cm": 400, "values_cm": [365, 360, 355], "expected_cm": 355},
        {"name": "Свирица-Вознесенье", "guaranteed_cm": 400, "values_cm": [380, 375, 370], "expected_cm": 370},
        {"name": "Ст.Ладога-Устье", "guaranteed_cm": 350, "values_cm": [320, 315, 310], "expected_cm": 310}
      ],
      "notes": [
        "* - Глубина на порогах шлюзов № 1 - № 6 - 400 см.",
        "Возможны изменения уровней воды и соответственно глубин, связанные с ветровым воздействием."
      ],
      "period_status": "current",
      "decade": 3,
      "decade_from": "2026-09-21",
      "decade_to": "2026-09-30",
      "source": "ФБУ «Администрация «Волго-Балт», консультация об ожидаемых уровнях и глубинах по опорным постам",
      "url": "https://volgo-balt.ru/activity/putevaya-informatsiya/konsultatsiya-ob-ozhidaemykh-glubinakh-s-uchetom-prognozov-urovney-po-opornym-postam/"
    },
    "meteonw": {
      "time": "2026-09-24T09:00:00+03:00",
      "posts_fields": ["name", "cm"],
      "posts": [
        ["Горный институт", 48],
        ["Кронштадтский футшток", 39],
        ["Н. Порт", 47],
        ["Обуховский завод", 77],
        ["Порт Выборг", 35],
        ["г.Петрокрепость", 355],
        ["п. Шепелево", 36]
      ],
      "petrokrepost_cm": 355,
      "source": "ФГБУ «Северо-Западное УГМС», фактический уровень воды",
      "url": "http://www.meteo.nw.ru/weather/lo_levelsd.php",
      "terms": "При использовании материалов ссылка обязательна; не для коммерческого использования и не для планирования мероприятий, связанных с риском"
    },
    "depth_correction": {
      "m": -1.4,
      "level_bs_m": 3.7,
      "datum_bs_m": 5.1,
      "source": "volgobalt",
      "from": "Волго-Балт, Сясьские Рядки",
      "note": "ожидаемый уровень 3,70 м БС на III декаду (21.09–30.09.2026) по консультации Волго-Балта минус нуль карт 5,10 м БС",
      "date": "2026-09-21",
      "valid_to": "2026-09-30"
    },
    "depth_correction_grealm": {
      "m": -0.74,
      "source": "grealm",
      "from": "G-REALM",
      "note": "спутниковый уровень минус средний за 1993–2020; глубины карт — от среднего многолетнего уровня",
      "date": "2026-09-12"
    }
  },
  "mchs": {
    "forecast": {
      "id": 5831130,
      "title": "Оперативный ежедневный прогноз ЧС на 24 сентября 2026 года",
      "date": "2026-09-24",
      "issued": "2026-09-23T16:22:00+03:00",
      "url": "https://47.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/5831130"
    },
    "hydro": {
      "date": "2026-09-24",
      "issued": "2026-09-23T16:22:00+03:00",
      "url": "https://47.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/5831130",
      "text": [
        "Уровень р. Нева – ст. Петрокрепость – 328 см БС, ниже неблагоприятной отметки 330 см БС, при которой нарушается нормальная деятельность судоходства (низкая межень).",
        "22 сентября – 28 сентября уровень воды будет колебаться в районе неблагоприятной отметки."
      ]
    },
    "ice_review": null,
    "storm": null,
    "warnings": [
      {
        "id": 5831131,
        "level": "warning",
        "title": "ПРЕДУПРЕЖДЕНИЕ О НЕБЛАГОПРИЯТНЫХ МЕТЕОРОЛОГИЧЕСКИХ ЯВЛЕНИЯХ",
        "published": "2026-09-23T16:25:00+03:00",
        "text": "Согласно прогнозу ФГБУ \"Северо-Западное УГМС\" от 23.09.2026: 24 сентября Дожди, местами сильные.",
        "valid_from": "2026-09-24T00:00:00+03:00",
        "valid_to": "2026-09-25T00:00:00+03:00",
        "url": "https://47.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/5831131"
      }
    ],
    "source": "ГУ МЧС России по Ленинградской области по данным ФГБУ «Северо-Западное УГМС»",
    "url": "https://47.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya"
  },
  "water_temp": {
    "label": "открытое озеро",
    "date": "2026-09-22",
    "open_lake_c": 13.4,
    "under_ice": false,
    "week_ago_c": 14.6,
    "week_ago_date": "2026-09-15",
    "points": [
      {
        "id": "volkhov",
        "name": "Волховская губа, открытая часть",
        "lat": 60.2,
        "lon": 32.25,
        "date": "2026-09-22",
        "temp_c": 13.4,
        "under_ice": false,
        "prev_date": "2026-09-15",
        "prev_c": 14.6,
        "prev_under_ice": false,
        "change_c": -1.2
      },
      {
        "id": "petrokrepost",
        "name": "юго-запад, бухта Петрокрепость",
        "lat": 60.1,
        "lon": 31.3,
        "date": "2026-09-22",
        "temp_c": 13.3,
        "under_ice": false,
        "prev_date": "2026-09-15",
        "prev_c": 14.7,
        "prev_under_ice": false,
        "change_c": -1.4
      },
      {
        "id": "svir",
        "name": "вход в Свирскую губу",
        "lat": 60.6,
        "lon": 32.7,
        "date": "2026-09-22",
        "temp_c": 13.8,
        "under_ice": false,
        "prev_date": "2026-09-15",
        "prev_c": 15.3,
        "prev_under_ice": false,
        "change_c": -1.5
      }
    ],
    "source": "MUR SST v4.1 (NASA JPL), NOAA CoastWatch ERDDAP; маска озера у MUR грубая — южные губы считаются сушей, поэтому точки в открытой части",
    "url": "https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.html"
  },
  "ice_season": {
    "date": "2026-09-23",
    "sectors": {
      "volkhov": {"name": "Волховская губа", "state": "water", "ice": 0, "water": 6},
      "svir": {"name": "Свирская губа", "state": "water", "ice": 0, "water": 6},
      "petrokrepost": {"name": "бухта Петрокрепость", "state": "water", "ice": 0, "water": 5},
      "south_open": {"name": "юг открытого озера", "state": "water", "ice": 0, "water": 6},
      "center": {"name": "центр озера", "state": "water", "ice": 0, "water": 4}
    },
    "file": "ims2026266_00UTC_4km_v1.3.asc.gz",
    "source": "NOAA/NSIDC IMS 4 км (G02156): лёд или вода по клеткам 4×4 км; разводья и трещины не видит",
    "url": "https://nsidc.org/data/g02156/versions/1"
  },
  "meta": {
    "generated": "2026-09-24T10:27:18+03:00",
    "blocks": {
      "mchs": {
        "status": "ok",
        "fetched_at": "2026-09-24T10:27:18+03:00",
        "source_date": "2026-09-24",
        "url": "https://47.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/rss"
      },
      "level.grealm": {
        "status": "ok",
        "fetched_at": "2026-09-24T10:27:18+03:00",
        "source_date": "2026-09-12",
        "url": "https://earth.gsfc.nasa.gov/gwm/timeseries/lake000396.10d.2.txt"
      },
      "level.volgobalt": {
        "status": "ok",
        "fetched_at": "2026-09-24T10:27:18+03:00",
        "source_date": "2026-09-21",
        "url": "https://volgo-balt.ru/activity/putevaya-informatsiya/konsultatsiya-ob-ozhidaemykh-glubinakh-s-uchetom-prognozov-urovney-po-opornym-postam/"
      },
      "level.meteonw": {
        "status": "ok",
        "fetched_at": "2026-09-24T10:27:18+03:00",
        "source_date": "2026-09-24T09:00:00+03:00",
        "url": "http://www.meteo.nw.ru/weather/lo_levelsd.php"
      },
      "water_temp": {
        "status": "ok",
        "fetched_at": "2026-09-24T10:27:18+03:00",
        "source_date": "2026-09-22",
        "url": "https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41"
      },
      "ice_season": {
        "status": "ok",
        "fetched_at": "2026-09-24T10:27:18+03:00",
        "source_date": "2026-09-23",
        "url": "https://noaadata.apps.nsidc.org/NOAA/G02156/4km/2026/ims2026266_00UTC_4km_v1.3.asc.gz"
      }
    },
    "errors": {},
    "requests": 8,
    "run_s": 15.5,
    "collector": "scripts/live/fetch_live.py"
  }
}
```

Обычный запуск сразу после него: 1 запрос (RSS), остальные блоки `cached`, `ice_season: null` — сентябрь.

## Запуск и тесты

```bash
python3 scripts/live/fetch_live.py --out /tmp/live            # как по таймеру
python3 scripts/live/fetch_live.py --out /tmp/live --force    # всё сразу, IMS и летом
python3 scripts/live/fetch_live.py --out /tmp/live --only mchs,level
cd scripts/live && python3 -m unittest -v test_fetch_live      # офлайн, по fixtures/
```

`fixtures/` — урезанные сохранённые ответы источников: RSS МЧС 23.09.2026 (летняя строка уровня, 4 предупреждения),
прогноз 14.03.2026 (обзор льда, таблица постов, шторм‑прогноз), обзор льда 15.03.2013 (другая грамматика), ряд G‑REALM,
MUR летом и подо льдом, страница УГМС, консультация Волго‑Балта, строки сетки IMS за 20.01 и 23.09.2026.

## Установка на сервер

Код приезжает тем же частичным клоном, что и сайт. Данные лежат вне `releases/`, выкладка сайта их не трогает.

```bash
git -C /var/www/ladoga/src sparse-checkout set site scripts/live
id ladoga-live >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ladoga-live
install -d -o ladoga-live -g ladoga-live -m 755 /var/www/ladoga/live
install -m 644 /var/www/ladoga/src/scripts/live/ladoga-live.service /var/www/ladoga/src/scripts/live/ladoga-live.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now ladoga-live.timer
systemctl start ladoga-live.service         # первый сбор сразу, около 10 с
journalctl -u ladoga-live.service -n 20     # строка на блок
```

В каждом новом релизе сайта — в `deploy_vps.sh` после `rsync`, до переключения `current`:

```bash
ln -sfn /var/www/ladoga/live/live.json "$BASE/releases/$STAMP/data/live.json"
```

Caddy отдаёт симлинк как файл. Для `/ladoga/data/live.json` нужны `Cache-Control: no-cache` (файл меняется каждый час) и
`Access-Control-Allow-Origin: *` (его читает копия на GitHub Pages). Сайт берёт сначала сеть, при ошибке — копию из кэша
service worker; свежесть подписывает по `date` и `issued` каждого блока.

Служба — `oneshot` от пользователя `ladoga-live`, пишет только в `/var/www/ladoga/live` (`ProtectSystem=strict`),
`Nice=10`, `MemoryMax=150M`, `TimeoutStartSec=180`. Таймер — раз в час плюс до 5 мин случайной задержки. Память — десятки МБ:
файл IMS разжимается потоком, читаются только 15 нужных строк из 6144.

## Оговорки

- **Поправка глубин по Волго‑Балту и по G‑REALM расходятся почти вдвое**: 24.09 −1,40 м (3,70 − 5,10 м БС) против −0,74 м.
  Часть разницы — в нуле карт. По таблице МЧС норма марта у поста С.Л.К.–Сясьские Рядки 4,63 м БС, у Н.Л.К.–Свирица
  4,80 м БС, то есть средний уровень на этих постах около 4,7–4,9 м БС, ниже 5,10. Прежде чем ставить в навигатор −1,4 м,
  стоит сверить нуль глубин по листам карт.
- МЧС и Волго‑Балт не отдают ETag и Last-Modified: RSS каждый час скачивается целиком (около 200 КБ, со сжатием меньше).
  G‑REALM отвечает 304.
- Сертификаты 24.09.2026: 47.mchs.gov.ru — GlobalSign; volgo-balt.ru, NASA и NSIDC — Let's Encrypt (цепочка до
  ISRG Root X1); NOAA CoastWatch — DigiCert. Всё проверяется штатным хранилищем. Если цепочку поменяют и проверка сломается,
  в журнале будет «TLS certificate verification failed … (verification stays on)»: обновить `ca-certificates`, проверку
  не отключать. meteo.nw.ru — только http.
- Проверено с домашнего ПК через локальный прокси. С российского VPS сайты МЧС и УГМС должны открываться надёжнее.
- Обзор льда проверен на двух образцах (14.03.2026 и 15.03.2013). Будет ли он в ледостав, в декабре–январе, и в каком
  виде — станет видно первой зимой. Места не из словаря в `places` не попадут, но останутся в `text`.
- MUR: маска озера грубая, южные губы в ней — суша, поэтому точки в открытой части. IMS не видит разводий и трещин:
  годится только для «сезон или не сезон».
