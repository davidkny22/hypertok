import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../common/timing.mjs";

const [runtimePath, outputPath, nText, vocabularyJson, configurationJson] = process.argv.slice(2);
const n = Number(nText);
const vocabularies = JSON.parse(
  vocabularyJson ?? process.env.HYPERTOK_COLD_VOCABULARIES ?? "null",
);
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
  configurations.length === 0
) {
  throw new Error(
    "usage: measure_public.mjs runtime output n [vocabularies-json configurations-json]",
  );
}

const sampleScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "public_sample.mjs");
const rows = [];
for (const vocabulary of vocabularies) {
  if (typeof vocabulary?.id !== "string" || typeof vocabulary?.path !== "string") {
    throw new TypeError("each vocabulary needs string id and path fields");
  }
  const samples = new Map(configurations.map(({ id }) => [id, []]));
  let expectedDigest;
  let expectedTokenCount;
  for (let index = 0; index < n; index += 1) {
    const ordered = index % 2 === 0 ? configurations : [...configurations].reverse();
    for (const configuration of ordered) {
      if (typeof configuration?.id !== "string") {
        throw new TypeError("each configuration needs a string id field");
      }
      const args = [sampleScript, runtimePath, vocabulary.path];
      if (configuration.moduleSource !== null && configuration.moduleSource !== undefined) {
        args.push(configuration.moduleSource);
      }
      const run = childProcess.spawnSync(process.execPath, args, {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1_000_000,
      });
      if (run.status !== 0) {
        throw new Error(
          `${vocabulary.id}/${configuration.id} sample ${index} failed: ${run.stderr || run.stdout}`,
        );
      }
      const sample = JSON.parse(run.stdout);
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
  rows.push({
    vocabulary: vocabulary.id,
    outputDigest: expectedDigest,
    tokenCount: expectedTokenCount,
    configurations: configurations.map(({ id }) => {
      const raw = samples.get(id);
      return {
        id,
        construction: summarize(raw.map((sample) => sample.constructionMilliseconds)),
        samples: raw,
      };
    }),
  });
}

const report = {
  schemaVersion: 1,
  environment: `${process.version} fresh process per sample`,
  clockRegime: "performance.now; vocabulary and benchmark module loaded before timing",
  publicEntry: path.resolve(runtimePath),
  n,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
