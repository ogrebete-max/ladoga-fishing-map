import fs from "node:fs";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const file = path.join(process.cwd(), "outputs", "ladoga_points.xlsx");
const buildSummary = JSON.parse(fs.readFileSync(path.join(process.cwd(), "work", "ladoga_build_summary.json"), "utf8"));
const blob = await FileBlob.load(file);
const workbook = await SpreadsheetFile.importXlsx(blob);
const summary = workbook.worksheets.getItem("Summary");
const values = summary.getRange("A1:I12").values;

const expected = [
  [3, 1, buildSummary.source_rows, "publications"],
  [3, 3, buildSummary.point_markers, "map points"],
  [3, 5, buildSummary.independent_reports, "independent weight"],
  [3, 7, buildSummary.fishermap_total_scanned, "FisherMap scanned"],
  [6, 4, buildSummary.class_counts.A, "class A"],
  [7, 4, buildSummary.class_counts.B, "class B"],
  [8, 4, buildSummary.class_counts.C, "class C"],
  [6, 7, buildSummary.fish_counts.zander, "zander"],
  [7, 7, buildSummary.fish_counts.pike, "pike"],
  [8, 7, buildSummary.fish_counts.perch, "perch"],
  [9, 7, buildSummary.fish_counts.roach, "roach"],
  [10, 7, buildSummary.fish_counts.bream, "bream"],
  [11, 7, buildSummary.fish_counts.other, "other fish"],
];
for (const [row, col, wanted, label] of expected) {
  const actual = Number(values[row][col]);
  if (actual !== wanted) throw new Error(`${label}: expected ${wanted}, got ${actual}`);
}

const startCoverage = workbook.worksheets.getItem("Start_Coverage").getRange("A1:N34").values;
if (startCoverage.length !== 34 || startCoverage.slice(1).filter((row) => row[0]).length !== 33) {
  throw new Error("Start_Coverage does not contain all 33 previous-chat rows");
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 300 },
  summary: "saved workbook formula error scan",
  maxChars: 3000,
});
if (!errors.ndjson.includes("matched 0 entries")) throw new Error(`Workbook formula errors found: ${errors.ndjson}`);

console.log(JSON.stringify({
  status: "OK",
  sheets: workbook.worksheets.items.map((sheet) => sheet.name),
  publications: Number(values[3][1]),
  map_points: Number(values[3][3]),
  fishermap_scanned: Number(values[3][7]),
  formula_errors: 0,
}, null, 2));
