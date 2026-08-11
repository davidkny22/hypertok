import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../common/timing.mjs";

const [runtimePath, outputPath, freshNText, memoryNText, vocabularyJson, configurationJson, inputPathArg] =
  process.argv.slice(2);
const freshN = Number(freshNText);
const memoryN = Number(memoryNText);
const vocabularies = JSON.parse(
  vocabularyJson ?? process.env.HYPERTOK_COMPACT_VOCABULARIES ?? "null",
);
const configurations = JSON.parse(
  configurationJson ?? process.env.HYPERTOK_COMPACT_CONFIGURATIONS ?? "null",
);
const inputPath = inputPathArg ?? process.env.HYPERTOK_COMPACT_INPUT;
if (
  !runtimePath ||
  !outputPath ||
  !inputPath ||
  !Number.isInteger(freshN) ||
  freshN < 3 ||
  !Number.isInteger(memoryN) ||
  memoryN < 5 ||
  !Array.isArray(vocabularies) ||
  vocabularies.length === 0 ||
  !Array.isArray(configurations) ||
  configurations.length !== 2
) {
  throw new Error(
    "usage: measure.mjs runtime output freshN memoryN vocabularies-json configurations-json input",
  );
}

const sampleScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "sample.mjs");
const run = (mode, vocabulary, configuration) => {
  const args = mode === "memory" ? ["--expose-gc", sampleScript] : [sampleScript];
  args.push(mode, runtimePath, vocabulary.path, configuration.moduleSource);
  if (mode !== "memory") args.push(inputPath);
  const result = childProcess.spawnSync(process.execPath, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2_000_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
const pairedSummary = (baseline, candidate, field) => {
  const baselineSummary = summarize(baseline.map((sample) => sample[field]));
  const candidateSummary = summarize(candidate.map((sample) => sample[field]));
  return {
    baseline: baselineSummary,
    candidate: candidateSummary,
    candidateOverBaseline: candidateSummary.median / baselineSummary.median,
    baselineOverCandidate: baselineSummary.median / candidateSummary.median,
  };
};
const signedSummary = (values) => {
  const summary = summarize(values);
  return { ...summary, minimum: Math.min(...values), maximum: Math.max(...values) };
};

const rows = [];
for (const vocabulary of vocabularies) {
  const samples = {
    memory: new Map(configurations.map(({ id }) => [id, []])),
    encode: new Map(configurations.map(({ id }) => [id, []])),
    decode: new Map(configurations.map(({ id }) => [id, []])),
  };
  const expectedByMode = new Map();
  for (const [mode, count] of [["memory", memoryN], ["encode", freshN], ["decode", freshN]]) {
    for (let index = 0; index < count; index += 1) {
      const ordered = index % 2 === 0 ? configurations : [...configurations].reverse();
      for (const configuration of ordered) {
        const sample = run(mode, vocabulary, configuration);
        const expected = expectedByMode.get(mode) ?? {
          idDigest: sample.idDigest,
          tokenCount: sample.tokenCount,
          vocabSize: sample.vocabSize,
        };
        expectedByMode.set(mode, expected);
        if (
          sample.idDigest !== expected.idDigest ||
          sample.tokenCount !== expected.tokenCount ||
          sample.vocabSize !== expected.vocabSize ||
          sample.tier !== "single"
        ) {
          throw new Error(`${vocabulary.id}/${mode}/${configuration.id} changed exact output`);
        }
        samples[mode].get(configuration.id).push(sample);
      }
    }
  }
  const [baseline, candidate] = configurations.map(({ id }) => id);
  const baselineMemory = samples.memory.get(baseline);
  const candidateMemory = samples.memory.get(candidate);
  rows.push({
    vocabulary: vocabulary.id,
    exact: Object.fromEntries(expectedByMode),
    memory: {
      baseline: summarize(baselineMemory.map((sample) => sample.delta.rss)),
      candidate: summarize(candidateMemory.map((sample) => sample.delta.rss)),
      recoveredBytes: signedSummary(
        baselineMemory.map((sample, index) => sample.delta.rss - candidateMemory[index].delta.rss),
      ),
    },
    fresh: {
      encode: pairedSummary(samples.encode.get(baseline), samples.encode.get(candidate), "milliseconds"),
      decode: pairedSummary(samples.decode.get(baseline), samples.decode.get(candidate), "milliseconds"),
    },
    samples: Object.fromEntries(
      Object.entries(samples).map(([mode, byConfiguration]) => [mode, Object.fromEntries(byConfiguration)]),
    ),
  });
}

const report = {
  schemaVersion: 1,
  environment: `${process.version} paired fresh processes with explicit GC for memory`,
  clockRegime: "performance.now; fresh tokenizer per throughput sample; construction excluded",
  freshN,
  memoryN,
  configurations,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
