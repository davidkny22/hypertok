import assert from "node:assert/strict";
import { test } from "node:test";
import { createHuggingFaceShim } from "../src/huggingface-shim.mjs";

test("preserves an explicit empty text pair", () => {
  const calls = [];
  const runtime = {
    tier: "single",
    encodeReservedSync(text) {
      return { ids: text === "" ? new Uint32Array() : Uint32Array.of(1), reservedFound: [] };
    },
    decode: () => "",
    close() {},
  };
  const shim = createHuggingFaceShim(runtime, {
    tokenString: (id) => `token-${id}`,
    postProcess(first, second) {
      calls.push({
        first: Array.from(first),
        second: second === null ? null : Array.from(second),
      });
      return { ids: first };
    },
    specialTokens: [],
    unknownTokenId: 0,
    cleanUpTokenizationSpaces: false,
  });

  shim.encode("text", { text_pair: "", add_special_tokens: false });

  assert.deepEqual(calls, [{ first: [1], second: [] }]);
});
