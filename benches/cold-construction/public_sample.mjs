import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimePath, vocabularyPath, moduleSourcePath] = process.argv.slice(2);
if (!runtimePath || !vocabularyPath) {
  throw new Error("usage: public_sample.mjs runtime vocabulary [wasm-module]");
}

const vocabulary = new Uint8Array(fs.readFileSync(vocabularyPath));
const moduleSource = moduleSourcePath === undefined
  ? undefined
  : new Uint8Array(fs.readFileSync(moduleSourcePath));
const runtimeModule = await import(pathToFileURL(path.resolve(runtimePath)).href);

const started = performance.now();
const tokenizer = await runtimeModule.fromBytes(vocabulary, {
  tier: "single",
  moduleSource,
});
const constructionMilliseconds = performance.now() - started;

const probe = "Cold construction: café, 漢字, 👩🏽‍💻,\n\n\uFEFF boundary.";
const ids = tokenizer.encodeSync(probe);
const decoded = tokenizer.decode(ids);
if (decoded !== probe) throw new Error("public construction probe did not round-trip");
const outputDigest = crypto
  .createHash("sha256")
  .update(Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength))
  .digest("hex");

process.stdout.write(`${JSON.stringify({
  constructionMilliseconds,
  outputDigest,
  tokenCount: ids.length,
  tier: tokenizer.tier,
  vocabSize: tokenizer.vocabSize,
})}\n`);
tokenizer.free();
