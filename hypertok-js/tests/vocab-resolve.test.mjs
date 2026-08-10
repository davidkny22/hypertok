import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createVocabLoader,
  VocabIntegrityError,
  VOCAB_VERSIONS,
} from "../src/vocab-resolve.mjs";

const p50kEdit = new Uint8Array(
  await readFile(new URL("../../hypertok-vocab/p50k/p50k-edit.htk", import.meta.url)),
);

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
          return p50kEdit.buffer.slice(p50kEdit.byteOffset, p50kEdit.byteOffset + p50kEdit.byteLength);
        },
      };
    },
  });
  assert.deepEqual(
    await load("@hypertok/vocab-p50k", { file: "p50k-edit.htk" }),
    p50kEdit,
  );
  assert.equal(
    requested.url,
    `https://cdn.jsdelivr.net/npm/@hypertok/vocab-p50k@${VOCAB_VERSIONS.p50k}/p50k-edit.htk`,
  );
  assert.equal(requested.signal.aborted, false);
});

test("refuses fetched vocabulary bytes that do not match package metadata", async () => {
  const tampered = new Uint8Array(p50kEdit);
  tampered[tampered.length - 1] ^= 1;
  const load = createVocabLoader({
    async readLocal() {
      throw new Error("filesystem unavailable");
    },
    async fetch() {
      return { ok: true, arrayBuffer: async () => tampered.buffer };
    },
  });
  await assert.rejects(
    () => load("p50k", { file: "p50k-edit.htk" }),
    (error) => {
      assert(error instanceof VocabIntegrityError);
      assert.equal(error.code, "ERR_HYPERTOK_VOCAB_INTEGRITY");
      assert.equal(error.packageName, "@hypertok/vocab-p50k");
      assert.equal(error.file, "p50k-edit.htk");
      assert.equal(error.expected, "ec4fc02da668992fdd11cd304a6cb1c7631e29c3d8de978c2b65a13eb5e3a2da");
      assert.notEqual(error.actual, error.expected);
      return true;
    },
  );
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

test("rejects unavailable vocabularies before local or CDN access", async () => {
  let localReads = 0;
  let fetches = 0;
  const load = createVocabLoader({
    async readLocal() {
      localReads += 1;
      return Uint8Array.of(1);
    },
    async fetch() {
      fetches += 1;
      return { ok: true, arrayBuffer: async () => Uint8Array.of(1).buffer };
    },
  });
  for (const name of ["minimax-m3", "@hypertok/vocab-minimax-m3"]) {
    await assert.rejects(
      () => load(name),
      (error) => error instanceof RangeError && /unknown hypertok vocabulary/.test(error.message),
    );
  }
  assert.equal(localReads, 0);
  assert.equal(fetches, 0);
});
