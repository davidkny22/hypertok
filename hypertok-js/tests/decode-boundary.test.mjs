import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoundaryDecoder } from "../src/decode-boundary.mjs";

function fakeCore(entries, initialCapacity = 2) {
  let ids = new Uint32Array(initialCapacity);
  let highWater = initialCapacity;
  const events = [];
  return {
    decodeBoundaryBytes(used) {
      events.push("decode");
      const pieces = [...ids.subarray(0, used)].map((id) => {
        const bytes = entries.get(id);
        if (bytes === undefined) throw new Error(`unknown token id ${id}`);
        return bytes;
      });
      const output = new Uint8Array(pieces.reduce((sum, bytes) => sum + bytes.length, 0));
      let offset = 0;
      for (const bytes of pieces) {
        output.set(bytes, offset);
        offset += bytes.length;
      }
      return output;
    },
    events,
    growResidentDecodeIds() {
      events.push("grow");
      const grown = new Uint32Array(ids.length * 2);
      grown.set(ids);
      ids = grown;
      highWater = Math.max(highWater, ids.length);
    },
    residentDecodeIdsCapacity() {
      return ids.length;
    },
    residentDecodeIdsHighWater() {
      return highWater;
    },
    residentDecodeIdsView() {
      events.push("view");
      return ids;
    },
  };
}

const entries = new Map([
  [0, Uint8Array.of(0x61)],
  [1, Uint8Array.of(0xe2)],
  [2, Uint8Array.of(0x82)],
  [3, Uint8Array.of(0xac)],
  [4, Uint8Array.of(0x80)],
  [5, Uint8Array.of(0xef)],
  [6, Uint8Array.of(0xbb)],
  [7, Uint8Array.of(0xbf)],
]);

test("grows before reacquiring the resident view", () => {
  const core = fakeCore(entries);
  const decoder = createBoundaryDecoder(core);
  assert.equal(decoder.decode(Uint32Array.of(0, 1, 2, 3)), "a€");
  assert.deepEqual(core.events, ["grow", "view", "decode"]);
  assert.deepEqual(decoder.stats(), {
    decoderCalls: 1,
    growCalls: 1,
    highWaterIds: 4,
    viewAcquisitions: 1,
    viewWrites: 1,
  });
});

test("preserves invalid replacement and ordinary arrays", () => {
  const decoder = createBoundaryDecoder(fakeCore(entries));
  assert.equal(decoder.decode([1, 2]), "�");
  assert.equal(decoder.decode([4, 0]), "�a");
  assert.equal(decoder.stats().decoderCalls, 2);
  assert.equal(decoder.stats().viewAcquisitions, 1);
});

test("preserves a leading byte-order mark", () => {
  const decoder = createBoundaryDecoder(fakeCore(entries, 4));
  assert.equal(decoder.decode([5, 6, 7, 0]), "\ufeffa");
});

test("retains input and unknown-id refusals", () => {
  const decoder = createBoundaryDecoder(fakeCore(entries));
  assert.throws(() => decoder.decode("0"), /decode input must be/);
  assert.throws(() => decoder.decode([-1]), /decode input must be/);
  assert.throws(() => decoder.decode(Uint32Array.of(99)), /unknown token id 99/);
  assert.equal(decoder.stats().decoderCalls, 0);
});

test("requires the complete resident seam", () => {
  assert.throws(() => createBoundaryDecoder({}), /resident decode id seam/);
});
