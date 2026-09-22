import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const CHANNEL = "rybalka_spb_lenoblasti";
const SEARCH_TERMS = [
  "Креницы",
  "Новая Ладога",
  "Дубно",
  "Лигово",
  "Птинов",
  "Варецкие",
  "Вороново",
  "Волховская губа",
  "река Волхов",
  "южный берег Ладога",
];
const USER_AGENT = "Mozilla/5.0 (compatible; public-research/1.0; +https://t.me/)";
const CENTER = [60.1037113, 32.2939775];

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371.0088;
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseDate(text) {
  const match = text.match(/(?:^|\n)(\d{1,2})[.-](\d{1,2})[.-](\d{2,4})(?:\s|$)/);
  if (!match) return null;
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  return `${year}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function titleCase(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function fishFromText(text) {
  const aliases = new Map([
    ["судак", "Судак"],
    ["щука", "Щука"],
    ["окунь", "Окунь"],
    ["плотва", "Плотва"],
    ["лещ", "Лещ"],
    ["подлещик", "Подлещик"],
    ["густера", "Густера"],
    ["язь", "Язь"],
    ["линь", "Линь"],
    ["сом", "Сом"],
    ["карась", "Карась"],
    ["карп", "Карп"],
    ["налим", "Налим"],
    ["краснопёрка", "Краснопёрка"],
    ["красноперка", "Краснопёрка"],
    ["ёрш", "Ёрш"],
    ["ерш", "Ёрш"],
  ]);
  const found = new Set();
  for (const match of text.matchAll(/#([а-яё]+)/giu)) {
    const value = match[1].toLowerCase();
    if (aliases.has(value)) found.add(aliases.get(value));
  }
  return [...found];
}

function parseMessages(html, searchTerm) {
  const chunks = html.split('<div class="tgme_widget_message_wrap');
  const parsed = [];
  for (const chunk of chunks.slice(1)) {
    const idMatch = chunk.match(new RegExp(`data-post="${CHANNEL}/(\\d+)"`));
    if (!idMatch) continue;
    const textStart = chunk.indexOf("tgme_widget_message_text js-message_text");
    if (textStart < 0) continue;
    const stopCandidates = [
      chunk.indexOf("tgme_widget_message_reactions", textStart),
      chunk.indexOf("tgme_widget_message_footer", textStart),
      chunk.length,
    ].filter((value) => value >= 0);
    const textHtml = chunk.slice(textStart, Math.min(...stopCandidates));
    const text = htmlToText(textHtml);
    const coordinateMatches = [...text.matchAll(/(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/g)];
    for (const coordinate of coordinateMatches) {
      const latitude = Number(coordinate[1]);
      const longitude = Number(coordinate[2]);
      const preceding = text.slice(Math.max(0, coordinate.index - 100), coordinate.index).toLowerCase();
      const labelMatch = preceding.match(/координат[^:\n]{0,30}:?\s*$/i);
      const label = labelMatch?.[0] ?? preceding.slice(-60);
      const isServicePoint = /(парков|слип|спуск|заезд)/i.test(label);
      parsed.push({
        id: Number(idMatch[1]),
        date: parseDate(text),
        latitude,
        longitude,
        distance_km: haversineKm(CENTER[0], CENTER[1], latitude, longitude),
        fish: fishFromText(text),
        text: text.slice(0, 1800),
        coordinate_label: label.trim(),
        is_service_point: isServicePoint,
        search_term: searchTerm,
        source_url: `https://t.me/${CHANNEL}/${idMatch[1]}`,
      });
    }
  }
  return parsed;
}

function getHtmlOnce(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html",
          "accept-encoding": "identity",
        },
        timeout: 45_000,
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          resolve(getHtmlOnce(new URL(response.headers.location, url).toString()));
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`${response.statusCode}: ${url}`));
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.on("timeout", () => request.destroy(new Error(`Timeout: ${url}`)));
    request.on("error", reject);
  });
}

async function getHtml(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await getHtmlOnce(url);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
      }
    }
  }
  throw lastError;
}

async function main() {
  const all = [];
  for (const term of SEARCH_TERMS) {
    const url = `https://t.me/s/${CHANNEL}?q=${encodeURIComponent(term)}`;
    const html = await getHtml(url);
    all.push(...parseMessages(html, term));
    console.log(`${term}: ${all.length} coordinate rows accumulated`);
  }

  const unique = [
    ...new Map(
      all.map((item) => [
        `${item.id}:${item.latitude.toFixed(6)}:${item.longitude.toFixed(6)}`,
        item,
      ]),
    ).values(),
  ];
  const target = unique.filter(
    (item) => item.distance_km <= 55 && !item.is_service_point,
  );
  const outDir = path.resolve("work");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "telegram_public_coordinates_all.json"),
    JSON.stringify(unique, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "telegram_public_coordinates_target.json"),
    JSON.stringify(target, null, 2),
    "utf8",
  );
  console.log(`Unique coordinate rows: ${unique.length}; target non-service rows: ${target.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
