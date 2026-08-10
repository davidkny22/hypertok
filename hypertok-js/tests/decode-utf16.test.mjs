import assert from "node:assert/strict";
import { test } from "node:test";
import { createUtf16AssemblyDecoder } from "../src/decode-utf16.mjs";

function coreFixture() {
  const outputs = [
    Uint16Array.of(0x61, 0x20ac),
    Uint16Array.of(0xfeff, 0x61),
    Uint16Array.of(0xfffd),
  ];
  let calls = 0;
  return {
    decodeAssemblyUtf16(ids) {
      const output = outputs[ids[0]];
      if (!(output instanceof Uint16Array)) throw new Error(`unknown token id ${ids[0]}`);
      calls += 1;
      return output;
    },
    calls: () => calls,
  };
}

test("materializes UTF-16 output with replacement and BOM preservation", () => {
  const core = coreFixture();
  const decoder = createUtf16AssemblyDecoder(core);
  assert.equal(decoder.decode([0]), "a\u20ac");
  assert.equal(decoder.decode(Uint32Array.of(1)), "\ufeffa");
  assert.equal(decoder.decode([2]), "\ufffd");
  assert.equal(core.calls(), 3);
  assert.deepEqual(decoder.stats(), { decoderCalls: 3, utf16Calls: 3 });
});

test("retains input, output-shape, and unknown-id refusals", () => {
  const core = coreFixture();
  const decoder = createUtf16AssemblyDecoder(core);
  assert.throws(() => decoder.decode("0"), /decode input must be/);
  assert.throws(() => decoder.decode([-1]), /decode input must be/);
  assert.throws(() => decoder.decode([99]), /unknown token id 99/);
  assert.throws(
    () => createUtf16AssemblyDecoder({ decodeAssemblyUtf16: () => "not code units" }).decode([0]),
    /UTF-16 assembly output must be a Uint16Array/,
  );
  assert.throws(() => createUtf16AssemblyDecoder({}), /decodeAssemblyUtf16/);
});
