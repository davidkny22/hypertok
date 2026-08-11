import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../common/timing.mjs";

const [runtimePath, outputPath, nText, vocabularyJson] = process.argv.slice(2);
const n = Number(nText);
const vocabularies = JSON.parse(
  vocabularyJson ?? process.env.HYPERTOK_COLD_VOCABULARIES ?? "null",
);
if (
  !runtimePath ||
  !outputPath ||
  !Number.isInteger(n) ||
  n < 11 ||
  !Array.isArray(vocabularies) ||
  vocabularies.length === 0
) {
  throw new Error("usage: measure_public_account.mjs runtime output n>=11 vocabularies-json");
}

const modes = ["default", "bytes", "module", "warm"];
const numericFields = [
  "totalMilliseconds",
  "preBindingMilliseconds",
  "bindingMilliseconds",
  "reservedNamesMilliseconds",
  "vocabularyDigestMilliseconds",
  "workerImageExportMilliseconds",
  "publicWrapperResidualMilliseconds",
];
const sampleScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "account_public_sample.mjs",
);
const rows = [];

for (const vocabulary of vocabularies) {
  const samples = Object.fromEntries(modes.map((mode) => [mode, []]));
  let expectedDigest;
  let expectedTokenCount;
  for (let index = 0; index < n; index += 1) {
    const offset = index % modes.length;
    const order = [...modes.slice(offset), ...modes.slice(0, offset)];
    for (const mode of order) {
      const run = childProcess.spawnSync(
        process.execPath,
        [sampleScript, runtimePath, vocabulary.path, mode],
        { encoding: "utf8", windowsHide: true, maxBuffer: 1_000_000 },
      );
      if (run.status !== 0) {
        throw new Error(
          `${vocabulary.id}/${mode} sample ${index} failed: ${run.stderr || run.stdout}`,
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
        throw new Error(`${vocabulary.id}/${mode} changed exact public output`);
      }
      samples[mode].push(sample);
    }
  }

  const configurations = Object.fromEntries(modes.map((mode) => [
    mode,
    Object.fromEntries(numericFields.map((field) => [
      field,
      summarize(samples[mode].map((sample) => sample[field])),
    ])),
  ]));
  const pairedTerms = {
    fileRead: summarize(samples.default.map((sample, index) =>
      sample.preBindingMilliseconds - samples.bytes[index].preBindingMilliseconds)),
    wasmCompile: summarize(samples.bytes.map((sample, index) =>
      sample.preBindingMilliseconds - samples.module[index].preBindingMilliseconds)),
    wasmInstantiation: summarize(samples.module.map((sample, index) =>
      sample.preBindingMilliseconds - samples.warm[index].preBindingMilliseconds)),
    initializedGlue: summarize(samples.warm.map((sample) => sample.preBindingMilliseconds)),
  };
  rows.push({
    vocabulary: vocabulary.id,
    outputDigest: expectedDigest,
    tokenCount: expectedTokenCount,
    configurations,
    pairedTerms,
    samples,
  });
}

const report = {
  schemaVersion: 1,
  environment: `${process.version} fresh process per sample`,
  clockRegime: "performance.now; runtime module and vocabulary loaded before timing",
  n,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
