import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WORK_DIR = path.join(ROOT, "work");
const OUTPUT_DIR = path.join(ROOT, "outputs");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const CENTER = { name: "Новая Ладога / устье Волхова", latitude: 60.1037113, longitude: 32.2939775 };
const MAX_RADIUS_KM = 55;
const EXACT_GROUP_RADIUS_M = 30;

const LANDMARKS = [
  { name: "Новая Ладога / устье Волхова", latitude: 60.118, longitude: 32.32 },
  { name: "Нижний Волхов", latitude: 60.075, longitude: 32.333 },
  { name: "Креницы / Волховская губа", latitude: 60.16, longitude: 32.26 },
  { name: "о. Птинов", latitude: 60.25366, longitude: 32.07901 },
  { name: "Варецкие банки", latitude: 60.29833, longitude: 32.10667 },
  { name: "Дубно", latitude: 60.234609, longitude: 31.983349 },
  { name: "Лигово", latitude: 60.240971, longitude: 31.778853 },
  { name: "Вороново", latitude: 60.285915, longitude: 32.601296 },
  { name: "о. Сухо", latitude: 60.405998, longitude: 32.091712 },
  { name: "Кобона / южный берег", latitude: 60.03, longitude: 31.55 },
  { name: "Шлиссельбург / бухта Петрокрепость", latitude: 60.12, longitude: 31.61 },
  { name: "Свирица / Загубская губа", latitude: 60.45, longitude: 32.82 },
];

const MAP_LANDMARKS = [
  { name: "Новая Ладога / исходный центр", latitude: CENTER.latitude, longitude: CENTER.longitude, note: "Центр радиуса; не входит в статистическую плотность." },
  { name: "о. Птинов (ориентир)", latitude: 60.25366, longitude: 32.07901, note: "Географический ориентир из исходного контекста; не считается рыболовным отчётом." },
  { name: "Варецкие банки (ориентир)", latitude: 60.29833, longitude: 32.10667, note: "Ориентир протяжённой гряды; не считается рыболовным отчётом." },
];

const VERIFIED_FISHERMAP_IDS = new Set([15453, 16637, 5608, 2248, 6158, 16626, 16235, 15386]);

function loadJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(WORK_DIR, fileName), "utf8"));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const populated = rows.filter((candidate) => candidate.some((value) => value !== ""));
  const headers = populated.shift().map((value) => value.replace(/^\uFEFF/, ""));
  return populated.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function fishListFromLegacy(value) {
  const emptyValues = new Set(["", "—", "не указано"]);
  return uniq(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => !emptyValues.has(item.toLowerCase()))
      .map((item) => item.charAt(0).toUpperCase() + item.slice(1)),
  );
}

const previousChatSourceRows = parseCsv(
  fs.readFileSync(path.join(WORK_DIR, "previous_chat_ladoga_points_preliminary.csv"), "utf8"),
).map((row) => {
  const depthMatch = String(row.name ?? "").match(/(\d+(?:[.,]\d+)?)\s*м\b/i);
  const legacyType = String(row.type ?? "").trim();
  return {
    latitude: Number(row.lat),
    longitude: Number(row.lon),
    name: String(row.name ?? "").trim(),
    legacy_sector: String(row.sector ?? "").trim(),
    fish: fishListFromLegacy(row.fish),
    legacy_type: legacyType,
    confidence_class: legacyType.toLowerCase().includes("точный gps") ? "A" : legacyType === "ориентир" ? "" : "B",
    depth: depthMatch ? `${depthMatch[1].replace(",", ".")} м` : "",
  };
});
const previousChatFishingRows = previousChatSourceRows.filter((row) => row.legacy_type !== "ориентир");
const previousChatLandmarkRows = previousChatSourceRows.filter((row) => row.legacy_type === "ориентир");

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

function distanceBetween(a, b) {
  return haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
}

function normalizeDate(value) {
  if (!value) return "";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function uniq(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function nearestLandmark(latitude, longitude) {
  let best = null;
  for (const landmark of LANDMARKS) {
    const distance = haversineKm(latitude, longitude, landmark.latitude, landmark.longitude);
    if (!best || distance < best.distance_km) best = { ...landmark, distance_km: distance };
  }
  return best;
}

function makeRecord(input) {
  const landmark = nearestLandmark(input.latitude, input.longitude);
  return {
    record_id: input.record_id,
    latitude: Number(input.latitude),
    longitude: Number(input.longitude),
    fish: uniq((input.fish ?? []).map((value) => String(value).trim()).filter(Boolean)),
    source: input.source,
    source_url: input.source_url ?? "",
    source_id: String(input.source_id ?? ""),
    original_source_url: input.original_source_url ?? "",
    date: normalizeDate(input.date),
    sector: input.sector || landmark.name,
    confidence_class: input.confidence_class,
    reports_count: Number(input.reports_count ?? 1),
    comment: input.comment ?? "",
    depth: input.depth ?? "",
    method: input.method ?? "",
    catch: input.catch ?? "",
    nearest_landmark: landmark.name,
    landmark_distance_km: Number(landmark.distance_km.toFixed(3)),
    distance_from_novaya_ladoga_km: Number(
      haversineKm(CENTER.latitude, CENTER.longitude, input.latitude, input.longitude).toFixed(3),
    ),
    waterbody: input.waterbody ?? "",
    context_reports_count: input.context_reports_count ?? "",
    raw_type: input.raw_type ?? "report",
    analysis_weight: 1,
    duplicate_of: "",
  };
}

function fisherMapInclusion(item) {
  const distance = haversineKm(CENTER.latitude, CENTER.longitude, item.latitude, item.longitude);
  if (distance > MAX_RADIUS_KM) return { included: false, reason: `за пределами ${MAX_RADIUS_KM} км` };
  const lakes = item.lakes ?? [];
  const rivers = item.rivers ?? [];
  const embayments = item.embayments ?? [];
  if (lakes.includes("Ладожское озеро")) return { included: true, reason: "Ладожское озеро" };
  if (embayments.includes("бухта Петрокрепость")) return { included: true, reason: "бухта Петрокрепость" };
  if (lakes.includes("Загубская губа") && rivers.length === 0) {
    return { included: true, reason: "Загубская губа без речной привязки" };
  }
  if (rivers.includes("Волхов") && item.latitude >= 60.048) {
    return { included: true, reason: "нижний Волхов" };
  }
  const noWaterbody = lakes.length + rivers.length + embayments.length === 0;
  if (noWaterbody) {
    const targetCorridor =
      (item.latitude >= 60.1 && item.latitude <= 60.32 && item.longitude >= 31.55 && item.longitude <= 32.7) ||
      (item.latitude >= 59.94 && item.latitude < 60.1 && item.longitude >= 31.35 && item.longitude <= 31.8);
    if (targetCorridor) return { included: true, reason: "целевая прибрежная зона; водоём в метаданных не указан" };
  }
  return { included: false, reason: "соседняя река/канал, верхний Волхов или неоднозначная внутренняя точка" };
}

function fishingReportInclusion(item) {
  const distance = haversineKm(CENTER.latitude, CENTER.longitude, item.latitude, item.longitude);
  if (distance > MAX_RADIUS_KM) return { included: false, reason: `за пределами ${MAX_RADIUS_KM} км` };
  const waterbody = item.waterbody ?? "";
  if (/Ладожское озеро/i.test(waterbody)) return { included: true, reason: "Ладожское озеро" };
  if (/Волховская губа/i.test(waterbody)) return { included: true, reason: "Волховская губа" };
  if (/бухта Петрокрепость/i.test(waterbody)) return { included: true, reason: "бухта Петрокрепость" };
  if (/Загубская губа/i.test(waterbody)) return { included: true, reason: "Загубская губа" };
  if (/Новоладожский канал/i.test(waterbody)) return { included: true, reason: "устьевая зона Новой Ладоги" };
  if (/Река Волхов/i.test(waterbody) && item.latitude >= 60.048) {
    return { included: true, reason: "нижний Волхов" };
  }
  if (/Водоём #230553008/i.test(waterbody) && item.latitude >= 59.95 && item.longitude < 31.8) {
    return { included: true, reason: "южный берег/Петрокрепость; служебное имя водоёма" };
  }
  return { included: false, reason: "другая река, верхний Волхов или иной водоём" };
}

function fishKeySet(fish) {
  const text = fish.map((value) => value.toLowerCase().replace(/ё/g, "е"));
  const keys = new Set();
  for (const value of text) {
    if (value.includes("судак")) keys.add("zander");
    if (value.includes("щук")) keys.add("pike");
    if (value.includes("окун")) keys.add("perch");
    if (value.includes("плотв") || value.includes("сорож")) keys.add("roach");
    if (value.includes("лещ") || value.includes("подлещик")) keys.add("bream");
  }
  const hasOther = text.length === 0 || text.some((value) => {
    return !(
      value.includes("судак") ||
      value.includes("щук") ||
      value.includes("окун") ||
      value.includes("плотв") ||
      value.includes("сорож") ||
      value.includes("лещ") ||
      value.includes("подлещик")
    );
  });
  if (hasOther) keys.add("other");
  return keys;
}

const fisherMapRaw = loadJson("fishermap_novaya_ladoga_locations.json");
const fishingReportRaw = loadJson("fishing_report_locations.json");

const fisherMapAudit = [];
const fishingReportAudit = [];
const records = [];

for (const item of fisherMapRaw) {
  const decision = fisherMapInclusion(item);
  const waterbody = uniq([...(item.lakes ?? []), ...(item.embayments ?? []), ...(item.rivers ?? [])]).join("; ");
  fisherMapAudit.push({ ...item, waterbody, included: decision.included, inclusion_reason: decision.reason });
  if (!decision.included) continue;
  records.push(
    makeRecord({
      record_id: `fishermap-${item.id}`,
      latitude: item.latitude,
      longitude: item.longitude,
      fish: item.fish,
      source: "FisherMap",
      source_url: item.page_url,
      source_id: item.id,
      original_source_url: item.original_source,
      date: item.date,
      confidence_class: "B",
      waterbody,
      comment: `Публичная геометка рыболовного отчёта FisherMap. ${decision.reason}.`,
    }),
  );
}

for (const item of fishingReportRaw) {
  const decision = fishingReportInclusion(item);
  fishingReportAudit.push({ ...item, included: decision.included, inclusion_reason: decision.reason });
  if (!decision.included) continue;
  records.push(
    makeRecord({
      record_id: `fishing-report-${item.id}`,
      latitude: item.latitude,
      longitude: item.longitude,
      fish: item.fish,
      source: "fishing-report.ru",
      source_url: item.source_url,
      source_id: item.id,
      date: item.date,
      confidence_class: "B",
      waterbody: item.waterbody,
      comment: `Публичная геометка отчёта fishing-report.ru. ${decision.reason}. ${item.description || ""}`.trim(),
    }),
  );
}

const telegramRecords = [
  {
    id: 24765,
    date: "2026-06-10",
    latitude: 60.112347,
    longitude: 32.333083,
    fish: ["Лещ", "Густера", "Линь"],
    comment: "Немятово, поплавок и червь; координаты локации опубликованы в тексте поста.",
  },
  {
    id: 19629,
    date: "2025-09-20",
    latitude: 60.112389,
    longitude: 32.332962,
    fish: ["Щука"],
    comment: "Ново-Свирский канал у пересечения с Волховом; координаты локации опубликованы в тексте поста.",
    method: "вертушка, с берега",
  },
  {
    id: 23021,
    date: "2026-03-13",
    latitude: 60.121145,
    longitude: 32.29689,
    fish: ["Плотва"],
    comment: "Креницы, 9 км; координаты опубликованы в тексте поста.",
    depth: "2.3 м",
  },
];

for (const item of telegramRecords) {
  records.push(
    makeRecord({
      record_id: `telegram-${item.id}`,
      latitude: item.latitude,
      longitude: item.longitude,
      fish: item.fish,
      source: "Telegram: Рыболовная сводка Спб",
      source_url: `https://t.me/rybalka_spb_lenoblasti/${item.id}`,
      source_id: item.id,
      date: item.date,
      confidence_class: "A",
      waterbody: item.latitude > 60.12 ? "Ладожское озеро / Креницы" : "нижний Волхов / устьевая зона",
      comment: item.comment,
      depth: item.depth ?? "",
      method: item.method ?? "",
    }),
  );
}

const pkrAnchors = [
  { id: 157, name: "Варецкие банки", latitude: 60.27479, longitude: 32.066842, messages: 116 },
  { id: 161, name: "Дубно", latitude: 60.234609, longitude: 31.983349, messages: 960 },
  { id: 166, name: "Креницы", latitude: 60.133145, longitude: 32.284981, messages: 2986 },
  { id: 172, name: "Лигово", latitude: 60.240971, longitude: 31.778853, messages: 671 },
  { id: 175, name: "Новая Ладога", latitude: 60.155861, longitude: 32.337228, messages: 338 },
  { id: 176, name: "о-в Птинов", latitude: 60.229273, longitude: 32.085666, messages: 204 },
];

for (const item of pkrAnchors) {
  records.push(
    makeRecord({
      record_id: `pkr-water-${item.id}`,
      latitude: item.latitude,
      longitude: item.longitude,
      fish: [],
      source: "ПКР / fisher.spb.ru",
      source_url: `https://fisher.spb.ru/news/message-bycatalog.php?category=5&water=${item.id}`,
      source_id: `water-${item.id}`,
      date: "",
      sector: item.name,
      confidence_class: "C",
      waterbody: "Ладожское озеро",
      context_reports_count: item.messages,
      raw_type: "structure_anchor",
      comment: `Точка каталога района «${item.name}». В архиве ${item.messages} сообщений; это справочная повторяемость названия, а не ${item.messages} GPS-отчётов, поэтому в плотность добавлена одна точка C.`,
    }),
  );
}

const startingFishingPointsBase = [
  { id: "fm-15453", latitude: 60.23285, longitude: 32.0559, fish: ["Щука", "Голавль", "Окунь"] },
  { id: "fm-16637", latitude: 60.22586, longitude: 31.98206, fish: ["Щука"] },
  { id: "fm-5608", latitude: 60.23905, longitude: 32.1368, fish: ["Густера", "Окунь", "Плотва"] },
  { id: "fm-2248", latitude: 60.227, longitude: 32.13514, fish: ["Окунь"] },
  { id: "fm-6158", latitude: 60.18843, longitude: 32.22227, fish: ["Щука"] },
  { id: "fm-16626", latitude: 60.14845, longitude: 32.24282, fish: ["Окунь", "Судак"] },
  { id: "fm-16235", latitude: 60.14112, longitude: 32.21525, fish: ["Щука"] },
  { id: "fm-15386", latitude: 60.20561, longitude: 32.41823, fish: ["Судак"] },
  { id: "prior-01", latitude: 60.248535, longitude: 32.044871, fish: ["Щука"], comment: "Дубно" },
  { id: "prior-02", latitude: 60.240732, longitude: 32.012897, fish: ["Окунь"] },
  { id: "prior-03", latitude: 60.262203, longitude: 31.943687, fish: [], comment: "Дубно" },
  { id: "prior-04", latitude: 60.268709, longitude: 31.852692, fish: ["Судак"], comment: "Лигово" },
  { id: "prior-05", latitude: 60.197533, longitude: 32.189567, fish: ["Окунь"], comment: "Креницы" },
  { id: "prior-06", latitude: 60.177483, longitude: 32.252517, fish: ["Окунь"], comment: "Креницы" },
  { id: "prior-07", latitude: 60.171933, longitude: 32.27465, fish: ["Плотва"], comment: "Креницы" },
  { id: "prior-08", latitude: 60.1565, longitude: 32.278783, fish: ["Плотва"], comment: "Креницы" },
  { id: "prior-09", latitude: 60.162306, longitude: 32.292472, fish: ["Плотва"], comment: "Креницы" },
  { id: "prior-10", latitude: 60.207317, longitude: 32.178383, fish: ["Плотва"], comment: "Креницы" },
  { id: "prior-11", latitude: 60.217083, longitude: 32.181783, fish: ["Плотва"], comment: "Креницы" },
  { id: "prior-12", latitude: 60.121145, longitude: 32.29689, fish: ["Плотва"], comment: "Креницы", depth: "2.3 м" },
  { id: "prior-13", latitude: 60.130961, longitude: 32.330439, fish: ["Щука"] },
  { id: "prior-14", latitude: 60.285915, longitude: 32.601296, fish: [], comment: "Вороново" },
  { id: "prior-15", latitude: 60.112347, longitude: 32.333083, fish: [] },
  { id: "prior-16", latitude: 60.09417, longitude: 32.31388, fish: [] },
  { id: "prior-17", latitude: 60.082004, longitude: 32.319865, fish: [] },
  { id: "prior-18", latitude: 60.077029, longitude: 32.32236, fish: [] },
  { id: "prior-19", latitude: 60.055326, longitude: 32.341376, fish: [] },
  { id: "prior-20", latitude: 60.052698, longitude: 32.344409, fish: [] },
  { id: "prior-21", latitude: 60.05031, longitude: 32.344323, fish: [] },
  { id: "prior-22", latitude: 60.051332, longitude: 32.344224, fish: [] },
];

const startingFishingPoints = startingFishingPointsBase.map((basePoint) => {
  const legacy = previousChatFishingRows.find((row) => distanceBetween(basePoint, row) * 1000 <= 20);
  if (!legacy) return { ...basePoint, confidence_class: "B", legacy_type: "переданный контекст" };
  return {
    ...basePoint,
    name: legacy.name,
    legacy_sector: legacy.legacy_sector,
    legacy_type: legacy.legacy_type,
    confidence_class: legacy.confidence_class,
    fish: legacy.fish.length ? legacy.fish : basePoint.fish,
    comment: legacy.name || basePoint.comment || "",
    depth: legacy.depth || basePoint.depth || "",
  };
});

let nextPriorId = Math.max(
  0,
  ...startingFishingPointsBase
    .map((point) => String(point.id).match(/^prior-(\d+)$/))
    .filter(Boolean)
    .map((match) => Number(match[1])),
) + 1;
for (const legacy of previousChatFishingRows) {
  if (startingFishingPoints.some((point) => distanceBetween(point, legacy) * 1000 <= 20)) continue;
  startingFishingPoints.push({
    id: `prior-${String(nextPriorId).padStart(2, "0")}`,
    latitude: legacy.latitude,
    longitude: legacy.longitude,
    name: legacy.name,
    legacy_sector: legacy.legacy_sector,
    legacy_type: legacy.legacy_type,
    confidence_class: legacy.confidence_class,
    fish: legacy.fish,
    comment: legacy.name,
    depth: legacy.depth,
  });
  nextPriorId += 1;
}

if (startingFishingPoints.length !== previousChatFishingRows.length) {
  throw new Error(`Previous-chat fishing point mismatch: ${startingFishingPoints.length} vs ${previousChatFishingRows.length}`);
}

const startingCoverage = [];
for (const point of startingFishingPoints) {
  let closest = null;
  for (const record of records) {
    const distanceM = distanceBetween(point, record) * 1000;
    if (!closest || distanceM < closest.distance_m) closest = { record, distance_m: distanceM };
  }
  if (closest && closest.distance_m <= 20) {
    closest.record.fish = uniq([...closest.record.fish, ...point.fish]);
    if (point.confidence_class === "A") closest.record.confidence_class = "A";
    if (point.depth && !closest.record.depth) closest.record.depth = point.depth;
    const legacyNote = `Предыдущий массив: ${point.name || point.comment || point.id} (${point.legacy_type}).`;
    if (!closest.record.comment.includes(legacyNote)) closest.record.comment = `${closest.record.comment} ${legacyNote}`.trim();
    startingCoverage.push({
      ...point,
      included_in_statistics: true,
      covered_by: closest.record.record_id,
      distance_m: Number(closest.distance_m.toFixed(1)),
      added_manual_row: false,
    });
    continue;
  }
  const manual = makeRecord({
    record_id: `previous-${point.id}`,
    latitude: point.latitude,
    longitude: point.longitude,
    fish: point.fish,
    source: "Предыдущее исследование",
    source_id: point.id,
    date: "",
    confidence_class: point.confidence_class,
    waterbody: point.latitude <= 60.12 && point.longitude >= 32.3 ? "нижний Волхов" : "Ладожское озеро / Волховская губа",
    comment: `Координата восстановлена из ladoga_points_preliminary.csv предыдущего чата; исходная публичная ссылка в файле не сохранена. ${point.name || point.comment || ""}`.trim(),
    depth: point.depth ?? "",
  });
  records.push(manual);
  startingCoverage.push({
    ...point,
    included_in_statistics: true,
    covered_by: manual.record_id,
    distance_m: 0,
    added_manual_row: true,
  });
}

for (const [index, landmark] of previousChatLandmarkRows.entries()) {
  startingCoverage.push({
    id: `landmark-${String(index + 1).padStart(2, "0")}`,
    latitude: landmark.latitude,
    longitude: landmark.longitude,
    name: landmark.name,
    legacy_sector: landmark.legacy_sector,
    fish: [],
    legacy_type: landmark.legacy_type,
    confidence_class: "",
    comment: "Географический ориентир предыдущей карты; сохранён только в слое ориентиров и не участвует в статистической плотности.",
    depth: "",
    included_in_statistics: false,
    covered_by: "map-landmark",
    distance_m: 0,
    added_manual_row: false,
  });
}

for (const id of VERIFIED_FISHERMAP_IDS) {
  if (!records.some((record) => record.source === "FisherMap" && Number(record.source_id) === id)) {
    throw new Error(`Verified FisherMap id ${id} is missing from the included dataset`);
  }
}

const sourcePriority = new Map([
  ["Telegram: Рыболовная сводка Спб", 0],
  ["fishing-report.ru", 1],
  ["FisherMap", 2],
  ["Предыдущее исследование", 3],
  ["ПКР / fisher.spb.ru", 4],
]);

const dedupOrder = [...records].sort((a, b) => {
  return (sourcePriority.get(a.source) ?? 9) - (sourcePriority.get(b.source) ?? 9);
});
const primaryRecords = [];
for (const record of dedupOrder) {
  if (record.confidence_class === "C" || !record.date) {
    primaryRecords.push(record);
    continue;
  }
  const duplicate = primaryRecords.find((candidate) => {
    return (
      candidate.confidence_class !== "C" &&
      candidate.date === record.date &&
      candidate.source !== record.source &&
      distanceBetween(candidate, record) * 1000 <= 15
    );
  });
  if (duplicate) {
    record.analysis_weight = 0;
    record.duplicate_of = duplicate.record_id;
    record.comment = `${record.comment} Вероятная кросс-публикация того же отчёта, что ${duplicate.record_id}; строка сохранена, но не увеличивает плотность.`.trim();
  } else {
    primaryRecords.push(record);
  }
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = new Array(size).fill(0);
  }
  find(value) {
    if (this.parent[value] !== value) this.parent[value] = this.find(this.parent[value]);
    return this.parent[value];
  }
  union(a, b) {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return;
    if (this.rank[rootA] < this.rank[rootB]) [rootA, rootB] = [rootB, rootA];
    this.parent[rootB] = rootA;
    if (this.rank[rootA] === this.rank[rootB]) this.rank[rootA] += 1;
  }
}

const unionFind = new UnionFind(records.length);
for (let i = 0; i < records.length; i += 1) {
  for (let j = i + 1; j < records.length; j += 1) {
    const mixedC = (records[i].confidence_class === "C") !== (records[j].confidence_class === "C");
    if (mixedC) continue;
    if (distanceBetween(records[i], records[j]) * 1000 <= EXACT_GROUP_RADIUS_M) unionFind.union(i, j);
  }
}

const grouped = new Map();
for (let index = 0; index < records.length; index += 1) {
  const root = unionFind.find(index);
  if (!grouped.has(root)) grouped.set(root, []);
  grouped.get(root).push(records[index]);
}

const markers = [...grouped.values()].map((group, index) => {
  const active = group.filter((record) => record.analysis_weight > 0);
  const coordinateBase = active.length ? active : group;
  const latitude = coordinateBase.reduce((sum, record) => sum + record.latitude, 0) / coordinateBase.length;
  const longitude = coordinateBase.reduce((sum, record) => sum + record.longitude, 0) / coordinateBase.length;
  const reportsCount = active.reduce((sum, record) => sum + record.reports_count, 0);
  const dates = uniq(active.map((record) => record.date)).sort();
  const confidenceClasses = uniq(group.map((record) => record.confidence_class)).sort();
  const primaryClass = confidenceClasses.includes("A") ? "A" : confidenceClasses.includes("B") ? "B" : "C";
  const landmark = nearestLandmark(latitude, longitude);
  const sources = uniq(group.map((record) => record.source));
  const fish = uniq(group.flatMap((record) => record.fish)).sort((a, b) => a.localeCompare(b, "ru"));
  const sourceEntries = group.map((record) => ({
    source: record.source,
    source_id: record.source_id,
    source_url: record.source_url,
    date: record.date,
    duplicate_of: record.duplicate_of,
  }));
  const comments = uniq(group.map((record) => record.comment));
  const depths = uniq(group.map((record) => record.depth));
  const methods = uniq(group.map((record) => record.method));
  const catches = uniq(group.map((record) => record.catch));
  const contextCounts = group.map((record) => Number(record.context_reports_count || 0)).filter((value) => value > 0);
  return {
    marker_id: `P${String(index + 1).padStart(3, "0")}`,
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
    fish,
    source: sources.join("; "),
    source_url: uniq(group.map((record) => record.source_url)).join("; "),
    source_id: uniq(group.map((record) => record.source_id)).join("; "),
    date: dates.length <= 1 ? dates[0] ?? "" : `${dates[0]}—${dates.at(-1)}`,
    sector: landmark.name,
    confidence_class: primaryClass,
    confidence_classes: confidenceClasses,
    reports_count: reportsCount,
    published_rows: group.length,
    comment: comments.join(" | "),
    depth: depths.join("; "),
    method: methods.join("; "),
    catch: catches.join("; "),
    nearest_landmark: landmark.name,
    landmark_distance_km: Number(landmark.distance_km.toFixed(3)),
    distance_from_novaya_ladoga_km: Number(
      haversineKm(CENTER.latitude, CENTER.longitude, latitude, longitude).toFixed(3),
    ),
    context_reports_count: contextCounts.length ? Math.max(...contextCounts) : "",
    source_entries: sourceEntries,
    record_ids: group.map((record) => record.record_id),
    fish_keys: [...fishKeySet(fish)],
  };
});

const activeRecords = records.filter((record) => record.analysis_weight > 0);

function summarizeCounts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return [...result.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
}

function fishCountsFor(recordList) {
  const counts = { zander: 0, pike: 0, perch: 0, roach: 0, bream: 0, other: 0 };
  for (const record of recordList) {
    for (const key of fishKeySet(record.fish)) counts[key] += record.analysis_weight;
  }
  return counts;
}

function neighborhoodClusters(radiusM, limit = 12) {
  const candidates = activeRecords.map((center) => {
    const members = activeRecords.filter((record) => distanceBetween(center, record) * 1000 <= radiusM);
    const count = members.reduce((sum, record) => sum + record.analysis_weight, 0);
    const latitude = members.reduce((sum, record) => sum + record.latitude, 0) / members.length;
    const longitude = members.reduce((sum, record) => sum + record.longitude, 0) / members.length;
    const landmark = nearestLandmark(latitude, longitude);
    const fishCounts = fishCountsFor(members);
    return {
      radius_m: radiusM,
      center_latitude: Number(latitude.toFixed(6)),
      center_longitude: Number(longitude.toFixed(6)),
      reports_count: count,
      markers_count: members.length,
      sector: landmark.name,
      source_count: new Set(members.map((record) => record.source)).size,
      sources: uniq(members.map((record) => record.source)).join("; "),
      zander_reports: fishCounts.zander,
      pike_reports: fishCounts.pike,
      perch_reports: fishCounts.perch,
      roach_reports: fishCounts.roach,
      bream_reports: fishCounts.bream,
      other_reports: fishCounts.other,
      member_record_ids: members.map((record) => record.record_id),
    };
  });
  candidates.sort((a, b) => b.reports_count - a.reports_count || b.source_count - a.source_count);
  const accepted = [];
  for (const candidate of candidates) {
    const tooClose = accepted.some(
      (cluster) =>
        haversineKm(
          candidate.center_latitude,
          candidate.center_longitude,
          cluster.center_latitude,
          cluster.center_longitude,
        ) *
          1000 <=
        radiusM,
    );
    if (!tooClose) accepted.push(candidate);
    if (accepted.length >= limit) break;
  }
  return accepted;
}

const clusterRadii = [100, 250, 500, 1000];
const clustersByRadius = Object.fromEntries(clusterRadii.map((radius) => [radius, neighborhoodClusters(radius)]));
const allClusters = clusterRadii.flatMap((radius) =>
  clustersByRadius[radius].map((cluster, index) => ({ rank: index + 1, ...cluster })),
);

const fishCounts = fishCountsFor(activeRecords);
const sourceCounts = summarizeCounts(activeRecords.map((record) => record.source));
const classCounts = summarizeCounts(activeRecords.map((record) => record.confidence_class));
const sectorCounts = summarizeCounts(activeRecords.map((record) => record.sector));
const probableCrossPublications = records.filter((record) => record.analysis_weight === 0).length;

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  fs.writeFileSync(filePath, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

const pointColumns = [
  "marker_id",
  "latitude",
  "longitude",
  "fish",
  "source",
  "source_url",
  "source_id",
  "date",
  "sector",
  "confidence_class",
  "reports_count",
  "published_rows",
  "comment",
  "depth",
  "method",
  "catch",
  "nearest_landmark",
  "landmark_distance_km",
  "distance_from_novaya_ladoga_km",
  "context_reports_count",
];

const reportColumns = [
  "record_id",
  "latitude",
  "longitude",
  "fish",
  "source",
  "source_url",
  "source_id",
  "original_source_url",
  "date",
  "sector",
  "confidence_class",
  "reports_count",
  "analysis_weight",
  "duplicate_of",
  "comment",
  "depth",
  "method",
  "catch",
  "nearest_landmark",
  "landmark_distance_km",
  "distance_from_novaya_ladoga_km",
  "waterbody",
  "context_reports_count",
];

writeCsv(path.join(OUTPUT_DIR, "ladoga_points.csv"), markers, pointColumns);
writeCsv(path.join(OUTPUT_DIR, "ladoga_reports.csv"), records, reportColumns);
writeCsv(
  path.join(OUTPUT_DIR, "ladoga_cluster_statistics.csv"),
  allClusters,
  [
    "radius_m",
    "rank",
    "center_latitude",
    "center_longitude",
    "reports_count",
    "markers_count",
    "sector",
    "source_count",
    "sources",
    "zander_reports",
    "pike_reports",
    "perch_reports",
    "roach_reports",
    "bream_reports",
    "other_reports",
  ],
);
writeCsv(
  path.join(OUTPUT_DIR, "fishermap_novaya_ladoga_all_170.csv"),
  fisherMapAudit.map((item) => ({
    source_id: item.id,
    latitude: item.latitude,
    longitude: item.longitude,
    fish: item.fish,
    date: normalizeDate(item.date),
    waterbody: item.waterbody,
    source_url: item.page_url,
    original_source_url: item.original_source,
    included: item.included,
    inclusion_reason: item.inclusion_reason,
  })),
  [
    "source_id",
    "latitude",
    "longitude",
    "fish",
    "date",
    "waterbody",
    "source_url",
    "original_source_url",
    "included",
    "inclusion_reason",
  ],
);
writeCsv(
  path.join(OUTPUT_DIR, "starting_points_coverage.csv"),
  startingCoverage,
  [
    "id",
    "latitude",
    "longitude",
    "name",
    "legacy_sector",
    "fish",
    "legacy_type",
    "confidence_class",
    "included_in_statistics",
    "comment",
    "depth",
    "covered_by",
    "distance_m",
    "added_manual_row",
  ],
);

const geojson = {
  type: "FeatureCollection",
  name: "southern_ladoga_fishing_activity",
  metadata: {
    generated_at: new Date().toISOString(),
    center: CENTER,
    maximum_radius_km: MAX_RADIUS_KM,
    independent_reports: activeRecords.length,
    probable_cross_publications: probableCrossPublications,
    point_markers: markers.length,
  },
  features: markers.map((marker) => ({
    type: "Feature",
    id: marker.marker_id,
    geometry: { type: "Point", coordinates: [marker.longitude, marker.latitude] },
    properties: Object.fromEntries(Object.entries(marker).filter(([key]) => !["latitude", "longitude"].includes(key))),
  })),
};
fs.writeFileSync(path.join(OUTPUT_DIR, "ladoga_points.geojson"), JSON.stringify(geojson, null, 2), "utf8");

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const gpxWaypoints = markers
  .map((marker) => {
    const singleDate = /^\d{4}-\d{2}-\d{2}$/.test(marker.date) ? `${marker.date}T00:00:00Z` : "";
    const desc = [
      `Рыба: ${marker.fish.join(", ") || "не указана"}`,
      `Источник: ${marker.source}`,
      `Класс: ${marker.confidence_classes.join("/")}`,
      `Независимых отчётов: ${marker.reports_count}`,
      `Сектор: ${marker.sector}`,
    ].join("; ");
    return `  <wpt lat="${marker.latitude}" lon="${marker.longitude}">\n    <name>${xmlEscape(`${marker.marker_id} ${marker.sector}`)}</name>\n${singleDate ? `    <time>${singleDate}</time>\n` : ""}    <desc>${xmlEscape(desc)}</desc>\n    <type>Fishing activity</type>\n  </wpt>`;
  })
  .join("\n");
const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Codex southern Ladoga research" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n  <metadata><name>Рыболовная активность южной Ладоги</name><desc>Публичные геометки и локальные структуры классов A/B/C</desc></metadata>\n${gpxWaypoints}\n</gpx>\n`;
fs.writeFileSync(path.join(OUTPUT_DIR, "ladoga_points.gpx"), gpx, "utf8");

function markdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(row[column.key] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

const summaryLines = [
  "# Рыболовные геометки южной Ладоги",
  "",
  `Дата сборки: ${new Date().toISOString().slice(0, 10)}`,
  "",
  `- Полностью пройдено FisherMap-карточек в выгрузке Новой Ладоги: **${fisherMapRaw.length}**.`,
  `- В целевую акваторию включено FisherMap-карточек: **${fisherMapAudit.filter((item) => item.included).length}**.`,
  `- Проверено геомеченных fishing-report.ru отчётов по целевым тегам: **${fishingReportRaw.length}**; включено: **${fishingReportAudit.filter((item) => item.included).length}**.`,
  `- Из файлов предыдущего чата восстановлено: **${previousChatFishingRows.length}** рыболовная точка и **${previousChatLandmarkRows.length}** ориентира; все рыболовные координаты сопоставлены с итоговым массивом.`,
  `- Всего сохранено строк источников: **${records.length}**.`,
  `- Вероятных кросс-публикаций, сохранённых со статистическим весом 0: **${probableCrossPublications}**.`,
  `- Независимых отчётов/точек, участвующих в плотности: **${activeRecords.length}**.`,
  `- Картографических маркеров после объединения координат в пределах ${EXACT_GROUP_RADIUS_M} м: **${markers.length}**.`,
  "",
  "Числа обозначают опубликованную рыболовную активность и отчёты, а не доказанную биологическую плотность рыбы.",
  "",
  "## Источники",
  "",
  markdownTable(
    sourceCounts.map(([source, count]) => ({ source, count })),
    [
      { key: "source", label: "Источник" },
      { key: "count", label: "Независимых отчётов/точек" },
    ],
  ),
  "",
  "## Классы доверия",
  "",
  markdownTable(
    classCounts.map(([confidence, count]) => ({ confidence, count })),
    [
      { key: "confidence", label: "Класс" },
      { key: "count", label: "Количество" },
    ],
  ),
  "",
  "## Рыба",
  "",
  markdownTable(
    [
      { fish: "Судак", count: fishCounts.zander },
      { fish: "Щука", count: fishCounts.pike },
      { fish: "Окунь", count: fishCounts.perch },
      { fish: "Плотва/сорожка", count: fishCounts.roach },
      { fish: "Лещ/подлещик", count: fishCounts.bream },
      { fish: "Другое или не указано", count: fishCounts.other },
    ],
    [
      { key: "fish", label: "Категория" },
      { key: "count", label: "Отчёты" },
    ],
  ),
  "",
  "## Самые плотные окрестности",
  "",
];

for (const radius of clusterRadii) {
  summaryLines.push(`### Радиус ${radius} м`, "");
  summaryLines.push(
    markdownTable(
      clustersByRadius[radius].slice(0, 10).map((cluster, index) => ({
        rank: index + 1,
        center: `${cluster.center_latitude.toFixed(6)}, ${cluster.center_longitude.toFixed(6)}`,
        reports: cluster.reports_count,
        sector: cluster.sector,
        zander: cluster.zander_reports,
        pike: cluster.pike_reports,
        perch: cluster.perch_reports,
      })),
      [
        { key: "rank", label: "№" },
        { key: "center", label: "Центр" },
        { key: "reports", label: "Отчёты" },
        { key: "sector", label: "Ближайший район" },
        { key: "zander", label: "Судак" },
        { key: "pike", label: "Щука" },
        { key: "perch", label: "Окунь" },
      ],
    ),
    "",
  );
}

summaryLines.push(
  "## Ограничения",
  "",
  "- FisherMap и fishing-report.ru содержат публичные геометки отчётов (класс B); они не обязаны совпадать с местом поклёвки до метров.",
  "- Для строк, помеченных в исходном CSV предыдущего чата как «точный GPS из отчёта», восстановлен класс A. Если исходная публичная ссылка в старом файле отсутствовала, это явно указано в комментарии.",
  "- Точки C из каталогов ПКР показывают устойчивые локальные названия. Число сообщений архива сохранено как справочное поле и не умножает статистическую плотность.",
  "- Строки из предыдущего исследования без восстановленной исходной ссылки сохранены с явной пометкой.",
  "- Вероятные кросс-публикации одного отчёта на разных сайтах сохранены в отчётном CSV, но имеют analysis_weight = 0.",
  "- Глубины показаны только в popup/CSV, отдельного аналитического слоя глубин нет.",
  "",
  "## Основные файлы",
  "",
  "- `ladoga_points_map.html` — интерактивная карта.",
  "- `ladoga_points.csv` — агрегированные картографические маркеры.",
  "- `ladoga_reports.csv` — полный ряд источников и отчётов.",
  "- `ladoga_points.geojson` и `ladoga_points.gpx` — геоформаты.",
  "- `fishermap_novaya_ladoga_all_170.csv` — полный аудит FisherMap, включая исключённые точки и причины.",
  "- `starting_points_coverage.csv` — аудит всех 33 строк предыдущего CSV: 31 рыболовная точка и 2 нестатистических ориентира.",
);
fs.writeFileSync(path.join(OUTPUT_DIR, "ladoga_cluster_statistics.md"), `${summaryLines.join("\n")}\n`, "utf8");

const mapData = markers.map((marker) => ({
  marker_id: marker.marker_id,
  latitude: marker.latitude,
  longitude: marker.longitude,
  fish: marker.fish,
  fish_keys: marker.fish_keys,
  source: marker.source,
  source_id: marker.source_id,
  date: marker.date,
  sector: marker.sector,
  confidence_class: marker.confidence_class,
  confidence_classes: marker.confidence_classes,
  reports_count: marker.reports_count,
  published_rows: marker.published_rows,
  comment: marker.comment,
  depth: marker.depth,
  method: marker.method,
  catch: marker.catch,
  nearest_landmark: marker.nearest_landmark,
  landmark_distance_km: marker.landmark_distance_km,
  context_reports_count: marker.context_reports_count,
  source_entries: marker.source_entries,
}));

const mapJson = JSON.stringify(mapData).replace(/</g, "\\u003c");
const landmarkJson = JSON.stringify(MAP_LANDMARKS).replace(/</g, "\\u003c");
const mapHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Рыболовная активность южной Ладоги</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css">
  <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css">
  <style>
    html, body, #map { height: 100%; margin: 0; }
    body { font-family: Arial, sans-serif; color: #17212b; }
    .map-title { background: rgba(255,255,255,.96); padding: 10px 12px; border-radius: 6px; box-shadow: 0 1px 5px rgba(0,0,0,.28); max-width: 360px; line-height: 1.35; }
    .map-title h1 { margin: 0 0 4px; font-size: 17px; }
    .map-title p { margin: 3px 0; font-size: 12px; }
    .legend { background: rgba(255,255,255,.96); padding: 8px 10px; border-radius: 6px; box-shadow: 0 1px 5px rgba(0,0,0,.28); line-height: 1.45; font-size: 12px; }
    .legend-row { display: flex; align-items: center; gap: 6px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .leaflet-control-layers { max-height: 72vh; overflow-y: auto; font-size: 12px; }
    .popup { min-width: 260px; max-width: 390px; line-height: 1.38; }
    .popup h3 { margin: 0 0 6px; font-size: 15px; }
    .popup table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .popup td { vertical-align: top; padding: 2px 4px 2px 0; }
    .popup td:first-child { width: 94px; color: #53606d; }
    .popup .sources { margin-top: 6px; padding-top: 5px; border-top: 1px solid #dde2e7; }
    .popup .source-item { margin: 3px 0; }
    .popup .route-link { display: inline-block; margin-top: 8px; padding: 7px 10px; border-radius: 5px; background: #135f9b; color: #fff; font-size: 13px; font-weight: 700; text-decoration: none; }
    .popup .route-link:hover { background: #0b4e80; color: #fff; }
    .marker-cluster div { font-weight: 700; }
    .landmark-icon { width: 14px; height: 14px; background: #135f9b; transform: rotate(45deg); border: 2px solid white; box-shadow: 0 0 0 1px #135f9b; }
    .leaflet-container a { color: #0b5c91; }
  </style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>
<script>
  const points = ${mapJson};
  const landmarks = ${landmarkJson};
  const map = L.map('map', { zoomSnap: 0.5 }).setView([${CENTER.latitude}, ${CENTER.longitude}], 9);
  map.attributionControl.setPrefix(false);
  const topo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  }).addTo(map);
  const imagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  });
  const offline = L.gridLayer({ maxZoom: 20, attribution: 'Локальная нейтральная подложка' });
  offline.createTile = () => {
    const tile = document.createElement('div');
    tile.style.background = '#dcecf1';
    tile.style.outline = '1px solid rgba(38, 84, 101, 0.08)';
    return tile;
  };
  let topoErrors = 0;
  let imageryErrors = 0;
  topo.on('tileerror', () => {
    topoErrors += 1;
    if (topoErrors >= 3 && map.hasLayer(topo)) {
      map.removeLayer(topo);
      imagery.addTo(map);
    }
  });
  imagery.on('tileerror', () => {
    imageryErrors += 1;
    if (imageryErrors >= 3 && map.hasLayer(imagery)) {
      map.removeLayer(imagery);
      offline.addTo(map);
    }
  });
  L.control.layers({ 'Карта Esri': topo, 'Спутник Esri': imagery, 'Без подложки (офлайн)': offline }, null, { position: 'topleft' }).addTo(map);

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const fishLabels = { zander: 'Судак', pike: 'Щука', perch: 'Окунь', roach: 'Плотва', bream: 'Лещ', other: 'Другое/не указано' };
  const colors = { zander: '#6f42c1', pike: '#238636', perch: '#e67700', roach: '#1971c2', bream: '#8d5a2b', other: '#68737d' };
  function primaryFish(point) {
    for (const key of ['zander','pike','perch','roach','bream']) if (point.fish_keys.includes(key)) return key;
    return 'other';
  }
  function navigationUrl(point) {
    const destination = encodeURIComponent(point.latitude + ',' + point.longitude);
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return 'https://maps.apple.com/?daddr=' + destination + '&dirflg=d';
    return 'https://www.google.com/maps/dir/?api=1&destination=' + destination + '&travelmode=driving&dir_action=navigate';
  }
  function popupHtml(point) {
    const sourceItems = point.source_entries.map((entry) => {
      const label = esc(entry.source + (entry.source_id ? ' #' + entry.source_id : '') + (entry.date ? ' · ' + entry.date : ''));
      const linked = entry.source_url ? '<a href="' + esc(entry.source_url) + '" target="_blank" rel="noopener">' + label + '</a>' : label;
      const duplicate = entry.duplicate_of ? ' <span title="Не увеличивает плотность">(кросс-публикация)</span>' : '';
      return '<div class="source-item">' + linked + duplicate + '</div>';
    }).join('');
    const context = point.context_reports_count ? '<tr><td>Архив района</td><td>' + esc(point.context_reports_count) + ' сообщений (справочно, не как GPS-точки)</td></tr>' : '';
    return '<div class="popup"><h3>' + esc(point.marker_id + ' · ' + point.sector) + '</h3><table>' +
      '<tr><td>Координаты</td><td><b>' + point.latitude.toFixed(6) + ', ' + point.longitude.toFixed(6) + '</b></td></tr>' +
      '<tr><td>Рыба</td><td>' + esc(point.fish.join(', ') || 'не указана') + '</td></tr>' +
      '<tr><td>Дата</td><td>' + esc(point.date || 'не указана') + '</td></tr>' +
      '<tr><td>Класс</td><td>' + esc(point.confidence_classes.join('/')) + '</td></tr>' +
      '<tr><td>Отчёты</td><td><b>' + esc(point.reports_count) + '</b> независимых; ' + esc(point.published_rows) + ' строк источников</td></tr>' +
      (point.depth ? '<tr><td>Глубина</td><td>' + esc(point.depth) + '</td></tr>' : '') +
      (point.method ? '<tr><td>Метод</td><td>' + esc(point.method) + '</td></tr>' : '') +
      context +
      '<tr><td>Комментарий</td><td>' + esc(point.comment) + '</td></tr></table>' +
      '<div class="sources"><b>Источники</b>' + sourceItems + '</div>' +
      '<a class="route-link" href="' + navigationUrl(point) + '" target="_blank" rel="noopener">Построить маршрут</a></div>';
  }
  function weightedClusterIcon(cluster) {
    const total = cluster.getAllChildMarkers().reduce((sum, marker) => sum + (marker.options.reportsCount || 1), 0);
    const size = total < 10 ? 'small' : total < 100 ? 'medium' : 'large';
    return L.divIcon({ html: '<div><span>' + total + '</span></div>', className: 'marker-cluster marker-cluster-' + size, iconSize: L.point(40, 40) });
  }
  function markerFor(point) {
    const key = primaryFish(point);
    const marker = L.circleMarker([point.latitude, point.longitude], {
      radius: Math.min(11, 5 + Math.log2(Math.max(1, point.reports_count))),
      color: '#ffffff', weight: 1.5, fillColor: colors[key], fillOpacity: 0.9,
      reportsCount: point.reports_count,
    });
    marker.options.reportsCount = point.reports_count;
    marker.bindPopup(popupHtml(point), { maxWidth: 430 });
    return marker;
  }
  function clusterLayer(predicate) {
    const layer = L.markerClusterGroup({ chunkedLoading: true, disableClusteringAtZoom: 17, iconCreateFunction: weightedClusterIcon });
    points.filter(predicate).forEach((point) => layer.addLayer(markerFor(point)));
    return layer;
  }
  const modes = {
    'Все точки': clusterLayer(() => true),
    'Класс A': clusterLayer((p) => p.confidence_classes.includes('A')),
    'Класс B': clusterLayer((p) => p.confidence_classes.includes('B')),
    'Класс C': clusterLayer((p) => p.confidence_classes.includes('C')),
    'Судак': clusterLayer((p) => p.fish_keys.includes('zander')),
    'Щука': clusterLayer((p) => p.fish_keys.includes('pike')),
    'Окунь': clusterLayer((p) => p.fish_keys.includes('perch')),
    'Плотва': clusterLayer((p) => p.fish_keys.includes('roach')),
    'Лещ': clusterLayer((p) => p.fish_keys.includes('bream')),
    'Другая/не указана': clusterLayer((p) => p.fish_keys.includes('other')),
    'FisherMap': clusterLayer((p) => p.source.includes('FisherMap')),
    'fishing-report.ru': clusterLayer((p) => p.source.includes('fishing-report.ru')),
    'Telegram': clusterLayer((p) => p.source.includes('Telegram')),
    'ПКР / предыдущая база': clusterLayer((p) => p.source.includes('ПКР') || p.source.includes('Предыдущее')),
  };
  modes['Все точки'].addTo(map);

  const heat = L.heatLayer(points.map((p) => [p.latitude, p.longitude, Math.max(0.3, Math.log1p(p.reports_count))]), { radius: 28, blur: 22, maxZoom: 13, minOpacity: 0.25 });
  const landmarkLayer = L.layerGroup(landmarks.map((item) => L.marker([item.latitude, item.longitude], { icon: L.divIcon({ className: '', html: '<div class="landmark-icon"></div>', iconSize: [18,18], iconAnchor: [9,9] }) }).bindPopup('<b>' + esc(item.name) + '</b><br>' + esc(item.note)))).addTo(map);
  const radiusLayer = L.circle([${CENTER.latitude}, ${CENTER.longitude}], { radius: 50000, color: '#345995', weight: 1.5, dashArray: '7 7', fillOpacity: 0 });
  L.control.layers(modes, { 'Тепловая карта': heat, 'Ориентиры': landmarkLayer, 'Радиус 50 км': radiusLayer }, { collapsed: false, position: 'topright' }).addTo(map);

  const title = L.control({ position: 'bottomleft' });
  title.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-title');
    div.innerHTML = '<h1>Рыболовная активность южной Ладоги</h1>' +
      '<p><b>${activeRecords.length}</b> независимых отчётов/точек · <b>${markers.length}</b> маркеров · FisherMap пройден полностью: <b>${fisherMapRaw.length}</b> карточек.</p>' +
      '<p>Кластеры показывают количество опубликованных отчётов, а не доказанную плотность рыбы. Глубины не используются как аналитический слой.</p>';
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  title.addTo(map);

  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'legend');
    div.innerHTML = Object.entries(fishLabels).map(([key, label]) => '<div class="legend-row"><span class="legend-dot" style="background:' + colors[key] + '"></span>' + esc(label) + '</div>').join('');
    return div;
  };
  legend.addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  const bounds = L.latLngBounds(points.map((p) => [p.latitude, p.longitude]));
  map.fitBounds(bounds.pad(0.05));
</script>
</body>
</html>`;
fs.writeFileSync(path.join(OUTPUT_DIR, "ladoga_points_map.html"), mapHtml, "utf8");

const summary = {
  generated_at: new Date().toISOString(),
  fishermap_total_scanned: fisherMapRaw.length,
  fishermap_included: fisherMapAudit.filter((item) => item.included).length,
  fishing_report_total_scanned: fishingReportRaw.length,
  fishing_report_included: fishingReportAudit.filter((item) => item.included).length,
  previous_chat_source_rows: previousChatSourceRows.length,
  previous_chat_fishing_points: previousChatFishingRows.length,
  previous_chat_landmarks: previousChatLandmarkRows.length,
  source_rows: records.length,
  probable_cross_publications: probableCrossPublications,
  independent_reports: activeRecords.length,
  point_markers: markers.length,
  fish_counts: fishCounts,
  source_counts: Object.fromEntries(sourceCounts),
  class_counts: Object.fromEntries(classCounts),
  sector_counts: Object.fromEntries(sectorCounts),
  clusters: clustersByRadius,
};
fs.writeFileSync(path.join(WORK_DIR, "ladoga_build_summary.json"), JSON.stringify(summary, null, 2), "utf8");
fs.writeFileSync(path.join(WORK_DIR, "ladoga_points_aggregated.json"), JSON.stringify(markers, null, 2), "utf8");
fs.writeFileSync(path.join(WORK_DIR, "ladoga_reports_final.json"), JSON.stringify(records, null, 2), "utf8");
fs.writeFileSync(path.join(WORK_DIR, "ladoga_clusters_final.json"), JSON.stringify(allClusters, null, 2), "utf8");

console.log(JSON.stringify(summary, null, 2));
