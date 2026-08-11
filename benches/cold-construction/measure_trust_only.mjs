import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { comparisonNoise } from "../common/verdict_sampling.mjs";
import { summarize } from "../common/timing.mjs";

const [runtimePath, modulePath, wasmPath, outputPath, vocabularyJson] = process.argv.slice(2);
const vocabularies = JSON.parse(
  vocabularyJson ?? process.env.HYPERTOK_COLD_VOCABULARIES ?? "null",
);
if (
  !runtimePath ||
  !modulePath ||
  !wasmPath ||
  !outputPath ||
  !Array.isArray(vocabularies) ||
  vocabularies.length === 0
) {
  throw new Error(
    "usage: measure_trust_only.mjs runtime module wasm output [vocabularies-json]",
  );
}

const initialN = 5;
const maximumN = 11;
const baselineMode = process.env.HYPERTOK_COLD_CONTROL_BASELINE === "resolver-control"
  ? "resolver-control"
  : "untrusted";
const modes = [baselineMode, "trusted", "trusted-touch"];
const sampleScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "trust_only_sample.mjs");

function runSample(vocabulary, mode, index) {
  const run = childProcess.spawnSync(process.execPath, [
    sampleScript,
    runtimePath,
    modulePath,
    wasmPath,
    vocabulary.path,
    mode,
  ], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1_000_000,
  });
  if (run.status !== 0) {
    throw new Error(`${vocabulary.id}/${mode} sample ${index} failed: ${run.stderr || run.stdout}`);
  }
  return JSON.parse(run.stdout);
}

const rows = [];
for (const vocabulary of vocabularies) {
  const samples = new Map(modes.map((mode) => [mode, []]));
  let expectedDigest;
  let expectedTokenCount;
  const collectThrough = (targetN) => {
    for (let index = samples.get(modes[0]).length; index < targetN; index += 1) {
      const ordered = index % 2 === 0 ? modes : [...modes].reverse();
      for (const mode of ordered) {
        const sample = runSample(vocabulary, mode, index);
        expectedDigest ??= sample.outputDigest;
        expectedTokenCount ??= sample.tokenCount;
        if (
          sample.outputDigest !== expectedDigest ||
          sample.tokenCount !== expectedTokenCount ||
          sample.tier !== "single"
        ) {
          throw new Error(`${vocabulary.id}/${mode} changed exact public output`);
        }
        samples.get(mode).push(sample);
      }
    }
  };

  collectThrough(initialN);
  const summarizeMode = (mode) => summarize(
    samples.get(mode).map(({ constructionMilliseconds }) => constructionMilliseconds),
  );
  const initialSummaries = Object.fromEntries(modes.map((mode) => [mode, summarizeMode(mode)]));
  const initialNoise = {
    trustOnly: comparisonNoise(initialSummaries.trusted, initialSummaries[baselineMode]),
    warming: comparisonNoise(initialSummaries["trusted-touch"], initialSummaries.trusted),
  };
  if (!initialNoise.trustOnly.resolved || !initialNoise.warming.resolved) {
    collectThrough(maximumN);
  }

  const summaries = Object.fromEntries(modes.map((mode) => [mode, summarizeMode(mode)]));
  rows.push({
    vocabulary: vocabulary.id,
    sourceBytes: fs.statSync(vocabulary.path).size,
    wireDeltaBytes: 0,
    outputDigest: expectedDigest,
    tokenCount: expectedTokenCount,
    sampling: {
      initialN,
      finalN: summaries.trusted.n,
      maximumN,
      escalated: summaries.trusted.n > initialN,
      initialNoise,
    },
    modes: modes.map((mode) => ({
      mode,
      construction: summaries[mode],
      samples: samples.get(mode),
    })),
    comparisons: {
      trustOnly: comparisonNoise(summaries.trusted, summaries[baselineMode]),
      warming: comparisonNoise(summaries["trusted-touch"], summaries.trusted),
      warmedAgainstBaseline: comparisonNoise(
        summaries["trusted-touch"],
        summaries[baselineMode],
      ),
    },
  });
}

const report = {
  schemaVersion: 1,
  environment: `${process.version} fresh process per sample`,
  clockRegime: "performance.now; modules, wasm bytes, and vocabulary bytes loaded before timing",
  publicEntry: path.resolve(runtimePath),
  baselineMode,
  policy: {
    initialN,
    maximumN,
    escalation: "escalate when the absolute log gap is below twice combined relative noise",
  },
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
