import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WasmTokenizer } = require("../../target/pkg-test/hypertok_wasm_core.js");

function byteToUnicode() {
  const bytes = [];
  for (let value = 33; value <= 126; value += 1) bytes.push(value);
  for (let value = 161; value <= 172; value += 1) bytes.push(value);
  for (let value = 174; value <= 255; value += 1) bytes.push(value);
  const codePoints = [...bytes];
  const present = new Set(bytes);
  let extra = 0;
  for (let value = 0; value <= 255; value += 1) {
    if (!present.has(value)) {
      bytes.push(value);
      codePoints.push(256 + extra);
      extra += 1;
    }
  }
  return Object.fromEntries(
    bytes.map((value, index) => [value, String.fromCodePoint(codePoints[index])]),
  );
}

function byteLevelFixture() {
  const mapping = byteToUnicode();
  const vocab = Object.fromEntries(
    Array.from({ length: 256 }, (_, value) => [mapping[value], value]),
  );
  return new TextEncoder().encode(
    JSON.stringify({
      added_tokens: [],
      pre_tokenizer: { type: "ByteLevel" },
      model: { type: "BPE", vocab, merges: [] },
    }),
  );
}

function tiktokenFixture() {
  const lines = Array.from(
    { length: 256 },
    (_, value) => `${Buffer.from([value]).toString("base64")} ${value}`,
  );
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

const tokenizer = WasmTokenizer.fromHuggingFace(byteLevelFixture());
assert.equal(tokenizer.vocabSize(), 256);

const input = new TextEncoder().encode("WebAssembly oracle path\n");
assert.deepEqual(Array.from(tokenizer.encode(input)), Array.from(input));

const tiktoken = WasmTokenizer.fromTiktoken(tiktokenFixture(), "gpt2");
assert.equal(tiktoken.vocabSize(), 256);
assert.deepEqual(Array.from(tiktoken.encode(input)), Array.from(input));

assert.throws(
  () => WasmTokenizer.fromTiktoken(new Uint8Array(), "unknown"),
  /unknown pretokenizer scheme/,
);

console.log(
  "wasm smoke passed: HuggingFace and tiktoken load, single-core encode, and typed error",
);
