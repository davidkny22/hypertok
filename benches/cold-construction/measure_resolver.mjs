import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../common/timing.mjs";

const [modulePath, wasmPath, outputPath, nText, vocabularyJson] = process.argv.slice(2);
const n = Number(nText);
const vocabularies = JSON.parse(
  vocabularyJson ?? process.env.HYPERTOK_COLD_VOCABULARIES ?? "null",
);
if (
  !modulePath ||
  !wasmPath ||
  !outputPath ||
  !Number.isInteger(n) ||
  n < 3 ||
  !Array.isArray(vocabularies) ||
  vocabularies.length === 0
) {
  throw new Error("usage: measure_resolver.mjs module wasm output n [vocabularies-json]");
}

const sampleScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "resolver_sample.mjs");
const modes = ["untrusted", "trusted"];
const rows = [];
for (const vocabulary of vocabularies) {
  const samples = new Map(modes.map((mode) => [mode, []]));
  let expectedDigest;
  let expectedTokenCount;
  let expectedWorkerImageBytes;
  for (let index = 0; index < n; index += 1) {
    const ordered = index % 2 === 0 ? modes : [...modes].reverse();
    for (const mode of ordered) {
      const run = childProcess.spawnSync(process.execPath, [
        sampleScript,
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
      const sample = JSON.parse(run.stdout);
      expectedDigest ??= sample.outputDigest;
      expectedTokenCount ??= sample.tokenCount;
      expectedWorkerImageBytes ??= sample.workerImageBytes;
      if (
        sample.outputDigest !== expectedDigest ||
        sample.tokenCount !== expectedTokenCount ||
        sample.workerImageBytes !== expectedWorkerImageBytes
      ) {
        throw new Error(`${vocabulary.id}/${mode} changed exact output or worker image size`);
      }
      samples.get(mode).push(sample);
    }
  }
  rows.push({
    vocabulary: vocabulary.id,
    outputDigest: expectedDigest,
    tokenCount: expectedTokenCount,
    workerImageBytes: expectedWorkerImageBytes,
    modes: modes.map((mode) => {
      const raw = samples.get(mode);
      return {
        mode,
        bindingReady: summarize(raw.map((sample) => sample.bindingReadyMilliseconds)),
        publicReady: summarize(raw.map((sample) => sample.publicReadyMilliseconds)),
        samples: raw,
      };
    }),
  });
}

const report = {
  schemaVersion: 1,
  environment: `${process.version} fresh process per sample`,
  clockRegime: "module and bytes loaded before timing; wasm init, construction, and worker-ready image acquisition timed",
  n,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
