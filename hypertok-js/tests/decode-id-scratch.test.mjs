import assert from "node:assert/strict";
import { test } from "node:test";
import { createValidatedIdScratch } from "../src/decode-id-scratch.mjs";

const isU32 = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;

test("reuses validated storage and reads accessor arrays once", () => {
  const scratch = createValidatedIdScratch(isU32);
  const reads = [0, 0, 0];
  const input = [0, 0, 0];
  for (let index = 0; index < input.length; index += 1) {
    Object.defineProperty(input, index, {
      configurable: true,
      get() {
        reads[index] += 1;
        return index + 1;
      },
    });
  }
  let firstBuffer;
  assert.deepEqual(
    scratch.withValidated(input, (ids) => {
      firstBuffer = ids.buffer;
      return Array.from(ids);
    }),
    [1, 2, 3],
  );
  assert.deepEqual(reads, [1, 1, 1]);
  assert.equal(scratch.withValidated([4, 5], (ids) => ids.buffer), firstBuffer);
  assert.deepEqual(scratch.stats(), {
    capacity: 4,
    preparations: 2,
    grows: 1,
    reentrantAllocations: 0,
  });
});

test("isolates a reentrant decode from the active reusable view", () => {
  const scratch = createValidatedIdScratch(isU32);
  assert.deepEqual(
    scratch.withValidated([1, 2, 3], (outer) => {
      assert.deepEqual(scratch.withValidated([9, 8], (inner) => Array.from(inner)), [9, 8]);
      return Array.from(outer);
    }),
    [1, 2, 3],
  );
  assert.equal(scratch.stats().reentrantAllocations, 1);
});

test("preserves strict container and u32 refusal", () => {
  const scratch = createValidatedIdScratch(isU32);
  assert.throws(() => scratch.withValidated(Uint32Array.of(1), () => {}), /decode input/);
  assert.throws(() => scratch.withValidated([1.5], () => {}), /decode input/);
  assert.throws(() => scratch.withValidated([1], null), /synchronous consumer/);
  assert.throws(() => createValidatedIdScratch(null), /validation function/);
});
