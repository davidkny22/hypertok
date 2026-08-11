import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../common/timing.mjs";

const [outputPath, sampleCountText] = process.argv.slice(2);
const sampleCount = Number(sampleCountText);
const vocabularies = JSON.parse(process.env.HYPERTOK_OVERLAP_VOCABULARIES ?? "null");
const configurations = JSON.parse(process.env.HYPERTOK_OVERLAP_CONFIGURATIONS ?? "null");
const inputPath = process.env.HYPERTOK_OVERLAP_INPUT;
const tier = process.env.HYPERTOK_OVERLAP_TIER ?? "worker";
if (
  !outputPath ||
  !Number.isInteger(sampleCount) ||
  sampleCount < 3 ||
  !Array.isArray(vocabularies) ||
  vocabularies.length === 0 ||
  !Array.isArray(configurations) ||
  configurations.length !== 2 ||
  !inputPath ||
  !["single", "worker"].includes(tier)
) {
  throw new Error("measure.mjs requires output, n, two configurations, vocabularies, and input");
}

const sampleScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "sample.mjs");
const run = (vocabulary, configuration) => {
  const result = childProcess.spawnSync(
    process.execPath,
    [sampleScript, configuration.runtimePath, vocabulary.path, inputPath, tier],
    { encoding: "utf8", windowsHide: true, maxBuffer: 2_000_000 },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const rows = [];
for (const vocabulary of vocabularies) {
  const samples = new Map(configurations.map(({ id }) => [id, []]));
  let expected;
  for (let index = 0; index < sampleCount; index += 1) {
    const ordered = index % 2 === 0 ? configurations : [...configurations].reverse();
    for (const configuration of ordered) {
      const sample = run(vocabulary, configuration);
      const actual = {
        idDigest: sample.idDigest,
        tokenCount: sample.tokenCount,
        vocabSize: sample.vocabSize,
        workerCalls: sample.workerStats.calls,
        workerEntries: sample.workerStats.entries,
        workerInputBytes: sample.workerStats.inputBytes,
      };
      expected ??= actual;
      for (const [field, value] of Object.entries(expected)) {
        if (actual[field] !== value) {
          throw new Error(`${vocabulary.id}/${configuration.id} changed exact field ${field}`);
        }
      }
      samples.get(configuration.id).push(sample);
    }
  }
  const [baselineId, candidateId] = configurations.map(({ id }) => id);
  const baseline = summarize(samples.get(baselineId).map(({ milliseconds }) => milliseconds));
  const candidate = summarize(samples.get(candidateId).map(({ milliseconds }) => milliseconds));
  rows.push({
    vocabulary: vocabulary.id,
    exact: expected,
    baseline,
    candidate,
    candidateOverBaseline: candidate.median / baseline.median,
    baselineOverCandidate: baseline.median / candidate.median,
    samples: Object.fromEntries(samples),
  });
}

const report = {
  schemaVersion: 1,
  environment: `${process.version} worker_threads browser-worker adapter`,
  clockRegime: `performance.now; public ${tier} tier; fresh tokenizer; construction excluded`,
  sampleCount,
  configurations,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
