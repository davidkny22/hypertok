import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [moduleDirectory, vocabularyPath] = process.argv.slice(2);
if (!moduleDirectory || !vocabularyPath) {
  throw new Error("usage: binding_sample.mjs module-directory vocabulary");
}

const vocabulary = fs.readFileSync(vocabularyPath);
const imported = await import(
  pathToFileURL(path.resolve(moduleDirectory, "hypertok.js")).href
);
const module = imported.default ?? imported;
const started = performance.now();
const tokenizer = module.WasmTokenizer.fromHtk(vocabulary);
const constructionMilliseconds = performance.now() - started;
const constructionProfile = JSON.parse(
  module.WasmTokenizer.lastColdConstructionProfileJson(),
);

const input = new TextEncoder().encode("Cold construction stage accounting.");
const ids = tokenizer.encode(input);
const outputDigest = crypto
  .createHash("sha256")
  .update(Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength))
  .digest("hex");
const workerImage = tokenizer.exportWorkerImage();
const sourceDigest = tokenizer.vocabularyDigest();
const workerStarted = performance.now();
const worker = module.WasmTransferredTokenizer.fromWorkerImage(workerImage, sourceDigest);
const workerMilliseconds = performance.now() - workerStarted;
const workerProfile = JSON.parse(module.WasmTokenizer.lastColdConstructionProfileJson());

process.stdout.write(`${JSON.stringify({
  constructionMilliseconds,
  constructionProfile,
  workerMilliseconds,
  workerProfile,
  outputDigest,
  tokenCount: ids.length,
})}\n`);
worker.free();
tokenizer.free();
