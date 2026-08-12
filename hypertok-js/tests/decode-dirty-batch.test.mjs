import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecodeTable } from "../src/decode-table.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const tokens = [
  encoder.encode("A"),
  Uint8Array.of(0xef),
  Uint8Array.of(0xbf),
  Uint8Array.of(0xbb),
  Uint8Array.of(0xc2),
  Uint8Array.of(0xa2),
  Uint8Array.of(0xe2),
];

function core() {
  return Object.freeze({
    vocabSize: () => tokens.length,
    tokenBytes: (id) => tokens[id],
    decode(ids) {
      const bytes = ids.flatMap((id) => [...tokens[id]]);
      return decoder.decode(Uint8Array.from(bytes));
    },
  });
}

test("dirty-run batching keeps collision and fallback paths exact", () => {
  const tokenizer = core();
  const table = createDecodeTable(tokenizer, {
    seedEntries: 0,
    mixedRuns: true,
    dirtyRunBatch: true,
    maxMixedDirtyDensity: 1,
    mixedRunPenalty: 0,
  });
  for (const ids of [
    [1, 2, 2, 0, 4, 5],
    [6, 0, 4, 5],
  ]) {
    assert.equal(table.decode(ids), tokenizer.decode(ids));
  }
  assert.equal(table.stats().dirtyBatchCalls, 1);
  assert.equal(table.stats().dirtyBatchFallbackCalls, 1);
});
