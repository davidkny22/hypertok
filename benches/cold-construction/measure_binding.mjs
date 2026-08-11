import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../common/timing.mjs";

const [outputPath, nText, vocabularyJson, configurationJson] = process.argv.slice(2);
const n = Number(nText);
const vocabularies = JSON.parse(
  vocabularyJson ?? process.env.HYPERTOK_COLD_VOCABULARIES ?? "null",
);
const configurations = JSON.parse(
  configurationJson ?? process.env.HYPERTOK_COLD_CONFIGURATIONS ?? "null",
);
if (
  !outputPath ||
  !Number.isInteger(n) ||
  n < 3 ||
  !Array.isArray(vocabularies) ||
  vocabularies.length === 0 ||
  !Array.isArray(configurations) ||
  configurations.length === 0
) {
  throw new Error(
    "usage: measure_binding.mjs output n [vocabularies-json configurations-json]",
  );
}

const sampleScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "binding_sample.mjs");
const rows = [];
for (const vocabulary of vocabularies) {
  const byConfiguration = new Map(configurations.map(({ id }) => [id, []]));
  let expectedDigest;
  let expectedTokenCount;
  for (let index = 0; index < n; index += 1) {
    const ordered = index % 2 === 0 ? configurations : [...configurations].reverse();
    for (const configuration of ordered) {
      const run = childProcess.spawnSync(
        process.execPath,
        [sampleScript, configuration.moduleDirectory, vocabulary.path],
        { encoding: "utf8", windowsHide: true, maxBuffer: 2_000_000 },
      );
      if (run.status !== 0) {
        throw new Error(
          `${vocabulary.id}/${configuration.id} sample ${index} failed: ${run.stderr || run.stdout}`,
        );
      }
      const sample = JSON.parse(run.stdout);
      expectedDigest ??= sample.outputDigest;
      expectedTokenCount ??= sample.tokenCount;
      if (sample.outputDigest !== expectedDigest || sample.tokenCount !== expectedTokenCount) {
        throw new Error(`${vocabulary.id}/${configuration.id} changed exact binding output`);
      }
      byConfiguration.get(configuration.id).push(sample);
    }
  }
  rows.push({
    vocabulary: vocabulary.id,
    outputDigest: expectedDigest,
    tokenCount: expectedTokenCount,
    configurations: configurations.map(({ id }) => {
      const samples = byConfiguration.get(id);
      const stageNames = samples[0].constructionProfile.stages.map(({ name }) => name);
      if (samples.some((sample) =>
        JSON.stringify(sample.constructionProfile.stages.map(({ name }) => name)) !==
        JSON.stringify(stageNames))) {
        throw new Error(`${vocabulary.id}/${id} construction stage order changed`);
      }
      return {
        id,
        construction: summarize(samples.map((sample) => sample.constructionMilliseconds)),
        tracedTotal: summarize(samples.map((sample) => sample.constructionProfile.totalMilliseconds)),
        workerConstruction: summarize(samples.map((sample) => sample.workerMilliseconds)),
        workerTracedTotal: summarize(samples.map((sample) => sample.workerProfile.totalMilliseconds)),
        stages: Object.fromEntries(stageNames.map((name) => [
          name,
          summarize(samples.map((sample) =>
            sample.constructionProfile.stages.find((stage) => stage.name === name).milliseconds)),
        ])),
        samples,
      };
    }),
  });
}

const report = {
  schemaVersion: 1,
  environment: `${process.version} fresh process per sample`,
  clockRegime: "performance.now; vocabulary and binding loaded before timing",
  n,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
