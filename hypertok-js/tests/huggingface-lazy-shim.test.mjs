import assert from "node:assert/strict";
import { test } from "node:test";
import { createHuggingFaceShim } from "../src/huggingface-shim.mjs";
import { createLazyHuggingFaceShim } from "../src/huggingface-lazy-shim.mjs";
import { createHotStringDecoder } from "../src/decode-hotstrings.mjs";

function fixture(tokenString = (id) => `token-${id}`) {
  let closed = false;
  const runtime = {
    tier: "single",
    encodeReservedSync() {
      if (closed) throw new Error("closed");
      return { ids: Uint32Array.of(1, 2), reservedFound: ["special"] };
    },
    decode: () => "decoded",
    close() {
      closed = true;
    },
  };
  return {
    runtime,
    setup: {
      tokenString,
      postProcess: (first) => ({ ids: first, token_type_ids: [0, 0] }),
      specialTokens: [],
      unknownTokenId: 0,
      cleanUpTokenizationSpaces: false,
    },
  };
}

test("keeps ids array-compatible and memoizes every requested field", () => {
  let tokenCalls = 0;
  const { runtime, setup } = fixture((id) => {
    tokenCalls += 1;
    return `token-${id}`;
  });
  const shim = createLazyHuggingFaceShim(runtime, setup);
  const encoded = shim.encode("text", { return_token_type_ids: true });
  assert.deepEqual(encoded.ids, [1, 2]);
  assert.equal(tokenCalls, 0);
  assert.deepEqual(Object.keys(encoded), ["ids", "tokens", "attention_mask", "token_type_ids"]);
  const tokens = encoded.tokens;
  assert.deepEqual(tokens, ["token-1", "token-2"]);
  assert.equal(encoded.tokens, tokens);
  assert.equal(tokenCalls, 2);
  const attention = encoded.attention_mask;
  assert.deepEqual(attention, [1, 1]);
  assert.equal(encoded.attention_mask, attention);
  const types = encoded.token_type_ids;
  assert.deepEqual(types, [0, 0]);
  assert.equal(encoded.token_type_ids, types);
});

test("materializes ids before writes and length changes", () => {
  const { runtime, setup } = fixture();
  const encoded = createLazyHuggingFaceShim(runtime, setup).encode("text");
  const ids = encoded.ids;
  assert.equal(Array.isArray(ids), true);
  ids[0] = 9;
  ids.push(13);
  assert.deepEqual(ids, [9, 2, 13]);
  assert.deepEqual(encoded.tokens, ["token-9", "token-2", "token-13"]);
  ids.length = 2;
  assert.deepEqual(ids, [9, 2]);
});

test("matches eager direct, spread, and JSON access", () => {
  const eagerFixture = fixture();
  const lazyFixture = fixture();
  const eager = createHuggingFaceShim(eagerFixture.runtime, eagerFixture.setup);
  const lazy = createLazyHuggingFaceShim(lazyFixture.runtime, lazyFixture.setup);
  const options = { return_token_type_ids: true };
  const expected = eager.encode("text", options);
  const direct = lazy.encode("text", options);
  assert.deepEqual(
    {
      ids: direct.ids,
      tokens: direct.tokens,
      attention_mask: direct.attention_mask,
      token_type_ids: direct.token_type_ids,
    },
    expected,
  );
  assert.deepEqual({ ...lazy.encode("text", options) }, expected);
  assert.equal(JSON.stringify(lazy.encode("text", options)), JSON.stringify(expected));
});

test("preserves reserved reporting order and writable field behavior", () => {
  const { runtime, setup } = fixture();
  const shim = createLazyHuggingFaceShim(runtime, setup);
  const encoded = shim.encodeReserved("text", undefined, { return_token_type_ids: true });
  assert.deepEqual(Object.keys(encoded), [
    "ids",
    "tokens",
    "attention_mask",
    "token_type_ids",
    "reservedFound",
  ]);
  assert.deepEqual(encoded.reservedFound, ["special"]);
  encoded.tokens = ["replacement"];
  assert.deepEqual(encoded.tokens, ["replacement"]);
});

test("uses hot strings when present and falls back for cold ids", () => {
  const { runtime, setup } = fixture();
  const hits = [];
  const shim = createLazyHuggingFaceShim(runtime, setup, {
    hotStrings: {
      tokenString(id) {
        hits.push(id);
        return id === 1 ? "cached-1" : undefined;
      },
    },
  });
  assert.deepEqual(shim.encode("text").tokens, ["cached-1", "token-2"]);
  assert.deepEqual(hits, [1, 2]);
});

test("reuses strings from the bounded hot decoder", () => {
  const text = ["a", "b", "c"];
  const core = {
    vocabSize: text.length,
    tokenBytes: (id) => new TextEncoder().encode(text[id]),
    decode: (ids) => [...ids].map((id) => text[id]).join(""),
  };
  const hotStrings = createHotStringDecoder(core, { minCoverage: 0 });
  assert.equal(hotStrings.decode(Uint32Array.of(0, 1, 2, 0, 1, 2)), "abcabc");
  assert.equal(hotStrings.stats().active, true);
  const { runtime, setup } = fixture();
  const encoded = createLazyHuggingFaceShim(runtime, setup, { hotStrings }).encode("text");
  assert.deepEqual(encoded.tokens, ["b", "c"]);
});

test("keeps eager behavior default and defers lazy token failures", () => {
  let eagerCalls = 0;
  let eagerPostIds;
  let eagerPostArity;
  const eagerFixture = fixture((id) => {
    eagerCalls += 1;
    return `token-${id}`;
  });
  eagerFixture.setup.postProcess = function postProcess(first) {
    eagerPostArity = arguments.length;
    eagerPostIds = first;
    return { ids: first };
  };
  const eagerEncoding = createHuggingFaceShim(
    eagerFixture.runtime,
    eagerFixture.setup,
  ).encode("text");
  assert.equal(eagerCalls, 2);
  assert.equal(eagerPostArity, 3);
  assert.notEqual(eagerEncoding.ids, eagerPostIds);

  let lazyPostIds;
  let lazyPostArguments;
  const lazyFixture = fixture(() => undefined);
  lazyFixture.setup.postProcess = function postProcess(first) {
    lazyPostArguments = Array.from(arguments);
    lazyPostIds = first;
    return { ids: first };
  };
  const encoded = createLazyHuggingFaceShim(lazyFixture.runtime, lazyFixture.setup).encode("text");
  assert.deepEqual(encoded.ids, [1, 2]);
  assert.equal(lazyPostArguments.length, 4);
  assert.equal(lazyPostArguments[3], false);
  assert.equal(encoded.ids, lazyPostIds);
  assert.throws(() => encoded.tokens, /no token string/);
});

test("validates the optional hot-string seam", () => {
  const { runtime, setup } = fixture();
  assert.throws(
    () => createLazyHuggingFaceShim(runtime, setup, { hotStrings: {} }),
    /hotStrings must provide/,
  );
});
