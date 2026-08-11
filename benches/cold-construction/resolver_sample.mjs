import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createResolvedVocabLoader,
  resolverOwnedBytes,
  resolverOwnedWorkerImage,
} from "../../hypertok-js/src/resolver-provenance.mjs";

const [modulePath, wasmPath, vocabularyPath, mode] = process.argv.slice(2);
if (!modulePath || !wasmPath || !vocabularyPath || !["untrusted", "trusted"].includes(mode)) {
  throw new Error("usage: resolver_sample.mjs module wasm vocabulary untrusted|trusted");
}

const wasmModule = await import(pathToFileURL(path.resolve(modulePath)).href);
const wasm = new Uint8Array(fs.readFileSync(wasmPath));
const vocabulary = new Uint8Array(fs.readFileSync(vocabularyPath));
const handle = mode === "trusted"
  ? await createResolvedVocabLoader(async () => vocabulary)("pricing-fixture")
  : undefined;
const constructionBytes = handle === undefined ? vocabulary : resolverOwnedBytes(handle);
const started = performance.now();
await wasmModule.default({ module_or_path: wasm });
const tokenizer = mode === "trusted"
  ? wasmModule.WasmTokenizer.fromResolverTrustedHtk(constructionBytes)
  : wasmModule.WasmTokenizer.fromHtk(constructionBytes);
const bindingReadyMilliseconds = performance.now() - started;
const workerImage = handle === undefined
  ? tokenizer.exportWorkerImage()
  : resolverOwnedWorkerImage(handle);
const publicReadyMilliseconds = performance.now() - started;

try {
  const probe = "Resolver provenance: café, 漢字, 👩🏽‍💻,\n\n\uFEFF boundary.";
  const input = new TextEncoder().encode(probe);
  const ids = tokenizer.encode(input);
  const decoded = tokenizer.decode(ids);
  if (!Buffer.from(decoded).equals(input)) {
    throw new Error("resolver construction did not round-trip");
  }
  const outputDigest = crypto
    .createHash("sha256")
    .update(Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength))
    .digest("hex");
  process.stdout.write(`${JSON.stringify({
    bindingReadyMilliseconds,
    publicReadyMilliseconds,
    outputDigest,
    tokenCount: ids.length,
    workerImageBytes: workerImage.length,
  })}\n`);
} finally {
  tokenizer.free();
}
