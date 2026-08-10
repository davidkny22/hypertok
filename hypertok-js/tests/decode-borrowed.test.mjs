import assert from "node:assert/strict";
import { test } from "node:test";
import { createBorrowedAssemblyDecoder } from "../src/decode-borrowed.mjs";

function coreFixture() {
  const outputs = [
    Uint8Array.of(0x61, 0xe2, 0x82, 0xac),
    Uint8Array.of(0xef, 0xbb, 0xbf, 0x61),
    Uint8Array.of(0xe2, 0x82),
  ];
  let calls = 0;
  return {
    decodeBorrowedAssemblyView(ids) {
      const output = outputs[ids[0]];
      if (!(output instanceof Uint8Array)) throw new Error(`unknown token id ${ids[0]}`);
      calls += 1;
      return output.subarray();
    },
    calls: () => calls,
  };
}

test("decodes borrowed bytes synchronously with exact replacement and BOM handling", () => {
  const core = coreFixture();
  const decoder = createBorrowedAssemblyDecoder(core);
  assert.equal(decoder.decode([0]), "a\u20ac");
  assert.equal(decoder.decode(Uint32Array.of(1)), "\ufeffa");
  assert.equal(decoder.decode([2]), "\ufffd");
  assert.equal(core.calls(), 3);
  assert.deepEqual(decoder.stats(), { decoderCalls: 3, borrowedViewCalls: 3 });
});

test("retains input, output-shape, and unknown-id refusals", () => {
  const core = coreFixture();
  const decoder = createBorrowedAssemblyDecoder(core);
  assert.throws(() => decoder.decode("0"), /decode input must be/);
  assert.throws(() => decoder.decode([-1]), /decode input must be/);
  assert.throws(() => decoder.decode([99]), /unknown token id 99/);
  assert.throws(
    () => createBorrowedAssemblyDecoder({
      decodeBorrowedAssemblyView: () => "not bytes",
    }).decode([0]),
    /borrowed assembly output must be a Uint8Array/,
  );
  assert.throws(
    () => createBorrowedAssemblyDecoder({}),
    /decodeBorrowedAssemblyView/,
  );
});
