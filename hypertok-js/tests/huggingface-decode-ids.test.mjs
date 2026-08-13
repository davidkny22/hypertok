import assert from "node:assert/strict";
import { test } from "node:test";
import { createHuggingFaceShim } from "../src/huggingface-shim.mjs";

function shim() {
  return createHuggingFaceShim(
    {
      tier: "single",
      encodeReservedSync: () => ({ ids: new Uint32Array(), reservedFound: [] }),
      decode: (ids) => ids.join(","),
      close() {},
    },
    {
      tokenString: (id) => (id === 64 ? "a" : undefined),
      postProcess: (first) => ({ ids: first }),
      specialTokens: [],
      unknownTokenId: 0,
      cleanUpTokenizationSpaces: false,
    },
  );
}

test("validates every decode id", () => {
  const tokenizer = shim();
  for (const ids of [
    [64, 1.5],
    [64, "1"],
    [64, -1],
    [64, Number.NaN],
    [64, 0x1_0000_0000],
    [64, -1n],
    [64, 0x1_0000_0000n],
  ]) {
    assert.throws(() => tokenizer.decode(ids), /token_ids must be a non-empty array of integers/);
  }
  assert.equal(tokenizer.decode([64, 1n]), "64,0");
});
