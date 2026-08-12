import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecodeTable } from "../src/decode-table.mjs";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const tokens = [
  Uint8Array.of(0x41),
  Uint8Array.of(0x42),
  Uint8Array.of(0xe2),
  Uint8Array.of(0x82),
  Uint8Array.of(0xac),
  Uint8Array.of(0xc2),
  Uint8Array.of(0xa2),
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

test("run stitcher routes clean and dirty runs without segment fallback", () => {
  const tokenizer = core();
  const table = createDecodeTable(tokenizer, {
    seedEntries: 0,
    maxTableIds: 1,
    maxMixedDirtyDensity: 0,
    mixedRunPenalty: 100,
    mixedRuns: true,
    dirtyRunBatch: true,
    runStitcher: true,
  });
  const ids = [0, 2, 3, 4, 1, 5, 6, 0];
  assert.equal(table.decode(ids), tokenizer.decode(ids));
  assert.equal(table.decode(Uint32Array.from(ids)), tokenizer.decode(ids));
  const stats = table.stats();
  assert.equal(stats.runStitcherEnabled, true);
  assert.equal(stats.runStitcherCalls, 2);
  assert.equal(stats.dirtyBatchCalls, 2);
  assert.equal(stats.dirtyBatchRuns, 4);
  assert.equal(stats.fallbackCalls, 0);
  assert.equal(stats.largeFallbackCalls, 0);
  assert.equal(stats.sampledFallbackCalls, 0);
  assert.equal(stats.mixedDensityFallbackCalls, 0);
  assert.equal(stats.mixedRunFallbackCalls, 0);
});
