import fs from "node:fs";
import path from "node:path";

const BASE = "https://ru.fishermap.org";
const CITY_URL = `${BASE}/city/novaya-ladoga/`;
const OUT_DIR = path.resolve("work");
const USER_AGENT = "Mozilla/5.0 (compatible; public-research/1.0; +https://ru.fishermap.org/)";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      const response = await fetch(url, {
        ...options,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          ...(options.headers ?? {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function parsePageData(html, id) {
  const match = html.match(/window\.pageData\s*=\s*(\{.*?\});\s*window\.nearbyLocations/s);
  if (!match) throw new Error(`window.pageData not found for location ${id}`);
  const data = JSON.parse(match[1]);
  const date = Number.isFinite(data.db_date)
    ? new Date(data.db_date * 1000).toISOString()
    : null;
  return {
    id: data.id,
    latitude: data.lat,
    longitude: data.lng,
    date,
    db_date: data.db_date ?? null,
    fish: (data.fishes ?? []).map((fish) => fish.name ?? fish.fishname).filter(Boolean),
    description: data.description ?? "",
    original_source: data.source ?? "",
    lakes: (data.lakes ?? []).map((item) => item.name).filter(Boolean),
    rivers: (data.rivers ?? []).map((item) => item.name).filter(Boolean),
    embayments: (data.embayments ?? []).map((item) => item.name).filter(Boolean),
    cities: (data.cities ?? []).map((item) => item.name).filter(Boolean),
    region: data.region?.name ?? "",
    county: data.county?.name ?? "",
    has_photos: Boolean(data.has_photos),
    page_url: `${BASE}/location/${data.id}/`,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cityResponse = await fetch(CITY_URL, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!cityResponse.ok) {
    throw new Error(`City page: ${cityResponse.status} ${cityResponse.statusText}`);
  }
  const cityHtml = await cityResponse.text();
  const setCookies = cityResponse.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  const tokenMatch = cityHtml.match(/const _token = '([^']+)'/);
  if (!tokenMatch) throw new Error("CSRF token not found");
  const token = tokenMatch[1];

  const mapText = await fetchText(`${BASE}/ajax/map-data?id=49&type=city`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": token,
      "x-requested-with": "XMLHttpRequest",
      referer: CITY_URL,
      cookie,
    },
    body: "{}",
  });
  const mapData = JSON.parse(mapText);
  fs.writeFileSync(
    path.join(OUT_DIR, "fishermap_novaya_ladoga_map_data.json"),
    JSON.stringify(mapData, null, 2),
    "utf8",
  );

  const locations = mapData.locations ?? [];
  const results = new Array(locations.length);
  const errors = [];
  let cursor = 0;
  let completed = 0;

  async function worker(workerId) {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= locations.length) return;
      const [id, mapLat, mapLng] = locations[index];
      try {
        const html = await fetchText(`${BASE}/location/${id}/`);
        const parsed = parsePageData(html, id);
        parsed.map_latitude = mapLat;
        parsed.map_longitude = mapLng;
        results[index] = parsed;
      } catch (error) {
        errors.push({ id, error: String(error) });
        results[index] = {
          id,
          latitude: mapLat,
          longitude: mapLng,
          page_url: `${BASE}/location/${id}/`,
          error: String(error),
        };
      }
      completed += 1;
      if (completed % 10 === 0 || completed === locations.length) {
        process.stdout.write(`Fetched ${completed}/${locations.length}\n`);
      }
      await sleep(125 + workerId * 15);
    }
  }

  await Promise.all(Array.from({ length: 6 }, (_, index) => worker(index)));
  fs.writeFileSync(
    path.join(OUT_DIR, "fishermap_novaya_ladoga_locations.json"),
    JSON.stringify(results, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "fishermap_fetch_errors.json"),
    JSON.stringify(errors, null, 2),
    "utf8",
  );
  process.stdout.write(`Done. Locations: ${results.length}; errors: ${errors.length}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
