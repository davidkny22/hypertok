import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "results", "demo");
const encoder = new TextEncoder();

test("current static WebAssembly loads and exercises every launch vocabulary", async () => {
  const modulePath = path.join(output, "wasm", "single", "hypertok_wasm_core.js");
  const wasmPath = path.join(output, "wasm", "single", "hypertok_wasm_core_bg.wasm");
  const runtime = await import(pathToFileURL(modulePath));
  await runtime.default({ module_or_path: await readFile(wasmPath) });

  const cases = Object.freeze([
    ["o200k_base.htk", "The quick brown fox jumps over the lazy dog."],
    ["qwen3.6.htk", "Qwen tokenizes 中文 and emoji 🚀."],
    ["mistral-tekken.htk", "Tekken tokenizes source_code(value);"],
    ["deepseek-v4.htk", "DeepSeek tokenizes 12345 and punctuation?!"],
    ["kimi-k3.htk", "Kimi tokenizes a browser playground."],
    ["gpt2.htk", "GPT-2 tokenizes a browser playground exactly."],
  ]);

  for (const [name, text] of cases) {
    const vocabulary = await readFile(path.join(output, "vocab", name));
    const tokenizer = runtime.WasmTokenizer.fromHtk(vocabulary);
    try {
      const input = encoder.encode(text);
      const ids = tokenizer.encode(input);
      const starts = tokenizer.tokenStarts(input, ids);
      assert.ok(ids.length > 0, name);
      assert.equal(starts.length, ids.length, name);
      assert.equal(tokenizer.decode(ids), text, name);
      assert.ok(Array.from(starts).every((start) => start <= input.length), name);
      assert.ok(Array.from(starts).every((start, index, all) => index === 0 || start >= all[index - 1]), name);
    } finally {
      tokenizer.free();
    }
  }
});
