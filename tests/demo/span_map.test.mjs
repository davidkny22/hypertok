import assert from "node:assert/strict";
import test from "node:test";

import { tokenSegments } from "../../demo/span-map.mjs";

test("maps UTF-8 starts across ASCII and multibyte text", () => {
  const result = tokenSegments(
    "a中🚀z",
    Uint32Array.of(1, 2, 3, 4),
    Uint32Array.of(0, 1, 4, 8),
  );
  assert.equal(result.leading, "");
  assert.deepEqual(result.segments.map((segment) => segment.text), ["a", "中", "🚀", "z"]);
});

test("preserves leading text and repeated starts", () => {
  const result = tokenSegments(
    " abc",
    Uint32Array.of(7, 8, 9),
    Uint32Array.of(1, 1, 2),
  );
  assert.equal(result.leading, " ");
  assert.deepEqual(result.segments.map((segment) => segment.text), ["a", "bc"]);
  assert.deepEqual(result.segments.map((segment) => segment.ids), [[7, 8], [9]]);
});

test("merges starts inside a multibyte character", () => {
  const result = tokenSegments(
    "中",
    Uint32Array.of(1, 2),
    Uint32Array.of(0, 1),
  );
  assert.equal(result.leading, "");
  assert.deepEqual(result.segments, [{ ids: [1, 2], text: "中" }]);
});

test("rejects mismatched id and start counts", () => {
  assert.throws(
    () => tokenSegments("abc", Uint32Array.of(1, 2), Uint32Array.of(0)),
    /equal lengths/,
  );
});
