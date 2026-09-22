import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const workDir = path.join(root, "work");
const outputDir = path.join(root, "outputs");
const previewDir = path.join(workDir, "workbook_previews");

const [summary, points, reports, clusters, fishermap, startCsv] = await Promise.all([
  readJson(path.join(workDir, "ladoga_build_summary.json")),
  readJson(path.join(workDir, "ladoga_points_aggregated.json")),
  readJson(path.join(workDir, "ladoga_reports_final.json")),
  readJson(path.join(workDir, "ladoga_clusters_final.json")),
  readJson(path.join(workDir, "fishermap_novaya_ladoga_locations.json")),
  fs.readFile(path.join(outputDir, "starting_points_coverage.csv"), "utf8"),
]);

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const workbook = Workbook.create();
const summarySheet = workbook.worksheets.add("Summary");
const pointsSheet = workbook.worksheets.add("Points");
const reportsSheet = workbook.worksheets.add("Reports");
const clustersSheet = workbook.worksheets.add("Clusters");
const fishermapSheet = workbook.worksheets.add("FisherMap_170");
const startSheet = workbook.worksheets.add("Start_Coverage");

const includedFishermap = new Map(
  reports
    .filter((r) => r.source === "FisherMap")
    .map((r) => [String(r.source_id), r])
);

const pointHeaders = [
  "marker_id", "latitude", "longitude", "fish", "source", "source_url", "source_id", "date",
  "sector", "confidence_class", "reports_count", "published_rows", "depth", "method", "catch",
  "nearest_landmark", "landmark_distance_km", "distance_from_novaya_ladoga_km", "context_reports_count",
  "comment", "record_ids",
];
const pointRows = points.map((p) => [
  p.marker_id, num(p.latitude), num(p.longitude), join(p.fish), p.source, p.source_url, String(p.source_id ?? ""),
  dateValue(p.date), p.sector, p.confidence_class, num(p.reports_count), num(p.published_rows), p.depth || "",
  p.method || "", p.catch || "", p.nearest_landmark || "", nullableNum(p.landmark_distance_km),
  nullableNum(p.distance_from_novaya_ladoga_km), nullableNum(p.context_reports_count), p.comment || "",
  join(p.record_ids),
]);

const reportHeaders = [
  "record_id", "latitude", "longitude", "fish", "source", "source_url", "source_id", "original_source_url",
  "date", "sector", "confidence_class", "reports_count", "depth", "method", "catch", "nearest_landmark",
  "landmark_distance_km", "distance_from_novaya_ladoga_km", "waterbody", "context_reports_count",
  "analysis_weight", "duplicate_of", "comment", "zander_flag", "pike_flag", "perch_flag", "roach_flag",
  "bream_flag", "other_flag",
];
const reportRows = reports.map((r) => {
  const flags = fishCategoryFlags(r.fish);
  const weight = num(r.analysis_weight);
  return [
    r.record_id, num(r.latitude), num(r.longitude), join(r.fish), r.source, r.source_url, String(r.source_id ?? ""),
    r.original_source_url || "", dateValue(r.date), r.sector, r.confidence_class, num(r.reports_count), r.depth || "",
    r.method || "", r.catch || "", r.nearest_landmark || "", nullableNum(r.landmark_distance_km),
    nullableNum(r.distance_from_novaya_ladoga_km), r.waterbody || "", nullableNum(r.context_reports_count),
    weight, r.duplicate_of || "", r.comment || "", flags.zander * weight, flags.pike * weight,
    flags.perch * weight, flags.roach * weight, flags.bream * weight, flags.other * weight,
  ];
});

const clusterHeaders = [
  "rank", "radius_m", "center_latitude", "center_longitude", "reports_count", "markers_count", "sector",
  "source_count", "sources", "zander_reports", "pike_reports", "perch_reports", "roach_reports",
  "bream_reports", "other_reports", "member_record_ids",
];
const clusterRows = clusters.map((c) => [
  num(c.rank), num(c.radius_m), num(c.center_latitude), num(c.center_longitude), num(c.reports_count),
  num(c.markers_count), c.sector, num(c.source_count), c.sources, num(c.zander_reports), num(c.pike_reports),
  num(c.perch_reports), num(c.roach_reports), num(c.bream_reports), num(c.other_reports), join(c.member_record_ids),
]);

const fishermapHeaders = [
  "location_id", "latitude", "longitude", "date", "fish", "lakes", "rivers", "embayments", "cities",
  "region", "county", "has_photos", "page_url", "original_source", "included_in_analysis", "sector",
];
const fishermapRows = fishermap.map((f) => {
  const included = includedFishermap.get(String(f.id));
  return [
    String(f.id), num(f.latitude), num(f.longitude), dateValue(String(f.date || "").slice(0, 10)), join(f.fish),
    join(f.lakes), join(f.rivers), join(f.embayments), join(f.cities), f.region || "", f.county || "",
    Boolean(f.has_photos), f.page_url || "", f.original_source || "", Boolean(included), included?.sector || "",
  ];
});

const startRowsParsed = parseCsv(startCsv);
const startHeaders = startRowsParsed.shift();
const startRows = startRowsParsed.map((row) => [
  row[0], num(row[1]), num(row[2]), row[3], row[4], row[5], row[6], row[7], row[8] === "true", row[9],
  row[10], row[11], nullableNum(row[12]), row[13] === "true",
]);

writeDataSheet(pointsSheet, "PointsTable", pointHeaders, pointRows, {
  widths: [14, 11, 11, 24, 28, 38, 16, 12, 29, 11, 12, 12, 12, 16, 18, 24, 14, 18, 18, 55, 50],
  dateCols: [8], decimalCols: [2, 3, 17, 18], integerCols: [11, 12, 19], wrapCols: [4, 5, 6, 9, 20, 21],
});
writeDataSheet(reportsSheet, "ReportsTable", reportHeaders, reportRows, {
  widths: [22, 11, 11, 24, 28, 38, 16, 38, 12, 29, 11, 12, 12, 16, 18, 24, 14, 18, 25, 18, 13, 22, 55, 12, 12, 12, 12, 12, 12],
  dateCols: [9], decimalCols: [2, 3, 17, 18], integerCols: [12, 20, 21, 24, 25, 26, 27, 28, 29], wrapCols: [4, 5, 6, 8, 10, 19, 23],
});
writeDataSheet(clustersSheet, "ClustersTable", clusterHeaders, clusterRows, {
  widths: [8, 11, 14, 14, 13, 13, 29, 12, 42, 13, 13, 13, 13, 13, 13, 70],
  decimalCols: [3, 4], integerCols: [1, 2, 5, 6, 8, 10, 11, 12, 13, 14, 15], wrapCols: [7, 9, 16],
});
writeDataSheet(fishermapSheet, "FisherMapTable", fishermapHeaders, fishermapRows, {
  widths: [13, 11, 11, 12, 24, 24, 22, 22, 28, 24, 22, 12, 38, 38, 18, 29],
  dateCols: [4], decimalCols: [2, 3], wrapCols: [5, 6, 7, 8, 9, 13, 14, 16],
});
writeDataSheet(startSheet, "StartCoverageTable", startHeaders, startRows, {
  widths: [16, 11, 11, 34, 28, 30, 24, 12, 18, 58, 13, 25, 12, 18],
  decimalCols: [2, 3, 13], wrapCols: [4, 5, 6, 7, 10, 12],
});

buildSummary(summarySheet);

workbook.recalculate();

const overview = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 7000,
  tableMaxRows: 4,
  tableMaxCols: 8,
  tableMaxCellChars: 60,
});
console.log("WORKBOOK_OVERVIEW");
console.log(overview.ndjson);

const summaryCheck = await workbook.inspect({
  kind: "region",
  sheetId: "Summary",
  range: "A1:I27",
  include: "values,formulas",
  maxChars: 7000,
});
console.log("SUMMARY_CHECK");
console.log(summaryCheck.ndjson);

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
  maxChars: 5000,
});
console.log("FORMULA_ERRORS");
console.log(formulaErrors.ndjson);

const renderSpecs = [
  ["Summary", "A1:I27", 1.4],
  ["Points", "A1:U18", 1],
  ["Reports", "A1:AC18", 0.9],
  ["Clusters", "A1:P18", 1],
  ["FisherMap_170", "A1:P18", 1],
  ["Start_Coverage", "A1:N20", 1],
];
for (const [sheetName, range, scale] of renderSpecs) {
  const preview = await workbook.render({ sheetName, range, scale, format: "png" });
  await fs.writeFile(path.join(previewDir, `${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(path.join(outputDir, "ladoga_points.xlsx"));

console.log(JSON.stringify({
  output: path.join(outputDir, "ladoga_points.xlsx"),
  points: points.length,
  reports: reports.length,
  clusters: clusters.length,
  fishermap: fishermap.length,
  start_points: startRows.length,
  previews: renderSpecs.map(([sheetName]) => path.join(previewDir, `${sheetName}.png`)),
}, null, 2));

function buildSummary(sheet) {
  sheet.showGridLines = false;
  sheet.tabColor = "#0B5563";
  sheet.getRange("A1:I1").format = { fill: "#16324F", font: { name: "Arial", size: 16, bold: true, color: "#FFFFFF" } };
  sheet.getRange("A1").values = [["Южная Ладога — массив публичной рыболовной активности"]];
  sheet.mergeCells("A1:I1");
  sheet.getRange("A1:I1").format.rowHeight = 30;
  sheet.getRange("A2:I2").format = { fill: "#DCEAF2", font: { name: "Arial", size: 10, color: "#29485A" } };
  sheet.getRange("A2").values = [["Статистический массив опубликованных геометок; не оценка фактического количества рыбы. Глубина сохранена только в данных и pop-up карты."]];
  sheet.mergeCells("A2:I2");
  sheet.getRange("A2:I2").format.rowHeight = 32;
  sheet.getRange("A2:I2").format.wrapText = true;

  sheet.getRange("A4:H4").values = [[
    "Публикаций", null, "Точек на карте", null, "Независимых", null, "FisherMap просмотрено", null,
  ]];
  sheet.getRange("B4").formulas = [[`=COUNTA(Reports!A2:A${reports.length + 1})`]];
  sheet.getRange("D4").formulas = [[`=COUNTA(Points!A2:A${points.length + 1})`]];
  sheet.getRange("F4").formulas = [[`=SUM(Reports!U2:U${reports.length + 1})`]];
  sheet.getRange("H4").formulas = [[`=COUNTA(FisherMap_170!A2:A${fishermap.length + 1})`]];
  for (const cell of ["A4", "C4", "E4", "G4"]) {
    sheet.getRange(cell).format = { fill: "#2F6F89", font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" }, wrapText: true };
  }
  for (const cell of ["B4", "D4", "F4", "H4"]) {
    sheet.getRange(cell).format = { fill: "#EAF4F7", font: { name: "Arial", size: 16, bold: true, color: "#16324F" }, horizontalAlignment: "center" };
    sheet.getRange(cell).format.numberFormat = "#,##0";
  }
  sheet.getRange("A4:H4").format.rowHeight = 34;

  sectionHeader(sheet, "A6:B6", "Источники");
  const sources = ["FisherMap", "fishing-report.ru", "Telegram: Рыболовная сводка Спб", "ПКР / fisher.spb.ru", "Предыдущее исследование"];
  sheet.getRange("A7:A11").values = sources.map((s) => [s]);
  sheet.getRange("B7:B11").formulas = sources.map((_, i) => [`=COUNTIF(Reports!E2:E${reports.length + 1},A${i + 7})`]);

  sectionHeader(sheet, "D6:E6", "Классы доверия");
  const classes = [["A — точный GPS", "A"], ["B — геометка отчёта", "B"], ["C — структура/архив", "C"]];
  sheet.getRange("D7:D9").values = classes.map(([label]) => [label]);
  sheet.getRange("E7:E9").formulas = classes.map(([, key]) => [`=COUNTIF(Reports!K2:K${reports.length + 1},\"${key}\")`]);

  sectionHeader(sheet, "G6:H6", "Рыба в независимых публикациях");
  const fish = ["Судак", "Щука", "Окунь", "Плотва", "Лещ", "Другое"];
  sheet.getRange("G7:G12").values = fish.map((x) => [x]);
  const fishColumns = ["X", "Y", "Z", "AA", "AB", "AC"];
  sheet.getRange("H7:H12").formulas = fishColumns.map((col) => [`=SUM(Reports!${col}2:${col}${reports.length + 1})`]);

  sheet.getRange("A7:H12").format.font = { name: "Arial", size: 10 };
  sheet.getRange("B7:B11").format.numberFormat = "#,##0";
  sheet.getRange("E7:E9").format.numberFormat = "#,##0";
  sheet.getRange("H7:H12").format.numberFormat = "#,##0";
  sheet.getRange("A7:B11").format.borders = thinBorders();
  sheet.getRange("D7:E9").format.borders = thinBorders();
  sheet.getRange("G7:H12").format.borders = thinBorders();

  sectionHeader(sheet, "A14:I14", "Самые плотные неперекрывающиеся окна 1 км");
  const top = clusters.filter((c) => c.radius_m === 1000).slice(0, 8);
  const topHeaders = ["Место", "Центр, широта", "Центр, долгота", "Отчётов", "Точек", "Источников", "Судак", "Щука", "Окунь"];
  sheet.getRange("A15:I15").values = [topHeaders];
  sheet.getRange(`A16:I${15 + top.length}`).values = top.map((c) => [
    c.sector, num(c.center_latitude), num(c.center_longitude), num(c.reports_count), num(c.markers_count),
    num(c.source_count), num(c.zander_reports), num(c.pike_reports), num(c.perch_reports),
  ]);
  sheet.getRange("A15:I15").format = { fill: "#2F6F89", font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" }, wrapText: true };
  sheet.getRange(`A16:I${15 + top.length}`).format.font = { name: "Arial", size: 10 };
  sheet.getRange(`B16:C${15 + top.length}`).format.numberFormat = "0.000000";
  sheet.getRange(`D16:I${15 + top.length}`).format.numberFormat = "#,##0";
  sheet.getRange(`A15:I${15 + top.length}`).format.borders = thinBorders();

  const noteRow = 25;
  sectionHeader(sheet, `A${noteRow}:I${noteRow}`, "Методика и ограничения");
  sheet.getRange(`A${noteRow + 1}:I${noteRow + 2}`).format = { fill: "#F4F7F9", font: { name: "Arial", size: 9, color: "#29485A" }, wrapText: true };
  sheet.getRange(`A${noteRow + 1}`).values = [["Кластеры рассчитаны по исходным рыболовным публикациям для радиусов 100, 250, 500 и 1000 м. Повторы источников не удалялись; вероятные кросс-публикации получают analysis_weight=0, но остаются в листе Reports."]];
  sheet.getRange(`A${noteRow + 2}`).values = [["Класс C — координата локальной структуры или архивного раздела. Число сообщений архива хранится как context_reports_count и не умножает статистическую плотность без индивидуальных координат."]];
  sheet.mergeCells(`A${noteRow + 1}:I${noteRow + 1}`);
  sheet.mergeCells(`A${noteRow + 2}:I${noteRow + 2}`);
  sheet.getRange(`A${noteRow + 1}:I${noteRow + 2}`).format.rowHeight = 30;

  const widths = [32, 13, 19, 28, 14, 10, 24, 13, 13];
  widths.forEach((w, idx) => sheet.getRange(`${columnName(idx + 1)}1:${columnName(idx + 1)}27`).format.columnWidth = w);
  sheet.freezePanes.freezeRows(2);
}

function writeDataSheet(sheet, tableName, headers, rows, options = {}) {
  sheet.showGridLines = false;
  sheet.tabColor = "#2F6F89";
  const matrix = [headers, ...rows];
  const endCol = columnName(headers.length);
  const endRow = matrix.length;
  sheet.getRange(`A1:${endCol}${endRow}`).values = matrix;
  sheet.getRange(`A1:${endCol}${endRow}`).format.font = { name: "Arial", size: 9 };
  const table = sheet.tables.add(`A1:${endCol}${endRow}`, true, tableName);
  table.style = "TableStyleMedium2";
  table.showBandedColumns = false;
  table.showFilterButton = true;
  sheet.getRange(`A1:${endCol}1`).format = {
    fill: "#16324F",
    font: { name: "Arial", size: 9, bold: true, color: "#FFFFFF" },
    wrapText: true,
    verticalAlignment: "center",
  };
  sheet.getRange(`A1:${endCol}1`).format.rowHeight = 32;
  sheet.freezePanes.freezeRows(1);
  sheet.freezePanes.freezeColumns(1);

  (options.widths || []).forEach((width, idx) => {
    sheet.getRange(`${columnName(idx + 1)}1:${columnName(idx + 1)}${endRow}`).format.columnWidth = width;
  });
  (options.dateCols || []).forEach((idx) => {
    sheet.getRange(`${columnName(idx)}2:${columnName(idx)}${endRow}`).format.numberFormat = "yyyy-mm-dd";
  });
  (options.decimalCols || []).forEach((idx) => {
    sheet.getRange(`${columnName(idx)}2:${columnName(idx)}${endRow}`).format.numberFormat = "0.000000";
  });
  (options.integerCols || []).forEach((idx) => {
    sheet.getRange(`${columnName(idx)}2:${columnName(idx)}${endRow}`).format.numberFormat = "#,##0";
  });
  (options.wrapCols || []).forEach((idx) => {
    sheet.getRange(`${columnName(idx)}2:${columnName(idx)}${endRow}`).format.wrapText = true;
  });
}

function sectionHeader(sheet, range, label) {
  sheet.getRange(range).format = { fill: "#16324F", font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" } };
  sheet.getRange(range.split(":")[0]).values = [[label]];
}

function thinBorders() {
  const border = { style: "continuous", color: "#CBD5E1", weight: 1 };
  return { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function join(value) {
  return Array.isArray(value) ? value.join("; ") : (value ?? "");
}

function fishCategoryFlags(fish) {
  const values = (Array.isArray(fish) ? fish : []).map((value) => String(value).toLowerCase().replace(/ё/g, "е"));
  const flags = { zander: 0, pike: 0, perch: 0, roach: 0, bream: 0, other: 0 };
  for (const value of values) {
    if (value.includes("судак")) flags.zander = 1;
    if (value.includes("щук")) flags.pike = 1;
    if (value.includes("окун")) flags.perch = 1;
    if (value.includes("плотв") || value.includes("сорож")) flags.roach = 1;
    if (value.includes("лещ") || value.includes("подлещик")) flags.bream = 1;
  }
  flags.other = values.length === 0 || values.some((value) => !(
    value.includes("судак") || value.includes("щук") || value.includes("окун") ||
    value.includes("плотв") || value.includes("сорож") || value.includes("лещ") || value.includes("подлещик")
  )) ? 1 : 0;
  return flags;
}

function dateValue(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function columnName(index) {
  let n = index;
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ""));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
