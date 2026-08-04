import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssemblyDecoder } from "../src/decode-assembly.mjs";

function fakeCore(entries) {
  return {
    decodeAssemblyBytes(ids) {
      const pieces = [...ids].map((id) => {
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

test("assembles one byte buffer and decodes it once", () => {
  const decoder = createAssemblyDecoder(fakeCore(entries));
  assert.equal(decoder.decode(Uint32Array.of(0, 1, 2, 3)), "a€");
  assert.equal(decoder.stats().decoderCalls, 1);
  assert.equal(decoder.decode([0, 0]), "aa");
  assert.equal(decoder.stats().decoderCalls, 2);
});

test("preserves invalid replacement across token boundaries", () => {
  const decoder = createAssemblyDecoder(fakeCore(entries));
  assert.equal(decoder.decode([1, 2]), "�");
  assert.equal(decoder.decode([4, 0]), "�a");
  assert.equal(decoder.stats().decoderCalls, 2);
});

test("preserves a leading byte-order mark", () => {
  const decoder = createAssemblyDecoder(fakeCore(entries));
  assert.equal(decoder.decode([5, 6, 7, 0]), "\ufeffa");
});

test("retains input and unknown-id refusals", () => {
  const decoder = createAssemblyDecoder(fakeCore(entries));
  assert.throws(() => decoder.decode("0"), /decode input must be/);
  assert.throws(() => decoder.decode([-1]), /decode input must be/);
  assert.throws(() => decoder.decode(Uint32Array.of(99)), /unknown token id 99/);
  assert.equal(decoder.stats().decoderCalls, 0);
});

test("requires the raw assembly seam", () => {
  assert.throws(() => createAssemblyDecoder({}), /decodeAssemblyBytes/);
});
