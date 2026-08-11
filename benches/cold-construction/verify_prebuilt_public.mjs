import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [runtimePath, baselineWasmPath, candidateWasmPath, vocabularyJson] = process.argv.slice(2);
const vocabularies = JSON.parse(vocabularyJson ?? process.env.HYPERTOK_COLD_VOCABULARIES ?? "null");
if (
  !runtimePath ||
  !baselineWasmPath ||
  !candidateWasmPath ||
  !Array.isArray(vocabularies) ||
  vocabularies.length === 0
) {
  throw new Error(
    "usage: verify_prebuilt_public.mjs runtime baseline-wasm candidate-wasm [vocabularies-json]",
  );
}

const sample = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "prebuilt_public_sample.mjs",
);
let exactCases = 0;
let mutationRefusals = 0;
for (const vocabulary of vocabularies) {
  const reference = runSample(runtimePath, baselineWasmPath, vocabulary.source, "exact");
  const prebuilt = runSample(runtimePath, candidateWasmPath, vocabulary.candidate, "exact");
  assert.deepEqual(prebuilt.cases, reference.cases, `${vocabulary.id} public behavior`);
  exactCases += prebuilt.cases.length;
  const mutation = runSample(runtimePath, candidateWasmPath, vocabulary.candidate, "mutation");
  assert.match(mutation.error, /prebuilt pair|invalid pair|pair rank|pair entries/i);
  mutationRefusals += 1;
}

process.stdout.write(`${JSON.stringify({ exactCases, mutationRefusals })}\n`);

function runSample(runtime, wasm, vocabulary, mode) {
  const run = childProcess.spawnSync(
    process.execPath,
    [sample, runtime, wasm, vocabulary, mode],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1_000_000 },
  );
  if (run.status !== 0) {
    throw new Error(`${mode} sample failed: ${run.stderr || run.stdout}`);
  }
  return JSON.parse(run.stdout);
}
