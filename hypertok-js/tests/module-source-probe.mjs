import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { fromBytes } from "../src/index.mjs";

const [mode, wasmPath, vocabPath] = process.argv.slice(2);
const wasm = await readFile(wasmPath);
const vocabulary = await readFile(vocabPath);
const moduleSource = mode === "module" ? await WebAssembly.compile(wasm) : wasm;
const tokenizer = await fromBytes(vocabulary, { tier: "single", moduleSource });
try {
  assert.ok((await tokenizer.encode("edge module source")).length > 0);
} finally {
  tokenizer.free();
}
