import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { comparisonNoise } from "../common/verdict_sampling.mjs";
import { summarize } from "../common/timing.mjs";

const [runtimePath, outputPath, configurationsJson, vocabulariesJson] = process.argv.slice(2);
const configurations = JSON.parse(
  configurationsJson ?? process.env.HYPERTOK_COLD_CONFIGURATIONS ?? "null",
);
const vocabularies = JSON.parse(
  vocabulariesJson ?? process.env.HYPERTOK_COLD_VOCABULARIES ?? "null",
);
if (
  !runtimePath ||
  !outputPath ||
  !Array.isArray(configurations) ||
  configurations.length !== 2 ||
  !Array.isArray(vocabularies) ||
  vocabularies.length === 0
) {
  throw new Error(
    "usage: measure_trusted_pair.mjs runtime output configurations-json vocabularies-json",
  );
}

const initialN = 5;
const maximumN = 11;
const sampleScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "trust_only_sample.mjs");
const rows = [];

function runSample(vocabulary, configuration, index) {
  const run = childProcess.spawnSync(process.execPath, [
    sampleScript,
    runtimePath,
    configuration.module,
    configuration.wasm,
    vocabulary.path,
    "trusted",
  ], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1_000_000,
  });
  if (run.status !== 0) {
    throw new Error(
      `${vocabulary.id}/${configuration.id} sample ${index} failed: ${run.stderr || run.stdout}`,
    );
  }
  return JSON.parse(run.stdout);
}

for (const vocabulary of vocabularies) {
  const samples = new Map(configurations.map(({ id }) => [id, []]));
  let expectedDigest;
  let expectedTokenCount;
  const collectThrough = (targetN) => {
    for (let index = samples.get(configurations[0].id).length; index < targetN; index += 1) {
      const ordered = index % 2 === 0 ? configurations : [...configurations].reverse();
      for (const configuration of ordered) {
        const sample = runSample(vocabulary, configuration, index);
        expectedDigest ??= sample.outputDigest;
        expectedTokenCount ??= sample.tokenCount;
        if (
          sample.outputDigest !== expectedDigest ||
          sample.tokenCount !== expectedTokenCount ||
          sample.tier !== "single"
        ) {
          throw new Error(`${vocabulary.id}/${configuration.id} changed exact public output`);
        }
        samples.get(configuration.id).push(sample);
      }
    }
  };

  const summarizeConfiguration = ({ id }) => summarize(
    samples.get(id).map(({ constructionMilliseconds }) => constructionMilliseconds),
  );
  collectThrough(initialN);
  let summaries = configurations.map(summarizeConfiguration);
  const initialNoise = comparisonNoise(summaries[1], summaries[0]);
  if (!initialNoise.resolved) {
    collectThrough(maximumN);
    summaries = configurations.map(summarizeConfiguration);
  }
  rows.push({
    vocabulary: vocabulary.id,
    outputDigest: expectedDigest,
    tokenCount: expectedTokenCount,
    sampling: {
      initialN,
      finalN: summaries[0].n,
      maximumN,
      escalated: summaries[0].n > initialN,
      initialNoise,
    },
    configurations: configurations.map(({ id }, index) => ({
      id,
      construction: summaries[index],
      samples: samples.get(id),
    })),
    comparison: comparisonNoise(summaries[1], summaries[0]),
  });
}

const report = {
  schemaVersion: 1,
  environment: `${process.version} fresh process per sample`,
  clockRegime: "performance.now; modules, wasm bytes, and vocabulary bytes loaded before timing",
  publicEntry: path.resolve(runtimePath),
  configurations: configurations.map(({ id }) => id),
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
