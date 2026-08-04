import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  benchmarkTokenizerIdentity,
  readBenchmarkTokenizer,
} from "../common/gpt2_model.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bytes = readBenchmarkTokenizer();
const tokenizer = JSON.parse(bytes.toString("utf8"));

assert.deepEqual(benchmarkTokenizerIdentity(), {
  package: "@lenml/tokenizer-gpt2",
  version: "3.7.2",
  sha256: "cda20b8ca044949aa07ac4078420c80d1a57139d5f9f33700e46fb2d891e7c66",
});
assert.equal(Object.keys(tokenizer.model.vocab).length, 50_257);
assert.equal(tokenizer.model.merges.length, 50_000);

assert.throws(
  () => readBenchmarkTokenizer({ expectedSha256: "0".repeat(64) }),
  /digest mismatch/,
);
assert.throws(
  () => readBenchmarkTokenizer({ tokenizerPath: path.join(benchesDirectory, "missing-tokenizer.json") }),
  /ENOENT/,
);

console.log("pinned GPT-2 model PASS (vocab=50257, merges=50000)");
console.log("model digest mutation RED");
console.log("missing model mutation RED");
