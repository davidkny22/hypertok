import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadCorpus } from "../common/corpus.mjs";
import { summarize } from "../common/timing.mjs";

const [runtimePath, outputPath, nText, vocabularyJson, configurationJson] = process.argv.slice(2);
const n = Number(nText);
const vocabularies = JSON.parse(vocabularyJson ?? process.env.HYPERTOK_COLD_VOCABULARIES ?? "null");
const configurations = JSON.parse(
  configurationJson ?? process.env.HYPERTOK_COLD_CONFIGURATIONS ?? "null",
);
if (
  !runtimePath ||
  !outputPath ||
  !Number.isInteger(n) ||
  n < 3 ||
  !Array.isArray(vocabularies) ||
  vocabularies.length === 0 ||
  !Array.isArray(configurations) ||
  configurations.length !== 2
) {
  throw new Error(
    "usage: measure_runtime.mjs runtime output n [vocabularies-json configurations-json]",
  );
}

function equalIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function measurePair(baseline, candidate, nSamples) {
  const baselineSamples = [];
  const candidateSamples = [];
  for (let index = -2; index < nSamples; index += 1) {
    const order = index % 2 === 0
      ? [[baseline, baselineSamples], [candidate, candidateSamples]]
      : [[candidate, candidateSamples], [baseline, baselineSamples]];
    for (const [operation, samples] of order) {
      const started = performance.now();
      operation();
      const elapsed = performance.now() - started;
      if (index >= 0) samples.push(elapsed);
    }
  }
  const baselineSummary = summarize(baselineSamples);
  const candidateSummary = summarize(candidateSamples);
  return {
    baseline: baselineSummary,
    candidate: candidateSummary,
    baselineOverCandidate: baselineSummary.median / candidateSummary.median,
    candidateOverBaseline: candidateSummary.median / baselineSummary.median,
  };
}

function repeat(operation, count) {
  return () => {
    for (let index = 0; index < count; index += 1) operation();
  };
}

const runtimeModule = await import(pathToFileURL(path.resolve(runtimePath)).href);
const workloads = loadCorpus();
const rows = [];
for (const vocabulary of vocabularies) {
  const vocabularyBytes = new Uint8Array(fs.readFileSync(vocabulary.path));
  const handles = [];
  try {
    for (const configuration of configurations) {
      const moduleSource = new Uint8Array(fs.readFileSync(configuration.moduleSource));
      handles.push(await runtimeModule.fromBytes(vocabularyBytes, {
        tier: "single",
        moduleSource,
      }));
    }
    const [baseline, candidate] = handles;
    for (const workload of workloads) {
      const baselineIds = baseline.encodeSync(workload.text);
      const candidateIds = candidate.encodeSync(workload.text);
      if (!equalIds(baselineIds, candidateIds)) {
        throw new Error(`${vocabulary.id}/${workload.id} encode output changed`);
      }
      if (baseline.decode(baselineIds) !== workload.text) {
        throw new Error(`${vocabulary.id}/${workload.id} baseline decode changed text`);
      }
      if (candidate.decode(baselineIds) !== workload.text) {
        throw new Error(`${vocabulary.id}/${workload.id} candidate decode changed text`);
      }
      const repetitions = Math.max(1, Math.ceil(5_000_000 / workload.bytes));
      rows.push({
        vocabulary: vocabulary.id,
        workload: workload.id,
        bytes: workload.bytes,
        ids: baselineIds.length,
        repetitions,
        encode: measurePair(
          repeat(() => baseline.encodeSync(workload.text), repetitions),
          repeat(() => candidate.encodeSync(workload.text), repetitions),
          n,
        ),
        decode: measurePair(
          repeat(() => baseline.decode(baselineIds), repetitions),
          repeat(() => candidate.decode(baselineIds), repetitions),
          n,
        ),
      });
    }
  } finally {
    for (const handle of handles) handle.free();
  }
}

const report = {
  schemaVersion: 1,
  environment: `${process.version} same-session alternating artifact pair`,
  clockRegime: "performance.now; two warmups outside timing",
  n,
  configurations,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
