import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeLatin1Decoder } from "../src/decode-latin1.mjs";

function fixture(entries) {
  return {
    vocabSize: () => entries.length,
    tokenBytes: (id) => {
      const bytes = entries[id];
      if (!(bytes instanceof Uint8Array)) throw new RangeError(`unknown token id ${id}`);
      return bytes;
    },
  };
}

test("round-trips every byte through one native Latin-1 unmap", () => {
  const entries = Array.from({ length: 256 }, (_, value) => Uint8Array.of(value));
  const decoder = createNativeLatin1Decoder(fixture(entries), {
    nativeUnmap: (value) => Buffer.from(value, "latin1"),
    now: () => 0,
  });
  const ids = Array.from({ length: 256 }, (_, value) => value);
  const expected = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    Uint8Array.from(ids),
  );
  assert.equal(decoder.decode(ids), expected);
  assert.deepEqual(decoder.stats(), {
    available: true,
    portable: false,
    initialized: true,
    known: 256,
    payloadCodeUnits: 256,
    presentBytes: 256,
    buildMilliseconds: 0,
    decoderCalls: 1,
    bytesConverted: 256,
    nativeScratchBytes: 0,
    nativeScratchGrows: 0,
    nativeScratchWrites: 0,
    portableDecoderCalls: 0,
    portableBytesConverted: 0,
    portableScratchBytes: 0,
  });
});

test("reuses the default native output scratch", () => {
  const entries = [Uint8Array.of(0x61), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  const decoder = createNativeLatin1Decoder(fixture(entries));
  assert.equal(decoder.decode([0, 1, 2]), "a\u20ac");
  const first = decoder.stats();
  assert.equal(first.nativeScratchBytes, 256);
  assert.equal(first.nativeScratchGrows, 1);
  assert.equal(first.nativeScratchWrites, 1);
  assert.equal(decoder.decode([0, 0, 0]), "aaa");
  const second = decoder.stats();
  assert.equal(second.nativeScratchBytes, first.nativeScratchBytes);
  assert.equal(second.nativeScratchGrows, first.nativeScratchGrows);
  assert.equal(second.nativeScratchWrites, 2);
});

test("preserves NUL, BOM, malformed UTF-8, and container refusal", () => {
  const entries = [
    Uint8Array.of(0),
    Uint8Array.of(0xef),
    Uint8Array.of(0xbb),
    Uint8Array.of(0xbf),
    Uint8Array.of(0xe2),
    Uint8Array.of(0x82, 0xac),
    null,
  ];
  const decoder = createNativeLatin1Decoder(fixture(entries), {
    nativeUnmap: (value) => Buffer.from(value, "latin1"),
    portable: true,
  });
  assert.equal(decoder.decode([0, 1, 2, 3, 4, 5]), "\0\ufeff\u20ac");
  assert.equal(decoder.decode([4]), "\ufffd");
  assert.throws(() => decoder.decode([6]), /unknown token id 6/);
  assert.throws(() => decoder.decode([1.5]), /array of u32/);
  assert.throws(() => decoder.decode([0x1_0000_0000]), /array of u32/);
  assert.throws(() => decoder.decode("0"), /array of u32/);
});

test("matches the canonical decoder on six malformed UTF-8 families", () => {
  const entries = [
    Uint8Array.of(0x80),
    Uint8Array.of(0xc0, 0xaf),
    Uint8Array.of(0xe2, 0x82),
    Uint8Array.of(0xf0, 0x80, 0x80, 0x80),
    Uint8Array.of(0xed, 0xa0, 0x80),
    Uint8Array.of(0xf5, 0x80, 0x80, 0x80),
  ];
  const decoder = createNativeLatin1Decoder(fixture(entries), {
    nativeUnmap: (value) => Buffer.from(value, "latin1"),
    portable: true,
  });
  const canonical = new TextDecoder("utf-8", { ignoreBOM: true });
  for (let id = 0; id < entries.length; id += 1) {
    assert.equal(decoder.decode([id]), canonical.decode(entries[id]));
    assert.equal(decoder.decodePortable([id]), canonical.decode(entries[id]));
  }
});

test("portable bulk unmap round-trips every byte without a native primitive", () => {
  const entries = Array.from({ length: 256 }, (_, value) => Uint8Array.of(value));
  const decoder = createNativeLatin1Decoder(fixture(entries), {
    nativeUnmap: null,
    portable: true,
  });
  const ids = Array.from({ length: 256 }, (_, value) => value);
  const expected = new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(ids));
  assert.equal(decoder.decodePortable(ids), expected);
  assert.equal(decoder.stats().available, false);
  assert.equal(decoder.stats().portable, true);
  assert.equal(decoder.stats().portableDecoderCalls, 1);
  assert.equal(decoder.stats().portableBytesConverted, 256);
  assert.equal(decoder.stats().portableScratchBytes, 256);
});

test("reports an unavailable native bulk primitive without building", () => {
  const decoder = createNativeLatin1Decoder(fixture([Uint8Array.of(65)]), {
    nativeUnmap: null,
  });
  assert.equal(decoder.available, false);
  assert.throws(() => decoder.decode([0]), /unavailable/);
  assert.equal(decoder.stats().initialized, false);
});

test("validates the core and options", () => {
  assert.throws(() => createNativeLatin1Decoder({}), /provide tokenBytes/);
  assert.throws(() => createNativeLatin1Decoder(fixture([Uint8Array.of(0)]), []), /options/);
  assert.throws(
    () => createNativeLatin1Decoder(fixture([Uint8Array.of(0)]), { nativeUnmap: true }),
    /function or null/,
  );
  assert.throws(
    () => createNativeLatin1Decoder(fixture([Uint8Array.of(0)]), { portable: "on" }),
    /portable must be a boolean/,
  );
});
