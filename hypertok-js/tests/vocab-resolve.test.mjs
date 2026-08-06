import assert from "node:assert/strict";
import test from "node:test";

import { createVocabLoader, VOCAB_VERSIONS } from "../src/vocab-resolve.mjs";

test("reads an installed vocabulary without fetching", async () => {
  const calls = [];
  const load = createVocabLoader({
    async readLocal(packageName, file) {
      calls.push([packageName, file]);
      return Uint8Array.of(1, 2, 3);
    },
    async fetch() {
      throw new Error("fetch must not run");
    },
  });
  assert.deepEqual(await load("cl100k"), Uint8Array.of(1, 2, 3));
  assert.deepEqual(calls, [["@hypertok/vocab-cl100k", "vocab.htk"]]);
});

test("falls back to the pinned jsDelivr asset when local reading is unavailable", async () => {
  let requested;
  const load = createVocabLoader({
    async readLocal() {
      throw Object.assign(new Error("package absent"), { code: "ERR_MODULE_NOT_FOUND" });
    },
    async fetch(url, { signal }) {
      requested = { url, signal };
      return {
        ok: true,
        async arrayBuffer() {
          return Uint8Array.of(4, 5, 6).buffer;
        },
      };
    },
  });
  assert.deepEqual(
    await load("@hypertok/vocab-p50k", { file: "p50k-edit.htk" }),
    Uint8Array.of(4, 5, 6),
  );
  assert.equal(
    requested.url,
    `https://cdn.jsdelivr.net/npm/@hypertok/vocab-p50k@${VOCAB_VERSIONS.p50k}/p50k-edit.htk`,
  );
  assert.equal(requested.signal.aborted, false);
});

test("rejects a hung fetch at the bounded timeout and aborts it", async () => {
  let signal;
  const load = createVocabLoader({
    async readLocal() {
      throw new Error("filesystem unavailable");
    },
    async fetch(_url, options) {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(() => load("o200k", { timeoutMs: 10 }), /timed out after 10 ms/);
  assert.equal(signal.aborted, true);
});

test("bounds a response body that never completes", async () => {
  let signal;
  const load = createVocabLoader({
    async readLocal() {
      throw new Error("filesystem unavailable");
    },
    async fetch(_url, options) {
      signal = options.signal;
      return { ok: true, arrayBuffer: () => new Promise(() => {}) };
    },
  });
  await assert.rejects(() => load("gpt2", { timeoutMs: 10 }), /timed out after 10 ms/);
  assert.equal(signal.aborted, true);
});

test("rejects unknown vocabularies and unsafe asset names", async () => {
  const load = createVocabLoader();
  await assert.rejects(() => load("unknown"), /unknown hypertok vocabulary/);
  await assert.rejects(() => load("p50k", { file: "../vocab.htk" }), /package-root/);
  await assert.rejects(() => load("p50k", { timeoutMs: 0 }), /positive number/);
});
