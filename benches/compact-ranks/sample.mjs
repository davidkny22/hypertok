import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [mode, runtimePath, vocabularyPath, moduleSourcePath, inputPath] = process.argv.slice(2);
if (
  !["memory", "encode", "decode"].includes(mode) ||
  !runtimePath ||
  !vocabularyPath ||
  !moduleSourcePath
) {
  throw new Error("usage: sample.mjs memory|encode|decode runtime vocab module [input]");
}
if (mode === "memory" && typeof globalThis.gc !== "function") {
  throw new Error("memory samples require node --expose-gc");
}
if (mode !== "memory" && !inputPath) {
  throw new Error("throughput samples require an input path");
}

const runtime = await import(pathToFileURL(path.resolve(runtimePath)).href);
const vocabulary = new Uint8Array(fs.readFileSync(vocabularyPath));
const moduleSource = new Uint8Array(fs.readFileSync(moduleSourcePath));
const digestIds = (ids) => crypto.createHash("sha256")
  .update(Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength))
  .digest("hex");

if (mode === "memory") {
  globalThis.gc();
  globalThis.gc();
  const before = process.memoryUsage();
  const tokenizer = await runtime.fromBytes(vocabulary, { tier: "single", moduleSource });
  const probe = "Compact ranks: Latin, 中文, 😀,\n\n\uFEFF boundary.";
  const ids = tokenizer.encodeSync(probe);
  if (tokenizer.decode(ids) !== probe) throw new Error("memory probe did not round-trip");
  globalThis.gc();
  globalThis.gc();
  const after = process.memoryUsage();
  const delta = Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key] - before[key]]),
  );
  process.stdout.write(`${JSON.stringify({
    mode,
    before,
    after,
    delta,
    idDigest: digestIds(ids),
    tokenCount: ids.length,
    tier: tokenizer.tier,
    vocabSize: tokenizer.vocabSize,
  })}\n`);
  tokenizer.free();
} else {
  const source = fs.readFileSync(inputPath);
  const repeats = Math.max(1, Math.ceil(4_194_304 / source.length));
  const bytes = Buffer.concat(Array.from({ length: repeats }, () => source));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const tokenizer = await runtime.fromBytes(vocabulary, { tier: "single", moduleSource });
  let ids;
  let milliseconds;
  if (mode === "encode") {
    const started = performance.now();
    ids = tokenizer.encodeSync(text);
    milliseconds = performance.now() - started;
  } else {
    ids = tokenizer.encodeSync(text);
    const started = performance.now();
    const decoded = tokenizer.decode(ids);
    milliseconds = performance.now() - started;
    if (decoded !== text) throw new Error("fresh decode changed text");
  }
  process.stdout.write(`${JSON.stringify({
    mode,
    milliseconds,
    inputBytes: new TextEncoder().encode(text).length,
    idDigest: digestIds(ids),
    tokenCount: ids.length,
    tier: tokenizer.tier,
    vocabSize: tokenizer.vocabSize,
  })}\n`);
  tokenizer.free();
}
