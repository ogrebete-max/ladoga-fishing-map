import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outputDir = path.join(root, "outputs");

const expectedFiles = [
  "ladoga_points_map.html",
  "ladoga_points.csv",
  "ladoga_reports.csv",
  "ladoga_cluster_statistics.csv",
  "fishermap_novaya_ladoga_all_170.csv",
  "starting_points_coverage.csv",
  "ladoga_points.geojson",
  "ladoga_points.gpx",
  "ladoga_cluster_statistics.md",
  "ladoga_points.xlsx",
];

for (const file of expectedFiles) {
  const stat = fs.statSync(path.join(outputDir, file));
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty: ${file}`);
}

const csvExpectations = {
  "ladoga_points.csv": 191,
  "ladoga_reports.csv": 202,
  "ladoga_cluster_statistics.csv": 48,
  "fishermap_novaya_ladoga_all_170.csv": 170,
  "starting_points_coverage.csv": 33,
};
const csvChecks = {};
for (const [file, expectedRows] of Object.entries(csvExpectations)) {
  const text = fs.readFileSync(path.join(outputDir, file), "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(text);
  if (rows.length - 1 !== expectedRows) {
    throw new Error(`${file}: expected ${expectedRows} data rows, got ${rows.length - 1}`);
  }
  const width = rows[0].length;
  const malformed = rows.findIndex((row) => row.length !== width);
  if (malformed >= 0) throw new Error(`${file}: malformed row ${malformed + 1}`);
  csvChecks[file] = { data_rows: rows.length - 1, columns: width };
}

const coverage = parseCsv(fs.readFileSync(path.join(outputDir, "starting_points_coverage.csv"), "utf8").replace(/^\uFEFF/, ""));
const coverageHeader = coverage[0];
const coveredByIndex = coverageHeader.indexOf("covered_by");
if (coveredByIndex < 0 || coverage.slice(1).some((row) => !row[coveredByIndex])) {
  throw new Error("Not every starting point has a covering record");
}
const coverageObjects = coverage.slice(1).map((row) => Object.fromEntries(coverageHeader.map((header, index) => [header, row[index] ?? ""])));
const statisticalCoverage = coverageObjects.filter((row) => row.included_in_statistics === "true");
const landmarkCoverage = coverageObjects.filter((row) => row.included_in_statistics === "false");
const exactLegacyCoverage = statisticalCoverage.filter((row) => row.confidence_class === "A");
if (statisticalCoverage.length !== 31 || landmarkCoverage.length !== 2 || exactLegacyCoverage.length !== 16) {
  throw new Error("Previous-chat coverage classification mismatch");
}
const finalReports = JSON.parse(fs.readFileSync(path.join(root, "work", "ladoga_reports_final.json"), "utf8"));
const reportsById = new Map(finalReports.map((row) => [row.record_id, row]));
for (const row of statisticalCoverage) {
  const report = reportsById.get(row.covered_by);
  if (!report) throw new Error(`Missing covering report: ${row.covered_by}`);
  if (row.confidence_class === "A" && report.confidence_class !== "A") {
    throw new Error(`Class A was not restored for ${row.id}`);
  }
}

const geojson = JSON.parse(fs.readFileSync(path.join(outputDir, "ladoga_points.geojson"), "utf8"));
if (geojson.type !== "FeatureCollection" || geojson.features.length !== 191) throw new Error("GeoJSON feature count mismatch");
for (const feature of geojson.features) {
  if (feature.geometry?.type !== "Point") throw new Error("GeoJSON contains non-point geometry");
  const [longitude, latitude] = feature.geometry.coordinates;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("GeoJSON contains invalid coordinate");
}

const gpx = fs.readFileSync(path.join(outputDir, "ladoga_points.gpx"), "utf8");
const gpxWaypoints = (gpx.match(/<wpt\s/g) || []).length;
if (!gpx.startsWith("<?xml") || gpxWaypoints !== 191) throw new Error("GPX validation failed");

const html = fs.readFileSync(path.join(outputDir, "ladoga_points_map.html"), "utf8");
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
if (inlineScripts.length === 0) throw new Error("No inline map script found");
for (const [index, script] of inlineScripts.entries()) {
  try {
    new Function(script);
  } catch (error) {
    throw new Error(`Inline map script ${index} is invalid: ${error.message}`);
  }
}
const requiredMapTokens = ["markerClusterGroup", "heatLayer", "L.control.layers", "reports_count", "confidence_class"];
for (const token of requiredMapTokens) {
  if (!html.includes(token)) throw new Error(`Map is missing ${token}`);
}

const xlsxSize = fs.statSync(path.join(outputDir, "ladoga_points.xlsx")).size;
if (xlsxSize < 20_000) throw new Error("Workbook is unexpectedly small");

console.log(JSON.stringify({
  status: "OK",
  files: expectedFiles.length,
  csv: csvChecks,
  geojson_features: geojson.features.length,
  gpx_waypoints: gpxWaypoints,
  inline_scripts_parsed: inlineScripts.length,
  previous_chat_fishing_points: statisticalCoverage.length,
  previous_chat_landmarks: landmarkCoverage.length,
  previous_chat_exact_gps: exactLegacyCoverage.length,
  workbook_bytes: xlsxSize,
}, null, 2));

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
  return rows.filter((candidate) => candidate.some((value) => value !== ""));
}
