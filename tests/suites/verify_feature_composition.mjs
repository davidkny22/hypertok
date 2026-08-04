import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadExecutionArtifactManifest, shippingFeatures } from "./artifact_manifest.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const loaded = loadExecutionArtifactManifest(repository, process.env.HYPERTOK_ARTIFACT_MANIFEST);
const selectedFeatures = shippingFeatures;
const encoder = new TextEncoder();

function artifact(id) {
  const value = loaded.document.artifacts.find((entry) => entry.id === id);
  assert.ok(value, `artifact ${id} is absent`);
  return value;
}

function validateArtifactPair(base, candidate) {
  assert.equal(base.threading, "single");
  assert.equal(candidate.threading, "single");
  assert.equal(base.simdLevel, "scalar");
  assert.equal(candidate.simdLevel, "scalar");
  assert.deepEqual(base.features.filter((feature) => feature.startsWith("opt-")), []);
  assert.deepEqual(
    candidate.features.filter((feature) => !feature.startsWith("opt-")),
    base.features,
  );
  assert.deepEqual(
    candidate.features.filter((feature) => feature.startsWith("opt-")).sort(),
    [...selectedFeatures].sort(),
  );
}

const baseIdentity = artifact("single-scalar");
const candidateIdentity = artifact("single-scalar-shipping");
const simdIdentity = artifact("single-simd128-shipping");
validateArtifactPair(baseIdentity, candidateIdentity);
assert.deepEqual(simdIdentity.features, candidateIdentity.features);
assert.equal(simdIdentity.simdLevel, "simd128");
assert.notEqual(
  baseIdentity.files.find(({ role }) => role === "raw-wasm").sha256,
  candidateIdentity.files.find(({ role }) => role === "raw-wasm").sha256,
);

let featureMutationRed = false;
try {
  const mutation = structuredClone(candidateIdentity);
  mutation.features = mutation.features.filter((feature) => feature !== selectedFeatures[0]);
  validateArtifactPair(baseIdentity, mutation);
} catch {
  featureMutationRed = true;
}
assert.equal(featureMutationRed, true);

async function loadModule(root, label) {
  const module = await import(
    `${pathToFileURL(path.join(root, "hypertok_wasm_core.js")).href}?composition=${label}`
  );
  await module.default({
    module_or_path: readFileSync(path.join(root, "hypertok_wasm_core_bg.wasm")),
  });
  return module;
}

const [baseModule, candidateModule, simdModule] = await Promise.all([
  loadModule(loaded.roots[baseIdentity.id], "base"),
  loadModule(loaded.roots[candidateIdentity.id], "candidate"),
  loadModule(loaded.roots[simdIdentity.id], "simd"),
]);
const o200k = readFileSync(path.join(repository, "hypertok-vocab", "o200k", "vocab.htk"));
const base = baseModule.WasmTokenizer.fromHtk(o200k);
const candidate = candidateModule.WasmTokenizer.fromHtk(o200k);
const simd = simdModule.WasmTokenizer.fromHtk(o200k);

function equalIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertIds(actual, expected, label) {
  assert.ok(equalIds(actual, expected), label);
}

function chunkOutcome(tokenizer, input) {
  try {
    return { ids: tokenizer.encodeChunked(input, tokenizer.defaultChunkSize()) };
  } catch (error) {
    return { error: String(error) };
  }
}

function repeatTo(bytes, minimum) {
  assert.ok(bytes.length > 0);
  return Buffer.concat(Array.from({ length: Math.ceil(minimum / bytes.length) }, () => bytes));
}

const corpusManifest = JSON.parse(
  readFileSync(path.join(repository, "benches", "corpus", "manifest.json"), "utf8"),
);
let workloadCases = 0;
let workloadBytes = 0;
let workloadIds = 0;
let mutationReference;
for (const workload of corpusManifest.workloads) {
  const source = readFileSync(path.join(repository, "benches", "corpus", workload.path));
  const input = repeatTo(source, 16_384);
  const baseFirst = base.encode(input);
  const candidateFirst = candidate.encode(input);
  const baseWarm = base.encode(input);
  const candidateWarm = candidate.encode(input);
  const baseChunked = base.encodeChunked(input, base.defaultChunkSize());
  const candidateChunked = candidate.encodeChunked(input, candidate.defaultChunkSize());
  assertIds(candidateFirst, baseFirst, `${workload.id}: first encode`);
  assertIds(candidateWarm, baseWarm, `${workload.id}: warm encode`);
  assertIds(candidateChunked, baseChunked, `${workload.id}: chunked encode`);
  assert.equal(candidate.decode(candidateFirst), base.decode(baseFirst), `${workload.id}: decode`);
  mutationReference ??= Array.from(baseFirst);
  workloadCases += 1;
  workloadBytes += input.length;
  workloadIds += baseFirst.length;
}

let outputMutationRed = false;
try {
  const mutation = [...mutationReference];
  mutation[0] ^= 1;
  assert.deepEqual(mutation, mutationReference);
} catch {
  outputMutationRed = true;
}
assert.equal(outputMutationRed, true);

const vocabularyFiles = [
  ["o200k", "hypertok-vocab/o200k/vocab.htk"],
  ["deepseek-v4", "hypertok-vocab/deepseek-v4/vocab.htk"],
  ["kimi-k3", "hypertok-vocab/kimi-k3/vocab.htk"],
  ["mistral-tekken", "hypertok-vocab/mistral-tekken/vocab.htk"],
  ["qwen3-6", "hypertok-vocab/qwen3-6/vocab.htk"],
];
const coldTexts = [
  "Cold construction preserves exact output.",
  "中文分词在第一次调用和缓存命中后都必须一致。",
  "const value = ids.map((id) => id + 1);",
  "🎉🧪🚀 exact bytes and typed refusals",
  "naïve café Å Å 한글 العربية",
];
let coldCases = 0;
let workerImages = 0;
for (const [name, relative] of vocabularyFiles) {
  const vocabulary = readFileSync(path.join(repository, relative));
  const baseTokenizer = baseModule.WasmTokenizer.fromHtk(vocabulary);
  const candidateTokenizer = candidateModule.WasmTokenizer.fromHtk(vocabulary);
  assert.equal(candidateTokenizer.vocabSize(), baseTokenizer.vocabSize(), `${name}: vocabulary size`);
  assert.equal(
    candidateTokenizer.defaultChunkSize(),
    baseTokenizer.defaultChunkSize(),
    `${name}: chunk size`,
  );
  for (const text of coldTexts) {
    const input = encoder.encode(text);
    const baseFirst = baseTokenizer.encode(input);
    const candidateFirst = candidateTokenizer.encode(input);
    assertIds(candidateFirst, baseFirst, `${name}: first ${JSON.stringify(text)}`);
    assertIds(candidateTokenizer.encode(input), baseTokenizer.encode(input), `${name}: warm`);
    assert.equal(candidateTokenizer.decode(candidateFirst), baseTokenizer.decode(baseFirst));
    coldCases += 1;
  }
  const chunkInput = encoder.encode(coldTexts.join(" ").repeat(256));
  const baseChunk = chunkOutcome(baseTokenizer, chunkInput);
  const candidateChunk = chunkOutcome(candidateTokenizer, chunkInput);
  assert.equal(candidateChunk.error, baseChunk.error, `${name}: chunk refusal`);
  if (candidateChunk.ids !== undefined) {
    assertIds(candidateChunk.ids, baseChunk.ids, `${name}: chunked`);
  }
  coldCases += 1;

  let baseImage;
  let candidateImage;
  let baseError;
  let candidateError;
  try {
    baseImage = baseTokenizer.exportWorkerImage();
  } catch (error) {
    baseError = String(error);
  }
  try {
    candidateImage = candidateTokenizer.exportWorkerImage();
  } catch (error) {
    candidateError = String(error);
  }
  assert.equal(Boolean(candidateError), Boolean(baseError), `${name}: worker compatibility`);
  if (candidateImage !== undefined) {
    const baseWorker = baseModule.WasmTransferredTokenizer.fromWorkerImage(
      baseImage,
      baseTokenizer.vocabularyDigest(),
    );
    const candidateWorker = candidateModule.WasmTransferredTokenizer.fromWorkerImage(
      candidateImage,
      candidateTokenizer.vocabularyDigest(),
    );
    const input = encoder.encode("construction");
    assertIds(candidateWorker.encodePretoken(input), baseWorker.encodePretoken(input), `${name}: worker`);
    assertIds(candidateWorker.encodePretoken(input), candidateTokenizer.encode(input), `${name}: import`);
    baseWorker.free();
    candidateWorker.free();
    workerImages += 1;
  }
  baseTokenizer.free();
  candidateTokenizer.free();
}
assert.equal(coldCases, 30);
assert.equal(workerImages, 3);

const mixedInputs = [
  ["mixed-latin-han", "A scalar and SIMD crossing: 汉字 with Latin source_code(); ".repeat(128)],
  ["mixed-arabic-emoji", "Route هذا النص with emoji 🧭✨ and ASCII numbers 12345. ".repeat(128)],
];
const parityInputs = [
  ...corpusManifest.workloads.map((workload) => [
    workload.id,
    readFileSync(path.join(repository, "benches", "corpus", workload.path)),
  ]),
  ...mixedInputs.map(([id, text]) => [id, encoder.encode(text)]),
];
function selectedLevel(bytes) {
  const nonAscii = bytes.reduce((count, byte) => count + Number(byte >= 0x80), 0);
  return nonAscii * 5 >= bytes.length ? "scalar" : "simd128";
}
let routeOutputChecks = 0;
for (const [name, input] of parityInputs) {
  const expected = base.encodeChunked(input, base.defaultChunkSize());
  const shippingScalar = candidate.encodeChunked(input, candidate.defaultChunkSize());
  const automatic = simd.encodeChunked(input, simd.defaultChunkSize());
  const route = simd.lastLevelScalar() ? "scalar" : "simd128";
  assertIds(shippingScalar, expected, `${name}: shipping scalar output`);
  assertIds(automatic, expected, `${name}: automatic output`);
  assert.equal(route, selectedLevel(input), `${name}: automatic route`);
  routeOutputChecks += 3;
}

const routeFixtures = [
  ["below-threshold", "aaaaaaaaaé", "simd128"],
  ["at-threshold", "aaaaaaaaé", "scalar"],
  ["mixed-threshold", "ab汉cd", "scalar"],
];
let routeMutationRed = false;
for (const [name, text, expected] of routeFixtures) {
  const bytes = encoder.encode(text);
  simd.encodeChunked(bytes, simd.defaultChunkSize());
  const actual = simd.lastLevelScalar() ? "scalar" : "simd128";
  assert.equal(actual, expected, name);
  if (name === "at-threshold") {
    try {
      assert.equal(actual, "simd128");
    } catch {
      routeMutationRed = true;
    }
  }
}
assert.equal(routeMutationRed, true);

const invalidUtf8 = [
  [0xff],
  [0x80],
  [0xc0, 0x80],
  [0xe0, 0x9f, 0x80],
  [0xed, 0xa0, 0x80],
  [0xf0, 0x8f, 0xbf, 0xbf],
  [0xf4, 0x90, 0x80, 0x80],
  [0xe2, 0x82],
];
let invalidChecks = 0;
for (const values of invalidUtf8) {
  const bytes = Uint8Array.from(values);
  assert.throws(() => simd.encodeChunked(bytes, simd.defaultChunkSize()));
  invalidChecks += 1;
}

let randomState = 0x51;
function random() {
  randomState |= 0;
  randomState = (randomState + 0x6d2b79f5) | 0;
  let value = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}
const pick = (values) => values[Math.floor(random() * values.length)];
const cjk = "的一是不了人我在有他这为之大来以个中上们汉字测试";
const contractions = ["'s", "'t", "'re", "'ve", "'m", "'ll", "'d", "'S", "'RE", "'Ll"];
function fuzzInput(family, ordinal) {
  if (family === 0) {
    return Uint8Array.from(
      { length: 40 + Math.floor(random() * 200) },
      () => 32 + Math.floor(random() * 95),
    );
  }
  if (family === 1) {
    let text = "";
    for (let index = 0; index < 60; index += 1) {
      text += pick([" word", pick([...cjk]), "العربية مرحبا", "😀🚀👩‍💻", "éä", " 123", "\n", "\t", pick(contractions)]);
    }
    return encoder.encode(text);
  }
  if (family === 2) return encoder.encode(`${" ".repeat(60 + (ordinal % 8))}${cjk} tail`);
  if (family === 3) {
    return Uint8Array.from(
      { length: 30 + Math.floor(random() * 200) },
      () => Math.floor(random() * 256),
    );
  }
  if (family === 4) {
    const complete = encoder.encode(`prefix ${cjk}`);
    return complete.subarray(0, complete.length - 1 - (ordinal % 3));
  }
  if (family === 5) return encoder.encode(`${" ".repeat(1 + Math.floor(random() * 300))}${ordinal % 2 ? "x" : ""}`);
  if (family === 6) return encoder.encode("\r\n".repeat(1 + Math.floor(random() * 100)));
  if (family === 7) {
    let text = "";
    for (let index = 0; index < 50; index += 1) text += `${pick(["can", "don", "it", "we"])}${pick(contractions)} `;
    return encoder.encode(text);
  }
  if (family === 8) return encoder.encode(`${"9".repeat(1 + Math.floor(random() * 40))} ${"12 345 6789 ".repeat(10)}`);
  if (family === 9) {
    const length = [63, 64, 65, 127, 128, 129][ordinal % 6];
    return Uint8Array.from({ length }, () => pick([0x61, 0x20, 0x37, 0x2e]));
  }
  if (family === 10) return encoder.encode("a".repeat(70_000 + ordinal));
  return encoder.encode("!".repeat(70_000 + ordinal));
}

let fuzzExact = 0;
let fuzzRefusals = 0;
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
for (let family = 0; family < 12; family += 1) {
  for (let ordinal = 0; ordinal < 50; ordinal += 1) {
    const input = fuzzInput(family, ordinal);
    if (family === 3 || family === 4) {
      let valid = true;
      try {
        fatalDecoder.decode(input);
      } catch {
        valid = false;
      }
      if (valid) {
        assertIds(
          simd.encodeChunked(input, simd.defaultChunkSize()),
          base.encodeChunked(input, base.defaultChunkSize()),
          `fuzz family ${family} case ${ordinal}`,
        );
        fuzzExact += 1;
      } else {
        assert.throws(() => simd.encodeChunked(input, simd.defaultChunkSize()));
        fuzzRefusals += 1;
      }
    } else {
      assertIds(
        candidate.encodeChunked(input, candidate.defaultChunkSize()),
        base.encodeChunked(input, base.defaultChunkSize()),
        `fuzz family ${family} case ${ordinal}`,
      );
      fuzzExact += 1;
    }
  }
}
assert.equal(fuzzExact + fuzzRefusals, 600);

function residentEncode(tokenizer, text, growthTrace = undefined) {
  let remaining = text;
  let written = 0;
  while (remaining.length !== 0) {
    const result = encoder.encodeInto(remaining, tokenizer.residentInputView().subarray(written));
    written += result.written;
    if (result.read === remaining.length) break;
    remaining = remaining.slice(result.read);
    tokenizer.growResidentInput();
    growthTrace?.push(tokenizer.residentInputCapacity());
  }
  return tokenizer.encodeResidentInput(written);
}

const resident = candidateModule.WasmTokenizer.fromHtk(o200k);
const initialCapacity = resident.residentInputCapacity();
const utf16Cases = [
  "",
  "before\ud800after",
  "before\udc00after",
  "before😀after",
  `${"a".repeat(65_534)}😀z`,
];
for (const text of utf16Cases) {
  assertIds(residentEncode(resident, text), candidate.encode(encoder.encode(text)), "resident UTF-16");
}
const retained = residentEncode(resident, "retained output");
const growthTrace = [resident.residentInputCapacity()];
residentEncode(resident, "x".repeat(5 * 1024 * 1024), growthTrace);
const grownCapacity = resident.residentInputCapacity();
const grownHighWater = resident.residentInputHighWater();
residentEncode(resident, "tiny");
const shrunkCapacity = resident.residentInputCapacity();
assert.equal(initialCapacity, 65_536);
assert.ok(growthTrace.every((capacity, index) => index === 0 || capacity === growthTrace[index - 1] * 2));
assert.equal(grownCapacity, 8 * 1024 * 1024);
assert.equal(grownHighWater, grownCapacity);
assert.equal(shrunkCapacity, 4 * 1024 * 1024);
assertIds(residentEncode(resident, "retained output"), retained, "retained output after growth");
resident.free();
for (const operation of [
  () => resident.residentInputView(),
  () => resident.residentInputCapacity(),
  () => resident.residentInputHighWater(),
  () => resident.growResidentInput(),
  () => resident.encodeResidentInput(0),
]) {
  assert.throws(operation);
}

base.free();
candidate.free();
simd.free();
console.log(JSON.stringify({
  pass: true,
  manifestSha256: loaded.sha256,
  features: selectedFeatures.length,
  workloads: workloadCases,
  workloadBytes,
  workloadIds,
  coldVocabularies: vocabularyFiles.length,
  coldCases,
  workerImages,
  routeOutputChecks,
  routeChecks: routeFixtures.length,
  invalidChecks,
  fuzzExact,
  fuzzRefusals,
  residentCases: utf16Cases.length,
  residentGrowthSteps: growthTrace.length,
  mutationsRed: 3,
}));
