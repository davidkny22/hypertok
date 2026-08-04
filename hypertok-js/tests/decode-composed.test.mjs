import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposedDecoder } from "../src/decode-composed.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function coreFixture() {
  const entries = [encoder.encode("a"), encoder.encode("bc"), Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)];
  let resident = new Uint32Array(16);
  const gather = (ids) => {
    const parts = Array.from(ids, (id) => {
      const bytes = entries[id];
      if (!(bytes instanceof Uint8Array)) throw new RangeError(`unknown token id ${id}`);
      return bytes;
    });
    const length = parts.reduce((sum, bytes) => sum + bytes.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const bytes of parts) {
      output.set(bytes, offset);
      offset += bytes.length;
    }
    return output;
  };
  return {
    vocabSize: () => entries.length,
    tokenBytes: (id) => {
      const bytes = entries[id];
      if (!(bytes instanceof Uint8Array)) throw new RangeError(`unknown token id ${id}`);
      return bytes;
    },
    decode: (ids) => decoder.decode(gather(ids)),
    decodeAssemblyBytes: gather,
    residentDecodeIdsCapacity: () => resident.length,
    residentDecodeIdsHighWater: () => resident.length,
    residentDecodeIdsView: () => resident,
    growResidentDecodeIds: () => {
      resident = new Uint32Array(resident.length * 2);
    },
    decodeBoundaryBytes: (length) => gather(resident.subarray(0, length)),
  };
}

const tableOptions = {
  seedEntries: 2,
  seedIds: Uint32Array.of(0, 1),
  maxTableIds: 16,
  maxDirtyDensity: 0,
};
const hotStringOptions = {
  maxEntries: 2,
  maxPayloadBytes: 64,
  minCoverage: 0,
};

for (const configuration of [
  { boundary: false, table: false, hotStrings: false },
  { assembly: false, boundary: false, table: false, hotStrings: false },
  { boundary: true, table: false, hotStrings: false },
  { boundary: false, table: true, hotStrings: false },
  { boundary: false, table: true, byteTable: true, hotStrings: false },
  { boundary: false, table: true, mixedRuns: true, hotStrings: false },
  { boundary: false, table: true, mixedRuns: true, runCache: true, hotStrings: false },
  { boundary: false, table: true, mixedRuns: true, nativeLatin1: true, hotStrings: false },
  { boundary: false, table: true, mixedRuns: true, portableLatin1: true, hotStrings: false },
  { boundary: false, table: true, mixedRuns: true, fusedValidation: true, hotStrings: false },
  { boundary: false, table: true, mixedRuns: true, fusedValidation: true, leanDispatch: true, hotStrings: false },
  { boundary: false, table: true, mixedRuns: true, fusedValidation: true, memo: true, hotStrings: false },
  { boundary: false, table: false, hotStrings: true },
  { boundary: true, table: true, hotStrings: true },
]) {
  test(`composes exact decode ${JSON.stringify(configuration)}`, () => {
    const composed = createComposedDecoder(coreFixture(), {
      ...configuration,
      tableOptions,
      hotStringOptions,
    });
    assert.equal(composed.decode(Uint32Array.of(0, 1, 0)), "abca");
    assert.equal(composed.decode(Uint32Array.of(2, 3)), "€");
    assert.throws(() => composed.decode(Uint32Array.of(9)), /unknown token id/);
    assert.equal(composed.stats().boundary, configuration.boundary);
    assert.equal(composed.stats().table, configuration.table);
    assert.equal(composed.stats().byteTable, configuration.byteTable === true);
    assert.equal(composed.stats().mixedRuns, configuration.mixedRuns === true);
    assert.equal(composed.stats().runCache, configuration.runCache === true);
    assert.equal(composed.stats().nativeLatin1, configuration.nativeLatin1 === true);
    assert.equal(composed.stats().portableLatin1, configuration.portableLatin1 === true);
    assert.equal(composed.stats().fusedValidation, configuration.fusedValidation === true);
    assert.equal(composed.stats().leanDispatch, configuration.leanDispatch === true);
    assert.equal(composed.stats().memo, configuration.memo === true);
    assert.equal(composed.stats().hotStrings, configuration.hotStrings);
    if (configuration.memo) {
      const ids = [0, 1, 0];
      assert.equal(composed.decode(ids), "abca");
      assert.equal(composed.decode(ids), "abca");
      assert.equal(composed.decode(ids), "abca");
      assert.equal(composed.stats().memoState.hits, 1);
    }
    if (configuration.runCache) {
      const ids = [0, 0, 0, 0, 2, 3, 0, 0, 0, 0];
      assert.equal(composed.decode(ids), `${"a".repeat(4)}\u20ac${"a".repeat(4)}`);
      assert.equal(composed.decode(ids), `${"a".repeat(4)}\u20ac${"a".repeat(4)}`);
      assert.equal(composed.stats().tableState.runCacheState.hits, 1);
    }
    if (configuration.nativeLatin1) {
      assert.equal(composed.stats().tableState.nativeLatin1State.decoderCalls, 1);
    }
    if (configuration.portableLatin1) {
      assert.equal(composed.stats().tableState.portableLatin1State.portableDecoderCalls, 1);
    }
    if (configuration.table) assert.equal(composed.tokenString(0), "a");
  });
}

test("validates the composed core and options", () => {
  assert.throws(() => createComposedDecoder({}), /provide decode, tokenBytes, and vocabSize/);
  assert.throws(() => createComposedDecoder(coreFixture(), []), /options must be an object/);
  assert.throws(
    () => createComposedDecoder(coreFixture(), { assembly: false, boundary: true }),
    /boundary decode requires assembly/,
  );
  assert.throws(
    () => createComposedDecoder(coreFixture(), { table: false, byteTable: true }),
    /byte-table decode requires table/,
  );
  assert.throws(
    () => createComposedDecoder(coreFixture(), { table: false, mixedRuns: true }),
    /mixed-run decode requires table/,
  );
  assert.throws(
    () => createComposedDecoder(coreFixture(), { table: true, runCache: true }),
    /maximal-run cache requires mixed-run decode/,
  );
  assert.throws(
    () => createComposedDecoder(coreFixture(), { nativeLatin1: true }),
    /native Latin-1 decode requires table/,
  );
  assert.throws(
    () => createComposedDecoder(coreFixture(), { portableLatin1: true }),
    /portable Latin-1 decode requires table/,
  );
});

test("routes memo, run cache, Latin-1 arms, and assembly in precedence order", () => {
  const composed = createComposedDecoder(coreFixture(), {
    table: true,
    mixedRuns: true,
    runCache: true,
    nativeLatin1: true,
    portableLatin1: true,
    memo: true,
    tableOptions: {
      ...tableOptions,
      maxMixedDirtyDensity: 0.4,
    },
  });
  const dense = [2, 3, 2, 3];
  assert.equal(composed.decode(dense), "\u20ac\u20ac");
  let stats = composed.stats();
  assert.equal(stats.tableState.nativeLatin1State.decoderCalls, 1);
  assert.equal(stats.tableState.portableLatin1State.portableDecoderCalls, 0);
  assert.equal(stats.assembly.decoderCalls, 0);

  const sparse = [0, 0, 0, 0, 2, 3, 0, 0, 0, 0];
  const expectedSparse = `${"a".repeat(4)}\u20ac${"a".repeat(4)}`;
  assert.equal(composed.decode(sparse), expectedSparse);
  assert.equal(composed.decode(sparse), expectedSparse);
  stats = composed.stats();
  assert.equal(stats.tableState.runCacheState.hits, 1);
  assert.equal(stats.tableState.nativeLatin1State.decoderCalls, 1);
  assert.equal(stats.tableState.portableLatin1State.portableDecoderCalls, 0);
  const tableCallsBeforeMemoHit = stats.tableState.tableCalls;
  assert.equal(composed.decode(sparse), expectedSparse);
  stats = composed.stats();
  assert.equal(stats.memoState.hits, 1);
  assert.equal(stats.tableState.tableCalls, tableCallsBeforeMemoHit);

  const portable = createComposedDecoder(coreFixture(), {
    table: true,
    mixedRuns: true,
    nativeLatin1: true,
    portableLatin1: true,
    tableOptions: {
      ...tableOptions,
      maxMixedDirtyDensity: 0.4,
      nativeLatin1Options: { nativeUnmap: null },
    },
  });
  assert.equal(portable.decode(dense), "\u20ac\u20ac");
  stats = portable.stats();
  assert.equal(stats.tableState.nativeLatin1State.available, false);
  assert.equal(stats.tableState.nativeLatin1State.decoderCalls, 0);
  assert.equal(stats.tableState.portableLatin1State.portableDecoderCalls, 1);
  assert.equal(stats.assembly.decoderCalls, 0);

  const assembly = createComposedDecoder(coreFixture(), {
    table: true,
    mixedRuns: true,
    tableOptions: {
      ...tableOptions,
      maxMixedDirtyDensity: 0.4,
    },
  });
  assert.equal(assembly.decode(dense), "\u20ac\u20ac");
  assert.equal(assembly.stats().assembly.decoderCalls, 1);
});
