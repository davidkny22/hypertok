import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecodeMemo } from "../src/decode-memo.mjs";

function fixture() {
  let calls = 0;
  const decoder = {
    decode(input) {
      calls += 1;
      if (!(input instanceof Uint32Array) && !Array.isArray(input)) {
        throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
      }
      let output = "";
      for (const value of input) {
        if (typeof value !== "number" || (value >>> 0) !== value || value > 3) {
          throw new TypeError("decode input must contain known u32 values");
        }
        output += ["a", "b", "c", "d"][value];
      }
      return output;
    },
  };
  return { decoder, calls: () => calls };
}

test("returns a memoized result only after complete content verification", () => {
  const source = fixture();
  const memo = createDecodeMemo(source.decoder);
  const ids = [0, 1, 2, 3];
  assert.equal(memo.decode(ids), "abcd");
  assert.equal(memo.decode(ids), "abcd");
  assert.equal(source.calls(), 2);
  assert.equal(memo.decode(ids), "abcd");
  assert.equal(source.calls(), 2);

  ids[1] = 3;
  assert.equal(memo.decode(ids), "adcd");
  assert.equal(source.calls(), 3);
  assert.equal(memo.decode(ids), "adcd");
  assert.equal(source.calls(), 3);

  ids.splice(1, 2, 1);
  assert.equal(memo.decode(ids), "abd");
  ids.push(2);
  assert.equal(memo.decode(ids), "abdc");

  const stats = memo.stats();
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 5);
  assert.equal(stats.mismatches, 3);
  assert.equal(stats.entries, 1);
});

test("rejects collision-shaped and invalid mutations through the canonical decoder", () => {
  const source = fixture();
  const memo = createDecodeMemo(source.decoder);
  const ids = [0, 1, 2, 3];
  assert.equal(memo.decode(ids), "abcd");
  assert.equal(memo.decode(ids), "abcd");
  assert.equal(memo.decode(ids), "abcd");

  ids.splice(1, 2, 2, 1);
  assert.equal(memo.decode(ids), "acbd");
  assert.equal(source.calls(), 3, "same length, endpoints, and sum must miss");

  ids[2] = 1.5;
  assert.throws(() => memo.decode(ids), /known u32/);
  assert.equal(source.calls(), 4);
  ids[2] = 1;
  assert.equal(memo.decode(ids), "acbd");
  assert.equal(source.calls(), 4, "a reverted valid snapshot may hit again");
});

test("delegates every exotic mutation after a seeded hit", () => {
  const source = fixture();
  const memo = createDecodeMemo(source.decoder);
  const ids = [0];
  assert.equal(memo.decode(ids), "a");
  assert.equal(memo.decode(ids), "a");
  assert.equal(memo.decode(ids), "a");

  const coercion = { valueOf: () => { throw new Error("must not coerce"); } };
  const invalidValues = [
    1.5,
    -1,
    0x1_0000_0000,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("id"),
    new Number(0),
    coercion,
  ];
  for (const value of invalidValues) {
    ids[0] = value;
    assert.throws(
      () => memo.decode(ids),
      {
        name: "TypeError",
        message: "decode input must contain known u32 values",
      },
    );
    ids[0] = 0;
    assert.equal(memo.decode(ids), "a");
  }

  ids[0] = -0;
  assert.equal(memo.decode(ids), "a");
  assert.equal(memo.stats().mismatches, invalidValues.length);
  assert.equal(source.calls(), invalidValues.length + 2);
});

test("observes first, middle, last, and length mutations", () => {
  const source = fixture();
  const memo = createDecodeMemo(source.decoder);
  const ids = [0, 1, 2];
  assert.equal(memo.decode(ids), "abc");
  assert.equal(memo.decode(ids), "abc");
  assert.equal(memo.decode(ids), "abc");

  ids[0] = 3;
  assert.equal(memo.decode(ids), "dbc");
  ids[1] = 0;
  assert.equal(memo.decode(ids), "dac");
  ids[2] = 1;
  assert.equal(memo.decode(ids), "dab");
  ids.push(2);
  assert.equal(memo.decode(ids), "dabc");
  ids.pop();
  assert.equal(memo.decode(ids), "dab");
  assert.equal(source.calls(), 7);
});

test("tracks typed-array mutations and does not conflate equal containers", () => {
  const source = fixture();
  const memo = createDecodeMemo(source.decoder);
  const first = Uint32Array.of(0, 1, 2);
  const second = Uint32Array.of(0, 1, 2);
  assert.equal(memo.decode(first), "abc");
  assert.equal(memo.decode(first), "abc");
  assert.equal(memo.decode(second), "abc");
  assert.equal(memo.decode(second), "abc");
  assert.equal(source.calls(), 4);
  first[1] = 3;
  assert.equal(memo.decode(first), "adc");
  assert.equal(source.calls(), 5);
  assert.equal(memo.decode(second), "abc");
  assert.equal(source.calls(), 5);
});

test("keeps accessor, sparse, subclassed, shared, and oversized containers off the memo", () => {
  const source = fixture();
  const memo = createDecodeMemo(source.decoder, { maxIds: 4, maxOutputCodeUnits: 4 });

  const accessor = [0, 1];
  Object.defineProperty(accessor, "1", { enumerable: true, configurable: true, get: () => 1 });
  assert.equal(memo.decode(accessor), "ab");
  assert.equal(memo.decode(accessor), "ab");

  const sparse = [0, , 1];
  assert.throws(() => memo.decode(sparse), /known u32/);

  class Ids extends Array {}
  const subclassed = new Ids(0, 1);
  assert.equal(memo.decode(subclassed), "ab");
  assert.equal(memo.decode(subclassed), "ab");

  const oversized = [0, 0, 0, 0, 0];
  assert.equal(memo.decode(oversized), "aaaaa");
  assert.equal(memo.decode(oversized), "aaaaa");

  if (typeof SharedArrayBuffer === "function") {
    const shared = new Uint32Array(new SharedArrayBuffer(8));
    shared.set([0, 1]);
    assert.equal(memo.decode(shared), "ab");
    assert.equal(memo.decode(shared), "ab");
  }

  assert.equal(memo.stats().hits, 0);
  assert.ok(memo.stats().uncacheable >= 1);
});

test("bypasses memo state when the repeated container set exceeds its bound", () => {
  const source = fixture();
  const memo = createDecodeMemo(source.decoder, { maxEntries: 2 });
  const first = [0];
  const second = [1];
  const third = [2];
  assert.equal(memo.decode(first), "a");
  assert.equal(memo.decode(first), "a");
  assert.equal(memo.decode(first), "a");
  assert.equal(memo.decode(second), "b");
  assert.equal(memo.decode(third), "c");
  assert.equal(memo.stats().capacityBypassed, true);
  assert.equal(memo.stats().observedContainers, 3);
  assert.equal(memo.stats().entries, 0);
  assert.equal(memo.stats().hits, 1);
  assert.equal(memo.decode(first), "a");
  assert.equal(source.calls(), 5);
});

test("validates decoder and limits", () => {
  assert.throws(() => createDecodeMemo({}), /requires a decoder/);
  assert.throws(() => createDecodeMemo(fixture().decoder, []), /options must be an object/);
  assert.throws(() => createDecodeMemo(fixture().decoder, { maxEntries: 0 }), /positive integer/);
  assert.throws(() => createDecodeMemo(fixture().decoder, { maxIds: 1.5 }), /positive integer/);
  assert.throws(
    () => createDecodeMemo(fixture().decoder, { maxOutputCodeUnits: -1 }),
    /positive integer/,
  );
});
