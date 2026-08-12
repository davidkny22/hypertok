import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fromBytes } from "../src/index.mjs";
import { createResolvedVocabHandle } from "../src/resolver-provenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("root API loads HTK bytes and exposes the declared single-tier surface", async () => {
  const bytes = await readFile(path.join(root, "hypertok-vocab", "o200k", "vocab.htk"));
  const tokenizer = await fromBytes(bytes, { tier: "single" });
  try {
    assert.equal(tokenizer.vocabSize, 200019);
    assert.equal(tokenizer.structuralClass, "byte_bpe");
    assert.equal(tokenizer.tier, "single");
    assert.equal(tokenizer.formatVersion, 1);
    assert.deepEqual(Array.from(tokenizer.prefixMarker), []);
    assert.deepEqual(Array.from(tokenizer.suffixMarker), []);
    const sync = tokenizer.encodeSync("hello world");
    const asyncIds = await tokenizer.encode("hello world");
    assert.deepEqual(asyncIds, sync);
    const destination = new Uint32Array(sync.length + 2).fill(0xffff_ffff);
    assert.equal(await tokenizer.encodeInto("hello world", destination), sync.length);
    assert.deepEqual(destination.subarray(0, sync.length), sync);
    assert.deepEqual(Array.from(destination.subarray(sync.length)), [0xffff_ffff, 0xffff_ffff]);
    await assert.rejects(
      () => tokenizer.encodeInto("hello world", new Uint32Array(sync.length - 1)),
      /destination has capacity/,
    );
    assert.equal(tokenizer.decode(sync), "hello world");
    const detailed = await tokenizer.encodeDetailed("hello world");
    assert.deepEqual(detailed.ids, sync);
    assert.equal(detailed.starts.length, sync.length);
    assert.ok(tokenizer.tokenBytes(sync[0]).length > 0);
  } finally {
    tokenizer.free();
  }
});

test("root API rejects invalid bytes and options", async () => {
  await assert.rejects(() => fromBytes("not bytes"), /Uint8Array or ArrayBuffer/);
  await assert.rejects(() => fromBytes(new Uint8Array(), null), /load options must be an object/);
  await assert.rejects(
    () => fromBytes(new Uint8Array(), { validate: "yes" }),
    /validate must be a boolean/,
  );
  await assert.rejects(
    () => fromBytes({ bytes: new Uint8Array() }),
    /Uint8Array or ArrayBuffer/,
  );
});

test("resolver-owned handles use trusted construction while bare bytes retain refusal", async () => {
  const source = new Uint8Array(
    await readFile(path.join(root, "hypertok-vocab", "gpt2", "vocab.htk")),
  );
  const corruptedDigest = new Uint8Array(source);
  corruptedDigest[32] ^= 1;
  const handle = createResolvedVocabHandle(corruptedDigest);
  const tokenizer = await fromBytes(handle, { tier: "single" });
  try {
    const ids = await tokenizer.encode("resolver provenance");
    assert.equal(tokenizer.decode(ids), "resolver provenance");
  } finally {
    tokenizer.free();
  }
  await assert.rejects(
    () => fromBytes(handle, { tier: "single", validate: true }),
    /digest does not match/,
  );
  await assert.rejects(
    () => fromBytes(corruptedDigest, { tier: "single" }),
    /digest does not match/,
  );
});

test("root API exposes SentencePiece structure and prefix markers", async () => {
  const bytes = await readFile(path.join(root, "tests", "fixtures", "sentencepiece.htk"));
  const tokenizer = await fromBytes(bytes, { tier: "single" });
  try {
    assert.equal(tokenizer.vocabSize, 261);
    assert.equal(tokenizer.structuralClass, "sentencepiece_bpe");
    assert.deepEqual(Array.from(tokenizer.prefixMarker), [259]);
    assert.deepEqual(Array.from(tokenizer.suffixMarker), []);
    const cases = [
      "hello world",
      "Unicode: 中文 café",
      "emoji 👩🏽‍💻 and punctuation!",
      "line one\nline two",
    ];
    for (const input of cases) {
      const sync = tokenizer.encodeSync(input);
      assert.deepEqual(await tokenizer.encode(input), sync);
      const destination = new Uint32Array(sync.length + 1).fill(0xffff_ffff);
      assert.equal(await tokenizer.encodeInto(input, destination), sync.length);
      assert.deepEqual(destination.subarray(0, sync.length), sync);
      assert.equal(destination[sync.length], 0xffff_ffff);
      assert.equal(tokenizer.decode(sync), input);
      const detailed = await tokenizer.encodeDetailed(input);
      assert.deepEqual(detailed.ids, sync);
      assert.equal(detailed.starts.length, sync.length);
      assert.ok(detailed.starts.every((start, index) => index === 0 || start >= detailed.starts[index - 1]));
      assert.ok(detailed.starts.every((start) => start <= Buffer.byteLength(input)));
      assert.deepEqual(detailed.reservedFound, []);
      assert.ok(sync.length === 0 || tokenizer.tokenBytes(sync[0]).length > 0);
    }
    const detailed = await tokenizer.encodeDetailed("ab");
    assert.deepEqual(Array.from(detailed.ids), [258]);
    assert.deepEqual(Array.from(detailed.starts), [0]);
  } finally {
    tokenizer.free();
  }
  await assert.rejects(
    () => fromBytes(bytes, { tier: "worker" }),
    /worker tier is unavailable for sentencepiece vocabularies/,
  );
  await assert.rejects(
    () => fromBytes(bytes, { tier: "single", workers: 0 }),
    /workers must be a positive integer/,
  );
});

test("resolver-owned SentencePiece handles use the trusted constructor", async () => {
  const bytes = await readFile(path.join(root, "tests", "fixtures", "sentencepiece.htk"));
  const tokenizer = await fromBytes(createResolvedVocabHandle(bytes), { tier: "single" });
  try {
    const ids = await tokenizer.encode("hello world");
    assert.equal(tokenizer.decode(ids), "hello world");
  } finally {
    tokenizer.free();
  }
});
