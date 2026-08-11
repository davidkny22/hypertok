import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { brotliDecompressSync } from "node:zlib";

if (process.argv[2] === "--sample") {
  const stored = fs.readFileSync(process.argv[3]);
  const started = performance.now();
  const unpacked = brotliDecompressSync(stored);
  const milliseconds = performance.now() - started;
  process.stdout.write(`${JSON.stringify({
    milliseconds,
    storedBytes: stored.byteLength,
    unpackedBytes: unpacked.byteLength,
    digest: crypto.createHash("sha256").update(unpacked).digest("hex"),
  })}\n`);
  process.exit(0);
}

const arguments_ = process.argv.slice(2);
const nIndex = arguments_.indexOf("--n");
const n = nIndex === -1 ? 11 : Number(arguments_.splice(nIndex, 2)[1]);
const outputIndex = arguments_.indexOf("--output");
const outputPath = outputIndex === -1 ? undefined : arguments_.splice(outputIndex, 2)[1];
if (!Number.isSafeInteger(n) || n < 5 || n > 11 || arguments_.length === 0) {
  throw new Error(
    "usage: measure_brotli_decompression.mjs [--n 5..11] [--output path] name=file.br [...]",
  );
}

const rows = arguments_.map((entry) => {
  const separator = entry.indexOf("=");
  if (separator < 1) throw new Error(`invalid input ${entry}`);
  const name = entry.slice(0, separator);
  const input = path.resolve(entry.slice(separator + 1));
  const samples = Array.from({ length: n }, () => runSample(input));
  const identity = samples[0];
  if (samples.some((sample) =>
    sample.storedBytes !== identity.storedBytes
    || sample.unpackedBytes !== identity.unpackedBytes
    || sample.digest !== identity.digest
  )) {
    throw new Error(`decompression identity changed across ${name} samples`);
  }
  return {
    name,
    input,
    storedBytes: identity.storedBytes,
    unpackedBytes: identity.unpackedBytes,
    digest: identity.digest,
    decompression: summarize(samples.map((sample) => sample.milliseconds)),
    samples: samples.map((sample) => sample.milliseconds),
  };
});

const output = `${JSON.stringify({
  schemaVersion: 1,
  environment: `${process.version} fresh process per sample`,
  clockRegime: "performance.now around brotliDecompressSync; stored bytes read before timing",
  n,
  rows,
}, null, 2)}\n`;
if (outputPath === undefined) {
  process.stdout.write(output);
} else {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, output);
}

function runSample(input) {
  const result = spawnSync(process.execPath, [import.meta.filename, "--sample", input], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`sample failed for ${input}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function summarize(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { n: values.length, median, p95, variance };
}
