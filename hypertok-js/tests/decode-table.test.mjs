import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecodeTable } from "../src/decode-table.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function fixture(entries, options = {}) {
  const fallbackInputs = [];
  const fallbackKinds = [];
  const tokenBytes = (id) => {
    const bytes = entries[id];
    if (!(bytes instanceof Uint8Array)) throw new RangeError(`unknown token id ${id}`);
    return bytes;
  };
  const decode = (ids) => {
    fallbackKinds.push(ids instanceof Uint32Array ? "typed" : "array");
    fallbackInputs.push(Array.from(ids));
    let length = 0;
    const parts = Array.from(ids, (id) => {
      const bytes = tokenBytes(id);
      length += bytes.length;
      return bytes;
    });
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return decoder.decode(joined);
  };
  const table = createDecodeTable(
    { vocabSize: entries.length, tokenBytes, decode },
    { seedEntries: 1, maxTableBytes: 1024, maxDirtyDensity: 0.25, ...options },
  );
  return { table, decode, fallbackInputs, fallbackKinds };
}

test("seeds the rank head and lazily materializes clean strings", () => {
  const { table, fallbackInputs } = fixture([encoder.encode("a"), encoder.encode("bc")]);
  assert.equal(table.decode(Uint32Array.of(0, 1, 0)), "abca");
  assert.equal(table.decode([1, 0]), "bca");
  assert.deepEqual(fallbackInputs, []);
  assert.equal(table.tokenString(0), "a");
  assert.equal(table.tokenString(1), "bc");
  assert.deepEqual(
    Object.keys(table.stats()).slice(0, 5),
    ["initialized", "seedEntries", "seeded", "materialized", "metadataKnown"],
  );
  assert.equal(table.stats().materialized, 2);
  assert.equal(table.stats().tableCalls, 2);
});

test("accepts an explicit frequency-ranked seed without duplicate ids", () => {
  const entries = [encoder.encode("a"), encoder.encode("b"), encoder.encode("c")];
  const { table } = fixture(entries, { seedEntries: 2, seedIds: Uint32Array.of(2, 1) });
  table.decode(Uint32Array.of(0));
  assert.equal(table.tokenString(2), "c");
  assert.equal(table.tokenString(1), "b");
  assert.equal(table.stats().seeded, 2);
  assert.throws(
    () => fixture(entries, { seedEntries: 2, seedIds: [1, 1] }),
    /duplicate token id/,
  );
});

test("routes calls above the measured id threshold to fallback", () => {
  const { table, fallbackInputs } = fixture(
    [encoder.encode("ab"), encoder.encode("cd")],
    { maxTableIds: 1 },
  );
  assert.equal(table.decode(Uint32Array.of(0, 1)), "abcd");
  assert.deepEqual(fallbackInputs, [[0, 1]]);
  assert.equal(table.stats().fallbackCalls, 1);
  assert.equal(table.stats().largeFallbackCalls, 1);
});

test("routes dirty-dense calls whole and sparse dirty runs exactly", () => {
  const entries = [encoder.encode("A"), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  const dense = fixture(entries, { maxDirtyDensity: 0.2 });
  assert.equal(dense.table.decode(Uint32Array.of(1, 2)), "€");
  assert.deepEqual(dense.fallbackInputs, [[1, 2]]);
  assert.equal(dense.table.stats().dirtyFallbackCalls, 1);

  const sparse = fixture(entries, { maxDirtyDensity: 0.75 });
  assert.equal(sparse.table.decode(Uint32Array.of(0, 1, 2, 0)), "A€A");
  assert.deepEqual(sparse.fallbackInputs, [[1, 2]]);
  assert.equal(sparse.table.stats().mixedCalls, 1);
  assert.equal(sparse.table.stats().dirtyRunCalls, 1);
});

test("preserves invalid replacement through the fallback path", () => {
  const entries = [Uint8Array.of(0x61), Uint8Array.of(0x80), Uint8Array.of(0x62)];
  const { table, decode } = fixture(entries, { maxDirtyDensity: 0 });
  const ids = Uint32Array.of(0, 1, 2);
  assert.equal(table.decode(ids), decode(ids));
  assert.equal(table.decode(ids), "a�b");
});

test("decodes adjacent dirty tokens and invalid replacement through one JS byte table", () => {
  const entries = [
    encoder.encode("A"),
    Uint8Array.of(0xe2),
    Uint8Array.of(0x82, 0xac),
    Uint8Array.of(0x80),
    encoder.encode("B"),
  ];
  const { table, fallbackInputs } = fixture(entries, {
    byteTable: true,
    maxDirtyDensity: 0,
  });
  assert.equal(table.decode(Uint32Array.of(1, 2)), "€");
  assert.equal(table.decode([0, 3, 4]), "A�B");
  assert.deepEqual(fallbackInputs, []);
  assert.equal(table.stats().byteTableEnabled, true);
  assert.equal(table.stats().byteTableCalls, 2);
  assert.equal(table.stats().byteTableState.decoderCalls, 2);
  assert.ok(table.stats().byteTableState.arenaBytes > 0);
});

test("matches 120 dirty-adjacency fixtures", () => {
  const entries = [
    encoder.encode("A"),
    encoder.encode("B"),
    Uint8Array.of(0xe2),
    Uint8Array.of(0x82, 0xac),
    Uint8Array.of(0x80),
  ];
  const { table } = fixture(entries, {
    mixedRuns: true,
    maxMixedDirtyDensity: 1,
  });
  const cases = [];
  for (let variant = 0; variant < 24; variant += 1) {
    const left = Array(variant).fill(0);
    const right = Array(23 - variant).fill(1);
    cases.push(
      [...left, 2, 3, ...right],
      [...left, 2],
      [2, 0, 3, ...right],
      [...left, 4, ...right],
      [4, 2, 3, ...left],
    );
  }
  assert.equal(cases.length, 120);
  for (const [index, ids] of cases.entries()) {
    const parts = ids.map((id) => entries[id]);
    const total = parts.reduce((sum, bytes) => sum + bytes.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    assert.equal(table.decode(ids), decoder.decode(bytes), `dirty fixture ${index}`);
  }
});

test("keeps malformed-array and unknown-id refusal on the JS byte path", () => {
  const { table } = fixture([encoder.encode("A"), Uint8Array.of(0x80)], {
    byteTable: true,
    maxDirtyDensity: 0,
  });
  assert.equal(table.decode([1]), "�");
  for (const input of [["1"], [1.5], [-1], [0x1_0000_0000]]) {
    assert.throws(() => table.decode(input), {
      name: "TypeError",
      message: "decode input must be a Uint32Array or an array of u32 values",
    });
  }
  assert.throws(() => table.decode(Uint32Array.of(9)), /unknown token id 9/);
});

test("stitches clean strings with bulk-decoded dirty byte strings in order", () => {
  const entries = [
    encoder.encode("A"),
    Uint8Array.of(0xe2),
    Uint8Array.of(0x82, 0xac),
    encoder.encode("B"),
    Uint8Array.of(0x80),
  ];
  const { table, fallbackInputs } = fixture(entries, {
    mixedRuns: true,
    maxMixedDirtyDensity: 0.75,
  });
  assert.equal(table.decode([0, 1, 2, 3]), "A€B");
  assert.equal(table.decode([0, 4, 3]), "A�B");
  assert.deepEqual(fallbackInputs, []);
  assert.equal(table.stats().mixedRunsEnabled, true);
  assert.equal(table.stats().mixedCalls, 2);
  assert.equal(table.stats().dirtyRunCalls, 2);
  assert.equal(table.stats().byteTableState.runDecoderCalls, 2);
  assert.equal(table.stats().byteTableState.decoderCalls, 0);
});

test("caches canonical complete dirty runs across mutation and BOM boundaries", () => {
  const entries = [
    encoder.encode("A"),
    Uint8Array.of(0xe2),
    Uint8Array.of(0x82, 0xac),
    encoder.encode("B"),
    Uint8Array.of(0xef),
    Uint8Array.of(0xbb, 0xbf),
    Uint8Array.of(0x80),
  ];
  const { table, decode } = fixture(entries, {
    mixedRuns: true,
    runCache: true,
    maxMixedDirtyDensity: 1,
  });
  const ids = [0, 1, 2, 3];
  assert.equal(table.decode(ids), decode(ids));
  assert.equal(table.decode(ids), decode(ids));
  assert.equal(table.stats().runCacheState.hits, 1);
  assert.equal(table.stats().byteTableState.runDecoderCalls, 1);

  ids[2] = 6;
  assert.equal(table.decode(ids), decode(ids));
  ids[2] = 2;
  assert.equal(table.decode(ids), decode(ids));
  assert.equal(table.stats().runCacheState.hits, 2);
  assert.equal(table.stats().runCacheState.misses, 2);

  const bom = [0, 4, 5, 3];
  assert.equal(table.decode(bom), "A\ufeffB");
  assert.equal(table.decode(bom), "A\ufeffB");
  assert.equal(table.stats().runCacheState.hits, 3);
  assert.equal(table.stats().runCacheState.misses, 3);

  assert.equal(table.decode([0, 1, 3]), "A\ufffdB");
  assert.equal(table.stats().runCacheState.misses, 4);
  assert.equal(table.stats().runCacheState.capacity, 8);
});

test("routes dirty-dense segments from mixed stitching to assembly", () => {
  const entries = [encoder.encode("A"), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  const { table, fallbackInputs } = fixture(entries, {
    mixedRuns: true,
    maxMixedDirtyDensity: 0.1,
  });
  assert.equal(table.decode([1, 2]), "€");
  assert.deepEqual(fallbackInputs, [[1, 2]]);
  assert.equal(table.stats().mixedDensityFallbackCalls, 1);
  assert.deepEqual(table.stats().byteTableState, {
    initialized: false,
    known: 0,
    dirty: 0,
    dirtyPayloadBytes: 0,
    buildMilliseconds: 0,
    decoderCalls: 0,
    bytesCopied: 0,
    runDecoderCalls: 0,
    runBytesCopied: 0,
    arenaBytes: 0,
    offsetsBytes: 0,
    presentBytes: 0,
    scratchBytes: 0,
  });
});

test("routes dirty-dense segments through native Latin-1 when available", () => {
  const entries = [encoder.encode("A"), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  const { table, fallbackInputs } = fixture(entries, {
    mixedRuns: true,
    nativeLatin1: true,
    maxMixedDirtyDensity: 0.1,
  });
  assert.equal(table.decode([1, 2]), "\u20ac");
  assert.deepEqual(fallbackInputs, []);
  assert.equal(table.stats().nativeLatin1Enabled, true);
  assert.equal(table.stats().nativeLatin1State.available, true);
  assert.equal(table.stats().nativeLatin1State.decoderCalls, 1);
});

test("routes dirty-dense segments through the portable Latin-1 bulk path", () => {
  const entries = [encoder.encode("A"), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  const { table, fallbackInputs } = fixture(entries, {
    mixedRuns: true,
    portableLatin1: true,
    maxMixedDirtyDensity: 0.1,
  });
  assert.equal(table.decode([1, 2]), "\u20ac");
  assert.deepEqual(fallbackInputs, []);
  assert.equal(table.stats().portableLatin1Enabled, true);
  assert.equal(table.stats().portableLatin1State.portableDecoderCalls, 1);
});

test("routes high-dirty arrays through one reusable validated ID scratch", () => {
  const entries = [encoder.encode("a"), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  const { table, fallbackInputs, fallbackKinds } = fixture(entries, {
    mixedRuns: true,
    fusedValidation: true,
    directScratch: true,
    maxMixedDirtyDensity: 0.5,
  });
  const reads = [0, 0, 0, 0];
  const input = [1, 2, 1, 2];
  for (let index = 0; index < input.length; index += 1) {
    const id = input[index];
    Object.defineProperty(input, index, {
      configurable: true,
      get() {
        reads[index] += 1;
        return id;
      },
    });
  }
  assert.equal(table.decode(input), "€€");
  assert.deepEqual(reads, [1, 1, 1, 1]);
  assert.equal(table.decode([1, 2, 1, 2]), "€€");
  assert.deepEqual(fallbackInputs, [[1, 2, 1, 2], [1, 2, 1, 2]]);
  assert.deepEqual(fallbackKinds, ["typed", "typed"]);
  const stats = table.stats();
  assert.equal(stats.directScratchEnabled, true);
  assert.equal(stats.directScratchCalls, 2);
  assert.deepEqual(stats.directScratchState, {
    capacity: 4,
    preparations: 2,
    grows: 1,
    reentrantAllocations: 0,
  });
  assert.throws(() => table.decode([1, -1]), /decode input/);
});

test("keeps typed and shared-memory containers off the reusable ID scratch", () => {
  const entries = [encoder.encode("a"), Uint8Array.of(0xe2)];
  const { table } = fixture(entries, {
    mixedRuns: true,
    fusedValidation: true,
    directScratch: true,
    maxMixedDirtyDensity: 0,
  });
  const typed = typeof SharedArrayBuffer === "function"
    ? new Uint32Array(new SharedArrayBuffer(4))
    : Uint32Array.of(1);
  typed[0] = 1;
  assert.equal(table.decode(typed), "�");
  assert.equal(table.stats().directScratchCalls, 0);
  assert.equal(table.stats().directScratchState.preparations, 0);
});

test("routes equal dirty density by dirty-run count", () => {
  const entries = [encoder.encode("A"), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  const { table, fallbackInputs } = fixture(entries, {
    mixedRuns: true,
    maxMixedDirtyDensity: 0.5,
  });
  const oneRun = [1, 2, 1, 2, 0, 0, 0, 0, 0, 0];
  const twoRuns = [1, 2, 0, 1, 2, 0, 0, 0, 0, 0];
  assert.equal(table.decode(oneRun), `\u20ac\u20ac${"A".repeat(6)}`);
  assert.deepEqual(fallbackInputs, []);
  assert.equal(table.decode(twoRuns), `\u20acA\u20ac${"A".repeat(5)}`);
  assert.deepEqual(fallbackInputs, [twoRuns]);
  assert.equal(table.stats().mixedRunPenalty, 1);
  assert.equal(table.stats().mixedRunFallbackCalls, 1);
  assert.equal(table.stats().mixedDensityFallbackCalls, 0);
});

test("delegates unknown-id refusal to the fallback", () => {
  const { table } = fixture([encoder.encode("a")]);
  assert.throws(() => table.decode(Uint32Array.of(4)), /unknown token id 4/);
  assert.equal(table.stats().missingKnown, 0);
  assert.equal(table.stats().unknownFallbackCalls, 1);
});

test("returns only already materialized token strings", () => {
  const { table } = fixture([encoder.encode("a"), encoder.encode("b")]);
  assert.equal(table.tokenString(1), undefined);
  table.decode(Uint32Array.of(1));
  assert.equal(table.tokenString(1), "b");
  assert.equal(table.tokenString(-1), undefined);
});

test("manufactures exact one-byte and multibyte strings without changing payload accounting", () => {
  const entries = ["a", "é", "€", "😀"].map((text) => encoder.encode(text));
  const { table, fallbackInputs } = fixture(entries, { seedEntries: entries.length });
  assert.equal(table.decode([0, 1, 2, 3]), "aé€😀");
  assert.equal(table.tokenString(0), "a");
  assert.equal(table.tokenString(1), "é");
  assert.equal(table.tokenString(2), "€");
  assert.equal(table.tokenString(3), "😀");
  assert.equal(table.stats().stringPayloadBytes, 8);
  assert.deepEqual(fallbackInputs, []);
});

test("matches UTF-8 decoding across scalar boundaries", () => {
  const codepoints = [
    0, 0x7f, 0x80, 0xff, 0x100, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff,
    0x1_0000, 0x10_ffff,
  ];
  let state = 0x9e37_79b9;
  for (let index = 0; index < 1024; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    let codepoint = state % 0x11_0000;
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) codepoint += 0x800;
    codepoints.push(codepoint);
  }
  const expected = String.fromCodePoint(...codepoints);
  const { table, fallbackInputs } = fixture([encoder.encode(expected)]);
  assert.equal(table.decode(Uint32Array.of(0)), expected);
  assert.deepEqual(fallbackInputs, []);
});

test("keeps strict u32 refusal after the packed table is hot", () => {
  const { table } = fixture([encoder.encode("a"), encoder.encode("b")], { seedEntries: 2 });
  assert.equal(table.decode([0, 1]), "ab");
  for (const input of [["0"], [0, "1"], [1.5], [-1], [0x1_0000_0000]]) {
    assert.throws(() => table.decode(input), {
      name: "TypeError",
      message: "decode input must be a Uint32Array or an array of u32 values",
    });
  }
});

test("fuses fallback validation and conversion after the first table miss", () => {
  const entries = [encoder.encode("A"), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  const { table, fallbackInputs, fallbackKinds } = fixture(entries, {
    fusedValidation: true,
    maxDirtyDensity: 0,
  });
  const reads = [0, 0, 0];
  const ids = [];
  for (const [index, id] of [0, 1, 2].entries()) {
    Object.defineProperty(ids, index, {
      configurable: true,
      enumerable: true,
      get() {
        reads[index] += 1;
        return id;
      },
    });
  }
  ids.length = 3;
  assert.equal(table.decode(ids), "A\u20ac");
  assert.deepEqual(reads, [2, 2, 1]);
  assert.equal(fallbackInputs.length, 1);
  assert.deepEqual(fallbackInputs[0], [0, 1, 2]);
  assert.deepEqual(fallbackKinds, ["typed"]);
  assert.equal(table.stats().fusedValidationEnabled, true);
});

test("rechecks a carried clean prefix against the fused snapshot", () => {
  const entries = [encoder.encode("A"), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  const { table } = fixture(entries, { fusedValidation: true, maxDirtyDensity: 0 });
  let firstReads = 0;
  const ids = [];
  Object.defineProperty(ids, 0, {
    configurable: true,
    enumerable: true,
    get() {
      firstReads += 1;
      return firstReads === 1 ? 0 : 1;
    },
  });
  ids[1] = 2;
  ids.length = 2;
  assert.equal(table.decode(ids), "\u20ac");
  assert.equal(firstReads, 2);
});

test("keeps the exotic natural-array contract on fused fallback", () => {
  const entries = [encoder.encode("A"), Uint8Array.of(0x80)];
  const { table } = fixture(entries, { fusedValidation: true, maxDirtyDensity: 0 });
  const coercion = { valueOf: () => { throw new Error("must not coerce"); } };
  for (const value of [1.5, -1, 0x1_0000_0000, NaN, Infinity, -Infinity, 1n, Symbol("id"), new Number(0), coercion]) {
    assert.throws(
      () => table.decode([value]),
      {
        name: "TypeError",
        message: "decode input must be a Uint32Array or an array of u32 values",
      },
    );
  }
  assert.equal(table.decode([-0]), "A");
  const mutable = [0];
  assert.equal(table.decode(mutable), "A");
  mutable[0] = 1;
  assert.equal(table.decode(mutable), "\ufffd");
});

test("reads each ordinary-array id once on the steady pure-join path", () => {
  const { table } = fixture([encoder.encode("a"), encoder.encode("b")], { seedEntries: 2 });
  table.decode([0, 1, 0]);
  let elementReads = 0;
  const ids = new Proxy([0, 1, 0], {
    get(target, property, receiver) {
      if (/^(?:0|[1-9][0-9]*)$/.test(String(property))) elementReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal(table.decode(ids), "aba");
  assert.equal(elementReads, ids.length);
});

test("unrolls clean tails with separate appends and exact validation order", () => {
  const { table } = fixture([encoder.encode("a"), encoder.encode("b")], {
    seedEntries: 2,
    cleanUnroll: true,
  });
  for (let length = 0; length <= 9; length += 1) {
    const ids = Array.from({ length }, (_, index) => index & 1);
    const expected = ids.map((id) => id === 0 ? "a" : "b").join("");
    assert.equal(table.decode(ids), expected);
    assert.equal(table.decode(Uint32Array.from(ids)), expected);
  }
  const reads = [0, 0, 0, 0];
  const ids = [0, 0, 0, 0];
  for (let index = 0; index < ids.length; index += 1) {
    Object.defineProperty(ids, index, {
      configurable: true,
      get() {
        reads[index] += 1;
        return index === 2 ? 1.5 : index & 1;
      },
    });
  }
  assert.throws(() => table.decode(ids), /array of u32/);
  assert.deepEqual(reads, [2, 2, 2, 0]);
  assert.equal(table.stats().cleanUnrollEnabled, true);
});

test("lean dispatch preserves exact hot-path validation and route counters", () => {
  const { table } = fixture([encoder.encode("a"), encoder.encode("b")], {
    seedEntries: 2,
    leanDispatch: true,
  });
  assert.equal(table.decode([0, 1, -0]), "aba");
  const coercion = { valueOf: () => { throw new Error("must not coerce"); } };
  for (const value of [1.5, -1, 0x1_0000_0000, NaN, Infinity, -Infinity, 1n, Symbol("id"), new Number(0), coercion]) {
    assert.throws(
      () => table.decode([value]),
      {
        name: "TypeError",
        message: "decode input must be a Uint32Array or an array of u32 values",
      },
    );
  }
  const stats = table.stats();
  assert.equal(stats.leanDispatchEnabled, true);
  assert.equal(stats.tableCalls, 1);
  assert.equal(stats.fallbackCalls, 0);
});

test("validates options, inputs, and the core seam", () => {
  const core = {
    vocabSize: 1,
    tokenBytes: () => encoder.encode("a"),
    decode: () => "a",
  };
  assert.throws(() => createDecodeTable({}, {}), /provide decode and tokenBytes/);
  assert.throws(() => createDecodeTable(core, []), /options must be an object/);
  assert.throws(() => createDecodeTable(core, { seedEntries: -1 }), /seedEntries/);
  assert.throws(() => createDecodeTable(core, { maxDirtyDensity: 2 }), /between zero and one/);
  assert.throws(() => createDecodeTable(core, { byteTable: "on" }), /must be a boolean/);
  assert.throws(() => createDecodeTable(core, { mixedRuns: "on" }), /must be a boolean/);
  assert.throws(() => createDecodeTable(core, { runCache: "on" }), /must be a boolean/);
  assert.throws(() => createDecodeTable(core, { nativeLatin1: "on" }), /must be a boolean/);
  assert.throws(() => createDecodeTable(core, { portableLatin1: "on" }), /must be a boolean/);
  assert.throws(
    () => createDecodeTable(core, { runCache: true }),
    /requires mixed-run decode/,
  );
  assert.throws(() => createDecodeTable(core, { fusedValidation: "on" }), /must be a boolean/);
  assert.throws(() => createDecodeTable(core, { leanDispatch: "on" }), /must be a boolean/);
  assert.throws(() => createDecodeTable(core, { cleanUnroll: "on" }), /must be a boolean/);
  assert.throws(() => createDecodeTable(core, { directScratch: "on" }), /must be a boolean/);
  assert.throws(
    () => createDecodeTable(core, { directScratch: true }),
    /requires mixed-run decode/,
  );
  assert.throws(() => createDecodeTable(core, { mixedRunPenalty: -1 }), /nonnegative finite/);
  assert.throws(() => createDecodeTable(core).decode([1.5]), /array of u32/);
});
