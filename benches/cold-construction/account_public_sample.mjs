import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimePath, vocabularyPath, mode = "default"] = process.argv.slice(2);
if (!runtimePath || !vocabularyPath || !["default", "bytes", "module", "warm"].includes(mode)) {
  throw new Error("usage: account_public_sample.mjs runtime vocabulary [default|bytes|module|warm]");
}

const resolvedRuntimePath = path.resolve(runtimePath);
const packageRoot = path.resolve(path.dirname(resolvedRuntimePath), "..");
const wasmGluePath = path.join(packageRoot, "wasm", "single", "hypertok_wasm_core.js");
const wasmBinaryPath = path.join(packageRoot, "wasm", "single", "hypertok_wasm_core_bg.wasm");
const vocabulary = new Uint8Array(fs.readFileSync(vocabularyPath));
const runtimeModule = await import(pathToFileURL(resolvedRuntimePath).href);
const wasmModule = await import(pathToFileURL(wasmGluePath).href);

let moduleSource;
if (mode !== "default") {
  const wasmBytes = new Uint8Array(fs.readFileSync(wasmBinaryPath));
  moduleSource = mode === "bytes" ? wasmBytes : await WebAssembly.compile(wasmBytes);
}
if (mode === "warm") {
  await wasmModule.default({ module_or_path: moduleSource });
}

let publicStarted = 0;
let bindingStartOffset = 0;
const stages = new Map();

function record(name, started) {
  stages.set(name, (stages.get(name) ?? 0) + performance.now() - started);
}

function wrapMethod(target, name, stageName) {
  const original = target[name];
  target[name] = function wrappedMethod(...args) {
    const started = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      record(stageName, started);
    }
  };
  return () => {
    target[name] = original;
  };
}

const originalFromHtk = wasmModule.WasmTokenizer.fromHtk;
wasmModule.WasmTokenizer.fromHtk = function wrappedFromHtk(...args) {
  bindingStartOffset = performance.now() - publicStarted;
  const started = performance.now();
  try {
    return originalFromHtk.apply(this, args);
  } finally {
    record("binding", started);
  }
};
const restores = [
  wrapMethod(wasmModule.WasmTokenizer.prototype, "reservedNamesJson", "reserved-names"),
  wrapMethod(wasmModule.WasmTokenizer.prototype, "vocabularyDigest", "vocabulary-digest"),
  wrapMethod(wasmModule.WasmTokenizer.prototype, "exportWorkerImage", "worker-image-export"),
];

let tokenizer;
try {
  publicStarted = performance.now();
  tokenizer = await runtimeModule.fromBytes(vocabulary, {
    tier: "single",
    ...(moduleSource === undefined ? {} : { moduleSource }),
  });
  const totalMilliseconds = performance.now() - publicStarted;

  const probe = "Construction account: caf\u00e9, \u6f22\u5b57, \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb,\n\n\uFEFF boundary.";
  const ids = tokenizer.encodeSync(probe);
  if (tokenizer.decode(ids) !== probe) {
    throw new Error("public construction account probe did not round-trip");
  }
  const outputDigest = crypto
    .createHash("sha256")
    .update(Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength))
    .digest("hex");
  const bindingMilliseconds = stages.get("binding") ?? 0;
  const postBindingKnownMilliseconds = [
    "reserved-names",
    "vocabulary-digest",
    "worker-image-export",
  ].reduce((sum, name) => sum + (stages.get(name) ?? 0), 0);
  const publicWrapperResidualMilliseconds = totalMilliseconds
    - bindingStartOffset
    - bindingMilliseconds
    - postBindingKnownMilliseconds;

  process.stdout.write(`${JSON.stringify({
    mode,
    totalMilliseconds,
    preBindingMilliseconds: bindingStartOffset,
    bindingMilliseconds,
    reservedNamesMilliseconds: stages.get("reserved-names") ?? 0,
    vocabularyDigestMilliseconds: stages.get("vocabulary-digest") ?? 0,
    workerImageExportMilliseconds: stages.get("worker-image-export") ?? 0,
    publicWrapperResidualMilliseconds,
    outputDigest,
    tokenCount: ids.length,
    tier: tokenizer.tier,
    vocabSize: tokenizer.vocabSize,
  })}\n`);
} finally {
  wasmModule.WasmTokenizer.fromHtk = originalFromHtk;
  for (const restore of restores.reverse()) restore();
  tokenizer?.free();
}
