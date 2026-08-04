import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const benchmarkTokenizerPackage = "@lenml/tokenizer-gpt2";
export const benchmarkTokenizerVersion = "3.7.2";
export const benchmarkTokenizerSha256 =
  "cda20b8ca044949aa07ac4078420c80d1a57139d5f9f33700e46fb2d891e7c66";
export const benchmarkTokenizerPath = fileURLToPath(
  import.meta.resolve("@lenml/tokenizer-gpt2/models/tokenizer.json"),
);

export function readBenchmarkTokenizer({
  tokenizerPath = benchmarkTokenizerPath,
  expectedSha256 = benchmarkTokenizerSha256,
} = {}) {
  const bytes = fs.readFileSync(tokenizerPath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Benchmark tokenizer digest mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
  return bytes;
}

export function benchmarkTokenizerIdentity() {
  return Object.freeze({
    package: benchmarkTokenizerPackage,
    version: benchmarkTokenizerVersion,
    sha256: benchmarkTokenizerSha256,
  });
}
