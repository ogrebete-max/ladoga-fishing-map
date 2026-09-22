import fs from "node:fs";
import path from "node:path";

const API = "https://fishing-report.ru/wp-json/wp/v2/posts";
const TARGET_TAGS = [
  1002, // Ладожское озеро
  4267, // Водоём Ладожское озеро
  2679, // Волховская губа
  945,  // бухта Петрокрепость
  648,  // Река Волхов
  8008, // река Волхов
  7081, // Новая Ладога
  4411, // Загубская губа
  4956, // деревня Кобона
  3153, // Шлиссельбург
  3154, // Шлиссельбургское городское поселение
  3002, // посёлок Свирица
];

const USER_AGENT = "Mozilla/5.0 (compatible; public-research/1.0; +https://fishing-report.ru/)";

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
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseFish(value) {
  return value
    .trim()
    .replace(/[.;]+$/g, "")
    .replace(/^./u, (letter) => letter.toUpperCase());
}

function parsePost(post) {
  const html = post.content?.rendered ?? "";
  const text = htmlToText(html);
  const coordinateMatch = text.match(
    /Местонахождение:\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/i,
  );
  const waterbodyMatch = text.match(/Водоём:\s*(.*?)\s+Местонахождение:/i);
  const fishMatch = text.match(
    /Тип рыбы на фото\s*\(предполагаемый\)\s*:\s*(.*?)(?:\.\s|\s+Место ловли|\s+Прогноз|$)/i,
  );
  const waterbodyIndex = text.search(/Водоём:/i);
  const description = waterbodyIndex > 0 ? text.slice(0, waterbodyIndex).trim() : "";
  const fish = fishMatch
    ? fishMatch[1]
        .split(/,|\s+и\s+/i)
        .map(titleCaseFish)
        .filter(Boolean)
    : [];

  return {
    id: post.id,
    date: post.date ?? null,
    source_url: post.link,
    title: decodeEntities(post.title?.rendered ?? "").replace(/<[^>]+>/g, ""),
    latitude: coordinateMatch ? Number(coordinateMatch[1]) : null,
    longitude: coordinateMatch ? Number(coordinateMatch[2]) : null,
    waterbody: waterbodyMatch ? waterbodyMatch[1].trim() : "",
    fish,
    description: description.slice(0, 800),
    tags: post.tags ?? [],
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return { data: await response.json(), headers: response.headers };
}

async function main() {
  const outDir = path.resolve("work");
  fs.mkdirSync(outDir, { recursive: true });
  const common = new URLSearchParams({
    tags: TARGET_TAGS.join(","),
    per_page: "100",
    page: "1",
    orderby: "date",
    order: "desc",
    _fields: "id,date,link,title,content,excerpt,tags",
  });

  const first = await fetchJson(`${API}?${common}`);
  const totalPages = Number(first.headers.get("x-wp-totalpages") ?? 1);
  const posts = [...first.data];
  for (let page = 2; page <= totalPages; page += 1) {
    common.set("page", String(page));
    const response = await fetchJson(`${API}?${common}`);
    posts.push(...response.data);
  }

  const unique = [...new Map(posts.map((post) => [post.id, post])).values()];
  const parsed = unique.map(parsePost);
  fs.writeFileSync(
    path.join(outDir, "fishing_report_posts_raw.json"),
    JSON.stringify(unique, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "fishing_report_locations.json"),
    JSON.stringify(parsed, null, 2),
    "utf8",
  );
  console.log(
    `Posts: ${unique.length}; with coordinates: ${parsed.filter((item) => item.latitude !== null).length}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
