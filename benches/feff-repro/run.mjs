import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeAdapter } from "../adapters/node.mjs";
import { fromBytes } from "../../hypertok-js/src/index.mjs";
import * as rawModule from "../../hypertok-js/wasm/single/hypertok_wasm_core.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../..");
const vocabulary = await readFile(path.join(repository, "hypertok-vocab", "gpt2", "vocab.htk"));
const wasmBytes = await readFile(
  path.join(repository, "hypertok-js", "wasm", "single", "hypertok_wasm_core_bg.wasm"),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const paddings = [0, 50, 200, 2_000, 100_000];

await rawModule.default({ module_or_path: wasmBytes });
const raw = rawModule.WasmTokenizer.fromHtk(vocabulary);
const publicTokenizer = await fromBytes(vocabulary, { tier: "single" });
const canonical = await createNodeAdapter("@dqbd/tiktoken", "gpt2");
const huggingFace = await createNodeAdapter("@huggingface/tokenizers", "gpt2");

function exactText(padding) {
  return `${"x".repeat(padding)}.\n\n\ufeff\ufeffAlso on HuffPost:\n\n${"y".repeat(padding)}`;
}

function equalIds(actual, expected, label) {
  assert.deepEqual(Array.from(actual), Array.from(expected), label);
}

function assertPretokenBoundary(text, ranges, label) {
  const bytes = encoder.encode(text);
  const pieces = [];
  for (let index = 0; index < ranges.length; index += 2) {
    pieces.push(decoder.decode(bytes.subarray(ranges[index], ranges[index + 1])));
  }
  assert.ok(
    pieces.some(
      (piece, index) =>
        piece === "." &&
        pieces[index + 1] === "\n" &&
        pieces[index + 2] === "\n" &&
        pieces[index + 3] === "\ufeff\ufeff" &&
        pieces[index + 4] === "Also",
    ),
    `${label} merged the newline pair before U+FEFF`,
  );
}

const rows = [];
try {
  for (const padding of paddings) {
    const text = exactText(padding);
    const bytes = encoder.encode(text);
    const expected = canonical.encode(text);

    equalIds(await publicTokenizer.encode(text), expected, `public encode N=${padding}`);
    equalIds(publicTokenizer.encodeSync(text), expected, `public encodeSync N=${padding}`);

    const destination = new Uint32Array(expected.length + 16);
    const written = await publicTokenizer.encodeInto(text, destination);
    equalIds(destination.subarray(0, written), expected, `public encodeInto N=${padding}`);

    equalIds(raw.encode(bytes), expected, `raw encode N=${padding}`);
    equalIds(
      raw.encodeChunked(bytes, raw.defaultChunkSize()),
      expected,
      `raw chunk-prescan N=${padding}`,
    );
    assertPretokenBoundary(text, raw.pretokenRanges(bytes), `raw ranges N=${padding}`);

    const huggingFaceIds = huggingFace.encode(text);
    rows.push({
      padding,
      ids: expected.length,
      huggingFace:
        huggingFaceIds.length === expected.length &&
        Array.from(huggingFaceIds).every((id, index) => id === expected[index])
          ? "identical"
          : "different",
    });
  }

  for (const codePoint of [0x0085, 0x00a0, 0x200b, 0x2060, 0xfeff]) {
    const character = String.fromCodePoint(codePoint);
    const text = `a\n\n${character}${character}b`;
    equalIds(
      await publicTokenizer.encode(text),
      canonical.encode(text),
      `canonical whitespace U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
    );
  }
} finally {
  raw.free();
  publicTokenizer.free();
  canonical.dispose();
  huggingFace.dispose();
}

console.log(JSON.stringify({ pass: true, paddings: rows }, null, 2));
