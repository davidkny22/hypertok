import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [outputPath, sizeText = "4194304"] = process.argv.slice(2);
const size = Number(sizeText);
if (!outputPath || !Number.isSafeInteger(size) || size < 4097) {
  throw new Error("prepare-input.mjs requires an output path and a byte count above 4096");
}

const encoder = new TextEncoder();
const unit = "汉";
const unitBytes = encoder.encode(unit);
assert.equal(unitBytes.length, 3);
const repeatedBytes = size - (size % unitBytes.length);
const text = unit.repeat(repeatedBytes / unitBytes.length) + "a".repeat(size - repeatedBytes);
assert.match(text, /^\p{L}+$/u);
const bytes = encoder.encode(text);
assert.equal(bytes.length, size);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, bytes);
process.stdout.write(`${JSON.stringify({ outputPath: path.resolve(outputPath), bytes: bytes.length })}\n`);
