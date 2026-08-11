import fs from "node:fs";
import path from "node:path";

const [inputDirectory, outputJson, outputMarkdown] = process.argv.slice(2);
if (!inputDirectory || !outputJson || !outputMarkdown) {
  throw new Error(
    "usage: composed-feature-verdict.mjs input-directory output.json output.md",
  );
}

const driftFloor = 0.97831;
const winThreshold = 1 / driftFloor;
const comparisonIds = ["selected-combined", "force-combined", "scratch-combined"];
const priorWarmDriftBreaches = new Set([
  "gpt2/source-code/encode",
  "o200k/english-prose/encode",
  "o200k/english-prose/decode",
  "o200k/source-code/decode",
  "o200k/emoji-heavy/encode",
  "o200k/long-document/decode",
  "o200k/standard-text/decode",
]);

function readReport(name) {
  return JSON.parse(fs.readFileSync(path.join(inputDirectory, name), "utf8"));
}

function classify(ratio) {
  if (ratio < driftFloor) return "material-loss";
  if (ratio > winThreshold) return "material-win";
  return "within-drift";
}

function adjustedRatio(ratio) {
  return classify(ratio) === "within-drift" ? 1 : ratio;
}

function geometricMean(values) {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

function summarize(rows) {
  const ratios = rows.map(({ ratio }) => ratio);
  const adjustedRatios = ratios.map(adjustedRatio);
  return {
    rows: rows.length,
    rawGeometricMean: geometricMean(ratios),
    driftAdjustedGeometricMean: geometricMean(adjustedRatios),
    materialWins: rows.filter(({ ratio }) => classify(ratio) === "material-win").length,
    materialLosses: rows.filter(({ ratio }) => classify(ratio) === "material-loss").length,
    withinDrift: rows.filter(({ ratio }) => classify(ratio) === "within-drift").length,
    minimumRatio: Math.min(...ratios),
    maximumRatio: Math.max(...ratios),
  };
}

const fresh = {};
for (const comparison of comparisonIds) {
  const rows = [];
  for (const tier of ["single", "worker"]) {
    const report = readReport(`fresh-${tier}-${comparison}-n21.json`);
    if (report.sampleCount !== 21) throw new Error(`${tier}/${comparison} did not use n=21`);
    for (const row of report.rows) {
      if (tier === "worker" && row.exact.workerCalls <= 1) {
        throw new Error(`${row.vocabulary}/${comparison} did not engage the worker route`);
      }
      rows.push({
        tier,
        vocabulary: row.vocabulary,
        axis: "encode",
        baselineMedianMs: row.baseline.median,
        candidateMedianMs: row.candidate.median,
        ratio: row.baselineOverCandidate,
        classification: classify(row.baselineOverCandidate),
        workerCalls: row.exact.workerCalls,
        exact: true,
      });
    }
  }
  fresh[comparison] = { summary: summarize(rows), rows };
}

const warm = {};
for (const comparison of comparisonIds) {
  const report = readReport(`warm-${comparison}-n21.json`);
  if (report.n !== 21) throw new Error(`${comparison} did not use n=21`);
  const rows = report.rows.flatMap((row) => ["encode", "decode"].map((axis) => {
    const measurement = row[axis];
    const key = `${row.vocabulary}/${row.workload}/${axis}`;
    return {
      vocabulary: row.vocabulary,
      workload: row.workload,
      axis,
      baselineMedianMs: measurement.baseline.median,
      candidateMedianMs: measurement.candidate.median,
      ratio: measurement.baselineOverCandidate,
      classification: classify(measurement.baselineOverCandidate),
      priorScratchDriftBreach: priorWarmDriftBreaches.has(key),
      exact: true,
    };
  }));
  if (rows.length !== 28) throw new Error(`${comparison} has ${rows.length} warm axes, expected 28`);
  warm[comparison] = { summary: summarize(rows), rows };
}

const selectedFresh = fresh["selected-combined"].summary;
const selectedWarm = warm["selected-combined"].summary;
const scratchContributionFresh = fresh["force-combined"].summary;
const scratchContributionWarm = warm["force-combined"].summary;
const forceContributionFresh = fresh["scratch-combined"].summary;
const forceContributionWarm = warm["scratch-combined"].summary;
const ships = selectedFresh.driftAdjustedGeometricMean > 1
  && selectedWarm.driftAdjustedGeometricMean > 1
  && selectedFresh.materialLosses === 0
  && selectedWarm.materialLosses === 0
  && scratchContributionFresh.driftAdjustedGeometricMean >= 1
  && scratchContributionWarm.driftAdjustedGeometricMean >= 1
  && scratchContributionFresh.materialWins + scratchContributionWarm.materialWins > 0
  && forceContributionFresh.driftAdjustedGeometricMean >= 1
  && forceContributionWarm.driftAdjustedGeometricMean >= 1
  && forceContributionFresh.materialWins + forceContributionWarm.materialWins > 0;

const report = {
  schemaVersion: 1,
  driftFloor,
  winThreshold,
  ratioDirection: "values above one favor combined",
  sampleCount: 21,
  fresh,
  warm,
  decision: {
    ships,
    disposition: ships ? "ship-combined" : "reject-combined",
    reasons: ships ? [] : [
      `fresh selected-versus-combined has ${selectedFresh.materialLosses} material losses`,
      `warm selected-versus-combined has ${selectedWarm.materialLosses} material losses`,
      `force contribution adjusted means are ${forceContributionFresh.driftAdjustedGeometricMean} fresh and ${forceContributionWarm.driftAdjustedGeometricMean} warm`,
    ],
  },
};

function number(value) {
  return value.toFixed(6);
}

const markdown = [
  "# Force-split plus scratch-reuse composed verdict",
  "",
  `Drift interval: ${number(driftFloor)} through ${number(winThreshold)}. Ratios above one favor combined.`,
  "",
  "## Summary",
  "",
  "| Regime | Comparison | Raw GM | Adjusted GM | Wins | Losses | Within drift |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
];
for (const [regime, comparisons] of Object.entries({ fresh, warm })) {
  for (const comparison of comparisonIds) {
    const summary = comparisons[comparison].summary;
    markdown.push(
      `| ${regime} | ${comparison} | ${number(summary.rawGeometricMean)} | ${number(summary.driftAdjustedGeometricMean)} | ${summary.materialWins} | ${summary.materialLosses} | ${summary.withinDrift} |`,
    );
  }
}

markdown.push("", "## Fresh rows", "");
for (const comparison of comparisonIds) {
  markdown.push(
    `### ${comparison}`,
    "",
    "| Tier | Vocabulary | Baseline ms | Combined ms | Ratio | Class | Worker calls |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: |",
  );
  for (const row of fresh[comparison].rows) {
    markdown.push(
      `| ${row.tier} | ${row.vocabulary} | ${number(row.baselineMedianMs)} | ${number(row.candidateMedianMs)} | ${number(row.ratio)} | ${row.classification} | ${row.workerCalls} |`,
    );
  }
  markdown.push("");
}

markdown.push("## Warm rows", "");
for (const comparison of comparisonIds) {
  markdown.push(
    `### ${comparison}`,
    "",
    "| Vocabulary | Workload | Axis | Baseline ms | Combined ms | Ratio | Class | Prior breach |",
    "| --- | --- | --- | ---: | ---: | ---: | --- | --- |",
  );
  for (const row of warm[comparison].rows) {
    markdown.push(
      `| ${row.vocabulary} | ${row.workload} | ${row.axis} | ${number(row.baselineMedianMs)} | ${number(row.candidateMedianMs)} | ${number(row.ratio)} | ${row.classification} | ${row.priorScratchDriftBreach ? "yes" : "no"} |`,
    );
  }
  markdown.push("");
}

markdown.push(
  "## Decision",
  "",
  ships
    ? "The combined configuration meets the composed ship bar."
    : "The combined configuration fails the composed ship bar and does not enter the shipping graph.",
  "",
);

fs.mkdirSync(path.dirname(outputJson), { recursive: true });
fs.mkdirSync(path.dirname(outputMarkdown), { recursive: true });
fs.writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(outputMarkdown, `${markdown.join("\n")}\n`);
process.stdout.write(`${JSON.stringify(report.decision)}\n`);
