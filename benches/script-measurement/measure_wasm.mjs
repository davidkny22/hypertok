import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadScriptCorpus } from "./corpus.mjs";
import { summarize } from "../common/timing.mjs";

const [scalarWrapper, simdWrapper, vocabPath, outputPath, nText, warmupText, targetText] =
  process.argv.slice(2);
if (!scalarWrapper || !simdWrapper || !vocabPath || !outputPath) {
  throw new Error(
    "usage: measure_wasm.mjs scalar-wrapper simd-wrapper vocab output n warmup target-bytes",
  );
}
const n = Number(nText);
const warmup = Number(warmupText);
const targetBytes = Number(targetText);
if (
  !Number.isInteger(n) ||
  n < 1 ||
  !Number.isInteger(warmup) ||
  warmup < 0 ||
  !Number.isSafeInteger(targetBytes) ||
  targetBytes < 1
) {
  throw new Error("invalid WebAssembly measurement counts");
}

const require = createRequire(import.meta.url);
const modules = [
  ["scalar", require(path.resolve(scalarWrapper))],
  ["simd128", require(path.resolve(simdWrapper))],
];
const vocabulary = fs.readFileSync(vocabPath);
const workloads = loadScriptCorpus();
const rows = [];
const chunkSizeRefusals = [];

function iterationsFor(bytes) {
  return Math.max(1, Math.min(512, Math.ceil(targetBytes / bytes)));
}

function idDigest(ids) {
  const bytes = Buffer.allocUnsafe(ids.length * 4);
  ids.forEach((id, index) => bytes.writeUInt32LE(id, index * 4));
  return createHash("sha256").update(bytes).digest("hex");
}

function readTelemetry(tokenizer) {
  const [pretokens, engagedPretokens, initialChunks, enlargements, chunkSize] = Array.from(
    tokenizer.chunkTelemetry(),
  );
  return { pretokens, engagedPretokens, initialChunks, enlargements, chunkSize };
}

for (const [simdLevel, module] of modules) {
  const refusalTokenizer = module.WasmTokenizer.fromTiktoken(vocabulary, "o200k");
  const minimumChunkSize = refusalTokenizer.minimumChunkSize();
  let refused = false;
  try {
    refusalTokenizer.encodeChunked(new TextEncoder().encode("a"), minimumChunkSize - 1);
  } catch (error) {
    refused = String(error).includes("below the minimum");
  }
  if (!refused) {
    throw new Error(`${simdLevel} accepted a chunk size below the minimum`);
  }
  chunkSizeRefusals.push({ simdLevel, result: "refused" });

  for (const workload of workloads) {
    const input = new TextEncoder().encode(workload.text);
    for (const chunking of [false, true]) {
      const tokenizer = module.WasmTokenizer.fromTiktoken(vocabulary, "o200k");
      const chunkSize = tokenizer.minimumChunkSize();
      const encode = () =>
        chunking ? tokenizer.encodeChunked(input, chunkSize) : tokenizer.encode(input);
      const iterations = iterationsFor(workload.bytes);
      let lastIds = encode();
      for (let sample = 0; sample < warmup; sample += 1) {
        for (let iteration = 0; iteration < iterations; iteration += 1) {
          lastIds = encode();
        }
      }

      const samples = [];
      for (let sample = 0; sample < n; sample += 1) {
        const started = performance.now();
        for (let iteration = 0; iteration < iterations; iteration += 1) {
          lastIds = encode();
        }
        const elapsed = performance.now() - started;
        if (!Number.isFinite(elapsed) || elapsed <= 0) {
          throw new Error(`invalid WebAssembly duration: ${elapsed}`);
        }
        samples.push((workload.bytes * iterations) / (elapsed * 1_000));
      }

      rows.push({
        workload: workload.id,
        workloadBytes: workload.bytes,
        environment: "wasm-node",
        tier: "single",
        simdLevel,
        chunking,
        clockRegime: "performance.now; Node single process; warm cache",
        statistics: summarize(samples),
        units: "MB/s",
        iterationsPerSample: iterations,
        bytesPerSample: workload.bytes * iterations,
        tokenCount: lastIds.length,
        idDigest: idDigest(Array.from(lastIds)),
        chunkTelemetry: chunking ? readTelemetry(tokenizer) : null,
      });
    }
  }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `${JSON.stringify({ chunkSizeRefusals, rows }, null, 2)}\n`,
);
console.log(`WebAssembly measurement rows: ${rows.length}`);
console.log(`chunk-size assumption negatives: ${chunkSizeRefusals.length}/2`);
