import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const [wasmPath, vocabPath] = process.argv.slice(2);
if (!wasmPath || !vocabPath) throw new Error("wasm and vocabulary paths are required");

globalThis.gc?.();
const rssBefore = process.memoryUsage().rss;
const started = performance.now();
const [{ fromBytes }, wasm, vocabulary] = await Promise.all([
  import("../src/index.mjs"),
  readFile(wasmPath),
  readFile(vocabPath),
]);
const tokenizer = await fromBytes(vocabulary, { tier: "single", moduleSource: wasm });
tokenizer.encodeSync("x");
const initialized = performance.now();
globalThis.gc?.();
const rssAfter = process.memoryUsage().rss;

const seed = "The quick brown fox tokenizes code const x = 42; 中文 👩🏽‍💻.\n";
const input = seed.repeat(Math.ceil(1_048_576 / Buffer.byteLength(seed))).slice(0, 1_048_576);
for (let index = 0; index < 3; index += 1) tokenizer.encodeSync(input);
const samples = [];
for (let index = 0; index < 7; index += 1) {
  const before = performance.now();
  tokenizer.encodeSync(input);
  const elapsed = performance.now() - before;
  samples.push((Buffer.byteLength(input) / 1_000_000) / (elapsed / 1_000));
}
tokenizer.free();
samples.sort((left, right) => left - right);
console.log(JSON.stringify({
  initMs: initialized - started,
  rssDelta: rssAfter - rssBefore,
  rssAfter,
  throughputMBps: samples[Math.floor(samples.length / 2)],
}));
