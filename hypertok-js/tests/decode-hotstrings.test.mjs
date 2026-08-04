import assert from "node:assert/strict";
import { test } from "node:test";
import { createHotStringDecoder } from "../src/decode-hotstrings.mjs";

function fakeCore(entries) {
  const decoder = new TextDecoder("utf-8");
  const bytesFor = (id) => {
    const bytes = entries.get(id);
    if (bytes === undefined) throw new Error(`unknown token id ${id}`);
    return bytes;
  };
  return Object.freeze({
    vocabSize: entries.size,
    tokenBytes: bytesFor,
    decode(ids) {
      const length = [...ids].reduce((sum, id) => sum + bytesFor(id).length, 0);
      const joined = new Uint8Array(length);
      let offset = 0;
      for (const id of ids) {
        const bytes = bytesFor(id);
        joined.set(bytes, offset);
        offset += bytes.length;
      }
      return decoder.decode(joined);
    },
  });
}

const entries = new Map([
  [0, Uint8Array.of(0x61)],
  [1, Uint8Array.of(0x62)],
  [2, Uint8Array.of(0xe2)],
  [3, Uint8Array.of(0x82)],
  [4, Uint8Array.of(0xac)],
  [5, Uint8Array.of(0xe2, 0x82, 0xac)],
  [6, Uint8Array.of(0x80)],
]);

test("joins cached strings and preserves cold UTF-8 boundaries", () => {
  const core = fakeCore(entries);
  const decoder = createHotStringDecoder(core, { maxEntries: 3, maxPayloadBytes: 32 });
  const ids = Uint32Array.of(0, 0, 0, 2, 3, 4, 1, 5);
  assert.equal(decoder.decode(ids), core.decode(ids));
  const state = decoder.stats();
  assert.equal(state.initialized, true);
  assert.equal(state.active, false);
  assert.equal(state.entries, 0);
  assert.equal(state.coveredTokens, 4);
  assert.equal(state.observedCoverage, 4 / 8);
});

test("keeps invalid bytes and cross-token replacement behavior on the fallback", () => {
  const core = fakeCore(entries);
  const decoder = createHotStringDecoder(core, { maxEntries: 8, maxPayloadBytes: 32 });
  for (const ids of [
    Uint32Array.of(2, 3),
    Uint32Array.of(2, 3, 4),
    Uint32Array.of(0, 6, 1),
    Uint32Array.of(6, 6),
  ]) {
    assert.equal(decoder.decode(ids), core.decode(ids));
  }
});

test("bounds cache capacity and leaves later unseen ids cold", () => {
  const core = fakeCore(entries);
  const decoder = createHotStringDecoder(core, {
    maxEntries: 1,
    maxPayloadBytes: 2,
    minCoverage: 0,
  });
  assert.equal(decoder.decode([1, 0, 0, 0]), "baaa");
  assert.deepEqual(decoder.stats(), {
    initialized: true,
    active: true,
    entries: 1,
    maxEntries: 1,
    payloadBytes: 2,
    maxPayloadBytes: 2,
    indexKind: "direct",
    indexBytes: entries.size * 4,
    maxIndexBytes: 1024 * 1024,
    minCoverage: 0,
    observedTokens: 4,
    observedDistinct: 2,
    coveredTokens: 3,
    observedCoverage: 0.75,
  });
  assert.equal(decoder.decode(Uint32Array.of(1, 5)), "b€");
  assert.equal(decoder.stats().entries, 1);
});

test("does not freeze an empty first call into an empty cache", () => {
  const core = fakeCore(entries);
  const decoder = createHotStringDecoder(core, { maxEntries: 2, maxPayloadBytes: 4 });
  assert.equal(decoder.decode([]), "");
  assert.equal(decoder.stats().initialized, false);
  assert.equal(decoder.decode([0, 1]), "ab");
  assert.equal(decoder.stats().entries, 2);
});

test("retains the public decode input and unknown-id refusals", () => {
  const decoder = createHotStringDecoder(fakeCore(entries));
  assert.throws(() => decoder.decode("0"), /decode input must be/);
  assert.throws(() => decoder.decode([-1]), /decode input must be/);
  assert.throws(() => decoder.decode(Uint32Array.of(99)), /unknown token id 99/);
});

test("validates bounds and core shape", () => {
  assert.throws(() => createHotStringDecoder({}), /decode core/);
  assert.throws(() => createHotStringDecoder(fakeCore(entries), []), /options/);
  assert.throws(
    () => createHotStringDecoder(fakeCore(entries), { maxEntries: 0 }),
    /maxEntries/,
  );
  assert.throws(
    () => createHotStringDecoder(fakeCore(entries), { maxPayloadBytes: 0 }),
    /maxPayloadBytes/,
  );
  assert.throws(
    () => createHotStringDecoder(fakeCore(entries), { maxIndexBytes: 0 }),
    /maxIndexBytes/,
  );
  assert.throws(
    () => createHotStringDecoder(fakeCore(entries), { minCoverage: 2 }),
    /minCoverage/,
  );
});
