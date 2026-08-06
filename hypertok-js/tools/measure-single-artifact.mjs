import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [baselinePath, candidatePath, outputPath, countValue = "11"] = process.argv.slice(2);
const count = Number(countValue);
if (!baselinePath || !candidatePath || !outputPath || !Number.isInteger(count) || count < 3) {
  throw new Error("usage: node measure-single-artifact.mjs BASELINE CANDIDATE OUTPUT [COUNT]");
}
const directory = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(directory, "measure-single-artifact-child.mjs");
const repository = path.resolve(directory, "../..");
const vocabulary = path.join(repository, "hypertok-vocab", "gpt2", "vocab.htk");

function measure(wasmPath) {
  const result = spawnSync(process.execPath, ["--expose-gc", child, wasmPath, vocabulary], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    n: sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    variance: sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

const samples = { baseline: [], candidate: [] };
for (let index = 0; index < count; index += 1) {
  const order = index % 2 === 0
    ? [["baseline", baselinePath], ["candidate", candidatePath]]
    : [["candidate", candidatePath], ["baseline", baselinePath]];
  for (const [label, wasmPath] of order) samples[label].push(measure(wasmPath));
}

async function size(file) {
  const bytes = await readFile(file);
  return { raw: bytes.length, gzip9: gzipSync(bytes, { level: 9 }).length };
}

function metrics(rows) {
  return {
    initMs: summarize(rows.map((row) => row.initMs)),
    throughputMBps: summarize(rows.map((row) => row.throughputMBps)),
    rssDelta: summarize(rows.map((row) => row.rssDelta)),
    rssAfter: summarize(rows.map((row) => row.rssAfter)),
  };
}

const result = {
  schemaVersion: 1,
  node: process.version,
  clock: "performance.now",
  protocol: "alternating fresh processes; compiled from caller-supplied bytes; gpt2; seven 1 MiB warm encode samples per process",
  baseline: { path: baselinePath, size: await size(baselinePath), ...metrics(samples.baseline) },
  candidate: { path: candidatePath, size: await size(candidatePath), ...metrics(samples.candidate) },
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
