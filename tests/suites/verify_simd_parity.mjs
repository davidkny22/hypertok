import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadExecutionArtifactManifest } from "./artifact_manifest.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const loaded = loadExecutionArtifactManifest(
  repository,
  process.env.HYPERTOK_ARTIFACT_MANIFEST,
);
const vocabulary = readFileSync(path.join(repository, "hypertok-vocab", "o200k", "vocab.htk"));
const corpusRoot = path.join(repository, "benches", "corpus");

function artifact(id) {
  const value = loaded.document.artifacts.find((entry) => entry.id === id);
  assert.ok(value, `artifact ${id} is absent`);
  return value;
}

const scalarIdentity = artifact("single-scalar-shipping");
const simdIdentity = artifact("single-simd128-shipping");
assert.deepEqual(scalarIdentity.features, simdIdentity.features);
assert.equal(scalarIdentity.threading, "single");
assert.equal(simdIdentity.threading, "single");
assert.equal(scalarIdentity.simdLevel, "scalar");
assert.equal(simdIdentity.simdLevel, "simd128");
assert.notEqual(
  scalarIdentity.files.find(({ role }) => role === "raw-wasm").sha256,
  simdIdentity.files.find(({ role }) => role === "raw-wasm").sha256,
);

async function tokenizer(root, label) {
  const module = await import(
    `${pathToFileURL(path.join(root, "hypertok_wasm_core.js")).href}?artifact=${label}`
  );
  await module.default({
    module_or_path: readFileSync(path.join(root, "hypertok_wasm_core_bg.wasm")),
  });
  return module.WasmTokenizer.fromHtk(vocabulary);
}

function repeatedPrefix(source, minimum) {
  assert(source.length > 0);
  return Buffer.concat(Array.from({ length: Math.ceil(minimum / source.length) }, () => source));
}

function idDigest(ids) {
  const bytes = Buffer.allocUnsafe(ids.length * 4);
  ids.forEach((id, index) => bytes.writeUInt32LE(id, index * 4));
  return createHash("sha256").update(bytes).digest("hex");
}

const cases = [];
for (const filename of [
  "english-prose.txt",
  "chinese.txt",
  "source-code.txt",
  "emoji-heavy.txt",
  "long-document.txt",
  "standard-text.txt",
]) {
  cases.push({
    label: filename,
    input: repeatedPrefix(readFileSync(path.join(corpusRoot, filename)), 16_384),
    workload: true,
  });
}

const encoder = new TextEncoder();
for (const [label, text] of [
  ["letter-runs", `${"a".repeat(4095)}Z${"b".repeat(4097)}`],
  ["digit-runs", `${"1234567890".repeat(900)}\u0664\u0662\u2167`],
  ["whitespace", `${" \t\r\n".repeat(2048)}end`],
  ["contractions", `${"we'll I'D they're can't ".repeat(600)}tail`],
  ["punctuation", `${"!@#$%^&*()[]{}///\r\n".repeat(600)}x`],
  ["unicode", `${"\u00e9\u0416\u0627\ud55c\u4e00\u0661\u2167\u0301\u2003\n".repeat(900)}end`],
]) {
  cases.push({ label, input: encoder.encode(text), workload: false });
}
for (let prefix = 0; prefix <= 70; prefix += 1) {
  cases.push({
    label: `batch-edge-${prefix}`,
    input: encoder.encode(`${"x".repeat(prefix)}Apostrophe's 123 /\r\n${" z".repeat(96)}`),
    workload: false,
  });
}

const scalar = await tokenizer(loaded.roots[scalarIdentity.id], "scalar");
const simd = await tokenizer(loaded.roots[simdIdentity.id], "simd128");
let totalBytes = 0;
let totalIds = 0;
let workloads = 0;
const aggregate = createHash("sha256");
try {
  assert.equal(scalar.vocabSize(), simd.vocabSize());
  for (const testCase of cases) {
    const scalarIds = Array.from(scalar.encode(testCase.input));
    const simdIds = Array.from(simd.encode(testCase.input));
    if (process.env.HYPERTOK_SIMD_FAULT === "first-id" && simdIds.length !== 0) {
      simdIds[0] ^= 1;
    }
    assert.deepEqual(simdIds, scalarIds, testCase.label);
    totalBytes += testCase.input.length;
    totalIds += scalarIds.length;
    workloads += Number(testCase.workload);
    aggregate.update(testCase.label);
    aggregate.update(idDigest(scalarIds));
  }
} finally {
  scalar.free();
  simd.free();
}

console.log(JSON.stringify({
  pass: true,
  manifestSha256: loaded.sha256,
  workloads,
  cases: cases.length,
  bytes: totalBytes,
  ids: totalIds,
  digest: aggregate.digest("hex"),
}));
