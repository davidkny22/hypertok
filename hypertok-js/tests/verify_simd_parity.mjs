import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const [scalarWrapper, simdWrapper, vocabPath, corpusPath, mode = "gate"] =
  process.argv.slice(2);
if (!scalarWrapper || !simdWrapper || !vocabPath || !corpusPath) {
  throw new Error(
    "usage: verify_simd_parity.mjs scalar-wrapper simd-wrapper vocab corpus mode",
  );
}

const require = createRequire(import.meta.url);
const scalarModule = require(path.resolve(scalarWrapper));
const simdModule = require(path.resolve(simdWrapper));
const vocabulary = readFileSync(vocabPath);
const scalar = scalarModule.WasmTokenizer.fromTiktoken(vocabulary, "o200k");
const simd = simdModule.WasmTokenizer.fromTiktoken(vocabulary, "o200k");
assert.equal(scalar.vocabSize(), simd.vocabSize(), "vocabulary size differs");

function repeatedPrefix(source, minimum) {
  assert(source.length > 0);
  const copies = Math.ceil(minimum / source.length);
  return Buffer.concat(Array.from({ length: copies }, () => source));
}

function idDigest(ids) {
  const bytes = Buffer.allocUnsafe(ids.length * 4);
  ids.forEach((id, index) => bytes.writeUInt32LE(id, index * 4));
  return createHash("sha256").update(bytes).digest("hex");
}

const cases = [];
const workloadNames = [
  "english-prose.txt",
  "chinese.txt",
  "source-code.txt",
  "emoji-heavy.txt",
  "long-document.txt",
  "standard-text.txt",
];
for (const filename of workloadNames) {
  cases.push({
    label: filename,
    input: repeatedPrefix(readFileSync(path.join(corpusPath, filename)), 16_384),
    workload: true,
  });
}

const encoder = new TextEncoder();
for (const [label, text] of [
  ["letter-runs", `${"a".repeat(4095)}Z${"b".repeat(4097)}`],
  ["digit-runs", `${"1234567890".repeat(900)}٤٢Ⅷ`],
  ["whitespace", `${" \t\r\n".repeat(2048)}end`],
  ["contractions", `${"we'll I'D they're can't ".repeat(600)}tail`],
  ["punctuation", `${"!@#$%^&*()[]{}///\r\n".repeat(600)}x`],
  ["unicode", `${"éЖا한一١Ⅷ\u0301\u2003\n".repeat(900)}end`],
]) {
  cases.push({ label, input: encoder.encode(text), workload: false });
}
for (let prefix = 0; prefix <= 70; prefix += 1) {
  const text = `${"x".repeat(prefix)}Apostrophe's 123 /\r\n${" z".repeat(96)}`;
  cases.push({
    label: `batch-edge-${prefix}`,
    input: encoder.encode(text),
    workload: false,
  });
}

if (mode === "mutation-probe") {
  cases.splice(
    0,
    cases.length,
    ...cases.filter(
      ({ label }) =>
        label === "letter-runs" ||
        label === "contractions" ||
        label === "batch-edge-17",
    ),
  );
} else if (mode !== "gate") {
  throw new Error(`unknown mode ${mode}`);
}

let totalBytes = 0;
let totalIds = 0;
let workloadCases = 0;
const aggregate = createHash("sha256");
for (const testCase of cases) {
  const scalarIds = Array.from(scalar.encode(testCase.input));
  const simdIds = Array.from(simd.encode(testCase.input));
  const width = Math.max(scalarIds.length, simdIds.length);
  let difference = -1;
  for (let index = 0; index < width; index += 1) {
    if (scalarIds[index] !== simdIds[index]) {
      difference = index;
      break;
    }
  }
  if (difference !== -1) {
    throw new Error(
      `${testCase.label} SIMD divergence at id ${difference}: scalar=${scalarIds[difference]} simd=${simdIds[difference]} scalar_len=${scalarIds.length} simd_len=${simdIds.length}`,
    );
  }
  totalBytes += testCase.input.length;
  totalIds += scalarIds.length;
  workloadCases += Number(testCase.workload);
  aggregate.update(testCase.label);
  aggregate.update(idDigest(scalarIds));
}

console.log(
  `simd-parity PASS: workloads=${workloadCases}/${workloadCases} cases=${cases.length}/${cases.length} bytes=${totalBytes} ids=${totalIds} digest=${aggregate.digest("hex")}`,
);
