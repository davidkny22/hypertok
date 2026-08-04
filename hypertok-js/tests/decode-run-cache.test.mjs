import assert from "node:assert/strict";
import { test } from "node:test";
import { createMaximalRunCache } from "../src/decode-run-cache.mjs";

test("caches only an exact complete run key", () => {
  const cache = createMaximalRunCache();
  const ids = [1, 2, 3];
  let calls = 0;
  const decode = (start, end, output) => cache.decode(ids, start, end, () => {
    calls += 1;
    return output;
  });

  assert.equal(decode(0, 2, "left"), "left");
  assert.equal(decode(0, 2, "ignored"), "left");
  assert.equal(decode(0, 3, "whole"), "whole");
  assert.equal(decode(1, 3, "right"), "right");
  assert.equal(calls, 3);
  assert.deepEqual(cache.stats(), {
    capacity: 8,
    entries: 3,
    hits: 1,
    misses: 3,
    evictions: 0,
    keyCodeUnits: 14,
    outputCodeUnits: 14,
  });
});

test("uses a collision-free fixed-width u32 key", () => {
  const cache = createMaximalRunCache();
  let calls = 0;
  const decode = (ids, output) => cache.decode(ids, 0, ids.length, () => {
    calls += 1;
    return output;
  });

  assert.equal(decode([1, 0x10002], "first"), "first");
  assert.equal(decode([0x10001, 2], "second"), "second");
  assert.equal(decode([1, 0x10002], "ignored"), "first");
  assert.equal(calls, 2);
});

test("observes mutation and evicts at eight entries", () => {
  const cache = createMaximalRunCache();
  const ids = [0];
  let calls = 0;
  const decode = () => cache.decode(ids, 0, 1, () => {
    calls += 1;
    return String(ids[0]);
  });

  for (let id = 0; id < 9; id += 1) {
    ids[0] = id;
    assert.equal(decode(), String(id));
  }
  ids[0] = 0;
  assert.equal(decode(), "0");
  assert.equal(calls, 10);
  assert.deepEqual(cache.stats(), {
    capacity: 8,
    entries: 8,
    hits: 0,
    misses: 10,
    evictions: 2,
    keyCodeUnits: 16,
    outputCodeUnits: 8,
  });
});

test("validates construction and canonical output", () => {
  assert.throws(() => createMaximalRunCache(null), /options must be an object/);
  assert.throws(() => createMaximalRunCache({ capacity: 0 }), /positive safe integer/);
  const cache = createMaximalRunCache();
  assert.throws(() => cache.decode([1], 0, 1, () => 1), /must return a string/);
  assert.equal(cache.stats().entries, 0);
});
