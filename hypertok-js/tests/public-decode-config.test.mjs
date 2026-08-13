import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fromBytes } from "../src/index.mjs";
import { resolveShimRuntime } from "../src/shim-runtime.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vocabulary = fs.readFileSync(
  path.join(packageRoot, "..", "hypertok-vocab", "o200k", "vocab.htk"),
);

async function loaded(optimizations) {
  const handle = await fromBytes(vocabulary, { tier: "single", optimizations });
  return { handle, runtime: resolveShimRuntime(handle) };
}

function dirtyFixture(handle) {
  const fatal = new TextDecoder("utf-8", { fatal: true });
  const dirty = [];
  for (let id = 0; id < handle.vocabSize && dirty.length < 8; id += 1) {
    try {
      fatal.decode(handle.tokenBytes(id));
    } catch (error) {
      if (error instanceof TypeError) dirty.push(id);
    }
  }
  assert.equal(dirty.length, 8);
  const ids = Array.from({ length: 128 }, (_, index) => dirty[index % dirty.length]);
  const pieces = ids.map((id) => handle.tokenBytes(id));
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.length;
  }
  return {
    ids,
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
  };
}

function singleByteIds(handle, values) {
  const wanted = new Set(values);
  const ids = new Map();
  for (let id = 0; id < handle.vocabSize && ids.size < wanted.size; id += 1) {
    const bytes = handle.tokenBytes(id);
    if (bytes.length === 1 && wanted.has(bytes[0])) ids.set(bytes[0], id);
  }
  assert.equal(ids.size, wanted.size);
  return ids;
}

test("public automatic decode reaches the routed table and sparse mixed path", async () => {
  const { handle, runtime } = await loaded();
  try {
    const ids = handle.encodeSync("hello world");
    assert.equal(handle.decode(Array.from(ids)), "hello world");
    const mixedText = `${"ordinary ASCII text ".repeat(200)}🧪${" ordinary ASCII text".repeat(200)}`;
    assert.equal(handle.decode(Array.from(handle.encodeSync(mixedText))), mixedText);
    assert.equal(handle.decode(Array.from(handle.encodeSync(mixedText))), mixedText);
    const stats = runtime.decodeStats();
    assert.equal(stats.assemblyEnabled, true);
    assert.equal(stats.borrowedOutput, true);
    assert.equal(stats.table, true);
    assert.equal(stats.mixedRuns, true);
    assert.equal(stats.runCache, true);
    assert.equal(stats.nativeLatin1, false);
    assert.equal(stats.portableLatin1, false);
    assert.equal(stats.fusedValidation, true);
    assert.equal(stats.directScratch, true);
    assert.equal(stats.leanDispatch, false);
    assert.equal(stats.memo, true);
    assert.equal(stats.runStitcher, true);
    assert.ok(stats.tableState.tableCalls > 0);
    assert.ok(stats.tableState.mixedCalls > 0);
    assert.ok(stats.tableState.byteTableState.runDecoderCalls > 0);
    assert.ok(stats.tableState.runCacheState.hits > 0);
    assert.equal(stats.tableState.leanDispatchEnabled, false);
    assert.equal(stats.assembly.decoderCalls, 0);
  } finally {
    handle.free();
  }
});

test("public explicit maximal-run cache preserves mutation and an off refuge", async () => {
  const { handle, runtime } = await loaded({ decodeMemo: "off", decodeRunCache: "on" });
  try {
    const text = `${"ordinary ASCII text ".repeat(200)}\ud83e\uddea${" ordinary ASCII text".repeat(200)}`;
    const ids = Array.from(handle.encodeSync(text));
    assert.equal(handle.decode(ids), text);
    assert.equal(handle.decode(ids), text);
    assert.equal(runtime.decodeStats().runCache, true);
    assert.ok(runtime.decodeStats().tableState.runCacheState.hits > 0);
    assert.ok(runtime.decodeStats().tableState.runCacheState.entries <= 8);
  } finally {
    handle.free();
  }

  const refuge = await loaded({ decodeMemo: "off", decodeRunCache: "off" });
  try {
    const text = `prefix \ud83e\uddea suffix`;
    assert.equal(refuge.handle.decode(Array.from(refuge.handle.encodeSync(text))), text);
    assert.equal(refuge.runtime.decodeStats().runCache, false);
    assert.equal(refuge.runtime.decodeStats().tableState.runCacheState, null);
  } finally {
    refuge.handle.free();
  }
});

test("public explicit native Latin-1 decode reaches the packaged dirty path", async () => {
  const { handle, runtime } = await loaded({
    decodeMemo: "off",
    decodeLatin1Native: "on",
    decodeDirectScratch: "off",
    decodeRunStitcher: "off",
  });
  try {
    const fixture = dirtyFixture(handle);
    assert.equal(handle.decode(fixture.ids), fixture.text);
    const stats = runtime.decodeStats();
    assert.equal(stats.nativeLatin1, true);
    assert.equal(stats.tableState.nativeLatin1State.available, true);
    assert.ok(stats.tableState.nativeLatin1State.decoderCalls > 0);
    assert.equal(stats.assembly.decoderCalls, 0);
  } finally {
    handle.free();
  }
});

test("public explicit portable Latin-1 decode reaches the packaged dirty path", async () => {
  const { handle, runtime } = await loaded({
    decodeMemo: "off",
    decodeLatin1Portable: "on",
    decodeDirectScratch: "off",
    decodeRunStitcher: "off",
  });
  try {
    const fixture = dirtyFixture(handle);
    assert.equal(handle.decode(fixture.ids), fixture.text);
    const stats = runtime.decodeStats();
    assert.equal(stats.portableLatin1, true);
    assert.ok(stats.tableState.portableLatin1State.portableDecoderCalls > 0);
    assert.equal(stats.assembly.decoderCalls, 0);
  } finally {
    handle.free();
  }
});

test("public decodeTable off reaches assembly without the table", async () => {
  const { handle, runtime } = await loaded({ decodeTable: "off" });
  try {
    const ids = handle.encodeSync("hello world");
    assert.equal(handle.decode(Array.from(ids)), "hello world");
    const stats = runtime.decodeStats();
    assert.equal(stats.assemblyEnabled, true);
    assert.equal(stats.table, false);
    assert.equal(stats.tableState, null);
  } finally {
    handle.free();
  }
});

test("public decodeAssembly off reaches the raw refuge", async () => {
  const { handle, runtime } = await loaded({ decodeAssembly: "off" });
  try {
    const ids = handle.encodeSync("hello world");
    assert.equal(handle.decode(Array.from(ids)), "hello world");
    const stats = runtime.decodeStats();
    assert.equal(stats.assemblyEnabled, false);
    assert.equal(stats.table, false);
  } finally {
    handle.free();
  }
});

test("public explicit byte-table decode routes dirty ids without assembly", async () => {
  const { handle, runtime } = await loaded({ decodeByteTable: "on" });
  try {
    const text = "中文路由测试 😀🧪";
    const ids = Array.from(handle.encodeSync(text));
    assert.equal(handle.decode(ids), text);
    const stats = runtime.decodeStats();
    assert.equal(stats.byteTable, true);
    assert.ok(stats.tableState.byteTableCalls > 0);
    assert.ok(stats.tableState.byteTableState.decoderCalls > 0);
    assert.equal(stats.assembly.decoderCalls, 0);
  } finally {
    handle.free();
  }
});

test("public explicit mixed-run decode stitches a sparse dirty segment", async () => {
  const { handle, runtime } = await loaded({ decodeMixedRuns: "on" });
  try {
    const text = `${"ordinary ASCII text ".repeat(200)}🧪${" ordinary ASCII text".repeat(200)}`;
    const ids = Array.from(handle.encodeSync(text));
    assert.equal(handle.decode(ids), text);
    const stats = runtime.decodeStats();
    assert.equal(stats.mixedRuns, true);
    assert.ok(stats.tableState.mixedCalls > 0);
    assert.ok(stats.tableState.byteTableState.runDecoderCalls > 0);
    assert.equal(stats.assembly.decoderCalls, 0);
  } finally {
    handle.free();
  }
});

test("public explicit fused validation reaches a dirty assembly fallback", async () => {
  const { handle, runtime } = await loaded({
    decodeFusedValidation: "on",
    decodeBorrowedOutput: "off",
    decodeRunStitcher: "off",
  });
  try {
    const fatal = new TextDecoder("utf-8", { fatal: true });
    const dirty = [];
    for (let id = 0; id < handle.vocabSize && dirty.length < 8; id += 1) {
      try {
        const bytes = handle.tokenBytes(id);
        fatal.decode(bytes);
      } catch (error) {
        if (error instanceof TypeError) dirty.push(id);
      }
    }
    assert.equal(dirty.length, 8);
    const ids = Array.from({ length: 128 }, (_, index) => dirty[index % dirty.length]);
    const pieces = ids.map((id) => handle.tokenBytes(id));
    const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) {
      bytes.set(piece, offset);
      offset += piece.length;
    }
    assert.equal(handle.decode(ids), new TextDecoder().decode(bytes));
    const stats = runtime.decodeStats();
    assert.equal(stats.fusedValidation, true);
    assert.equal(stats.tableState.fusedValidationEnabled, true);
    assert.ok(stats.assembly.decoderCalls > 0);
  } finally {
    handle.free();
  }
});

test("public explicit lean dispatch preserves decode stats and free semantics", async () => {
  const { handle, runtime } = await loaded({ decodeLeanDispatch: "on" });
  const ids = Array.from(handle.encodeSync("hello world"));
  assert.equal(handle.decode(ids), "hello world");
  assert.equal(runtime.decodeStats().leanDispatch, true);
  assert.equal(runtime.decodeStats().tableState.leanDispatchEnabled, true);
  assert.equal(runtime.decodeStats().tableState.tableCalls, 1);
  handle.free();
  assert.throws(() => handle.decode(ids), /execution-tier session is closed/);
});

test("public borrowed output decodes the packaged wasm view synchronously", async () => {
  const { handle, runtime } = await loaded({
    decodeMemo: "off",
    decodeBorrowedOutput: "on",
    decodeRunStitcher: "off",
  });
  try {
    const fixture = dirtyFixture(handle);
    assert.equal(handle.decode(fixture.ids), fixture.text);
    const expandedIds = Array.from(
      { length: fixture.ids.length * 64 },
      (_, index) => fixture.ids[index % fixture.ids.length],
    );
    assert.equal(handle.decode(expandedIds), fixture.text.repeat(64));
    assert.equal(handle.decode(fixture.ids), fixture.text);
    const stats = runtime.decodeStats();
    assert.equal(stats.borrowedOutput, true);
    assert.ok(stats.assembly.borrowedViewCalls >= 3);
    assert.equal(typeof handle.decode(fixture.ids), "string");
  } finally {
    handle.free();
  }
});

test("public UTF-16 output preserves exact dense decode through the packaged wasm", async () => {
  const { handle, runtime } = await loaded({
    decodeMemo: "off",
    decodeUtf16Output: "on",
    decodeBorrowedOutput: "off",
    decodeRunStitcher: "off",
  });
  try {
    const fixture = dirtyFixture(handle);
    assert.equal(handle.decode(fixture.ids), fixture.text);
    const expandedIds = Array.from(
      { length: fixture.ids.length * 64 },
      (_, index) => fixture.ids[index % fixture.ids.length],
    );
    assert.equal(handle.decode(expandedIds), fixture.text.repeat(64));
    const byteIds = singleByteIds(handle, [0x28, 0x80, 0x82, 0xac, 0xc3, 0xe2, 0xef, 0xbb, 0xbf, 0xf0, 0xff]);
    for (const bytes of [
      [0xc3],
      [0xe2, 0x82],
      [0xf0, 0x80],
      [0xff],
      [0xc3, 0x28],
      [0xe2, 0x82, 0xac],
    ]) {
      const ids = bytes.map((value) => byteIds.get(value));
      assert.equal(handle.decode(ids), new TextDecoder().decode(Uint8Array.from(bytes)));
    }
    assert.equal(
      handle.decode([byteIds.get(0xef), byteIds.get(0xbb), byteIds.get(0xbf), byteIds.get(0x28)]),
      "\ufeff(",
    );
    assert.equal(typeof handle.decode(fixture.ids), "string");
    const stats = runtime.decodeStats();
    assert.equal(stats.utf16Output, true);
    assert.ok(stats.assembly.utf16Calls >= 3);
  } finally {
    handle.free();
  }
});

test("public direct scratch routes high-dirty arrays through reusable validated IDs", async () => {
  const { handle, runtime } = await loaded({
    decodeMemo: "off",
    decodeDirectScratch: "on",
    decodeBorrowedOutput: "off",
    decodeRunStitcher: "off",
  });
  try {
    const fixture = dirtyFixture(handle);
    assert.equal(handle.decode(fixture.ids), fixture.text);
    assert.equal(handle.decode(Array.from(fixture.ids)), fixture.text);
    const stats = runtime.decodeStats();
    assert.equal(stats.directScratch, true);
    assert.equal(stats.tableState.directScratchEnabled, true);
    assert.equal(stats.tableState.directScratchCalls, 2);
    assert.equal(stats.tableState.directScratchState.preparations, 2);
  } finally {
    handle.free();
  }
});

test("public automatic dirty-run batching preserves an explicit off refuge", async () => {
  const automatic = await loaded({ decodeMemo: "off" });
  const refuge = await loaded({ decodeMemo: "off", decodeDirtyRunBatch: "off" });
  try {
    const byteIds = singleByteIds(automatic.handle, [0x41, 0x82, 0xa9, 0xac, 0xc3, 0xe2]);
    const clean = Array.from({ length: 10 }, () => byteIds.get(0x41));
    const ids = [
      byteIds.get(0xc3),
      byteIds.get(0xa9),
      ...clean,
      byteIds.get(0xe2),
      byteIds.get(0x82),
      byteIds.get(0xac),
      ...clean,
    ];
    const expected = `\u00e9${"A".repeat(10)}\u20ac${"A".repeat(10)}`;
    assert.equal(automatic.handle.decode(Uint32Array.from(ids)), expected);
    assert.equal(refuge.handle.decode(Uint32Array.from(ids)), expected);
    const automaticStats = automatic.runtime.decodeStats();
    const refugeStats = refuge.runtime.decodeStats();
    assert.equal(automaticStats.dirtyRunBatch, true);
    assert.equal(automaticStats.tableState.dirtyRunBatchEnabled, true);
    assert.equal(automaticStats.tableState.dirtyBatchCalls, 1);
    assert.equal(refugeStats.dirtyRunBatch, false);
    assert.equal(refugeStats.tableState.dirtyRunBatchEnabled, false);
    assert.equal(refugeStats.tableState.dirtyBatchCalls, 0);
  } finally {
    automatic.handle.free();
    refuge.handle.free();
  }
});

test("public automatic run stitcher preserves an explicit off refuge", async () => {
  const stitched = await loaded({ decodeMemo: "off" });
  const refuge = await loaded({ decodeMemo: "off", decodeRunStitcher: "off" });
  try {
    const byteIds = singleByteIds(stitched.handle, [0x41, 0x82, 0xa9, 0xac, 0xc3, 0xe2]);
    const ids = Uint32Array.from([
      byteIds.get(0xc3),
      byteIds.get(0xa9),
      ...Array.from({ length: 10 }, () => byteIds.get(0x41)),
      byteIds.get(0xe2),
      byteIds.get(0x82),
      byteIds.get(0xac),
    ]);
    const expected = `\u00e9${"A".repeat(10)}\u20ac`;
    assert.equal(stitched.handle.decode(ids), expected);
    assert.equal(refuge.handle.decode(ids), expected);
    const stitchedStats = stitched.runtime.decodeStats();
    const refugeStats = refuge.runtime.decodeStats();
    assert.equal(stitchedStats.runStitcher, true);
    assert.equal(stitchedStats.tableState.runStitcherEnabled, true);
    assert.equal(stitchedStats.tableState.runStitcherCalls, 1);
    assert.equal(stitchedStats.tableState.dirtyBatchCalls, 1);
    assert.equal(stitchedStats.assembly.decoderCalls, 0);
    assert.equal(refugeStats.runStitcher, false);
    assert.equal(refugeStats.tableState.runStitcherEnabled, false);
    assert.equal(refugeStats.tableState.runStitcherCalls, 0);
  } finally {
    stitched.handle.free();
    refuge.handle.free();
  }
});

test("public clean unroll reaches the packed table", async () => {
  const { handle, runtime } = await loaded({ decodeMemo: "off", decodeCleanUnroll: "on" });
  try {
    const ids = Array.from(handle.encodeSync("hello world hello world"));
    assert.equal(handle.decode(ids), "hello world hello world");
    const stats = runtime.decodeStats();
    assert.equal(stats.cleanUnroll, true);
    assert.equal(stats.tableState.cleanUnrollEnabled, true);
    assert.equal(stats.tableState.tableCalls, 1);
  } finally {
    handle.free();
  }
});

test("public explicit memo verifies repeated container content", async () => {
  const { handle, runtime } = await loaded({ decodeMemo: "on" });
  try {
    const ids = Array.from(handle.encodeSync("hello world"));
    assert.equal(handle.decode(ids), "hello world");
    assert.equal(handle.decode(ids), "hello world");
    assert.equal(handle.decode(ids), "hello world");
    assert.equal(runtime.decodeStats().memo, true);
    assert.equal(runtime.decodeStats().memoState.hits, 1);

    const replacement = Array.from(handle.encodeSync("hello there"));
    ids.splice(0, ids.length, ...replacement);
    assert.equal(handle.decode(ids), "hello there");
    assert.equal(runtime.decodeStats().memoState.mismatches, 1);
  } finally {
    handle.free();
  }
});

test("public automatic memo bypasses a repeated container set above its capacity", async () => {
  const { handle, runtime } = await loaded();
  try {
    const seed = handle.encodeSync("a");
    assert.equal(handle.decode(seed), "a");
    assert.equal(handle.decode(seed), "a");
    assert.equal(handle.decode(seed), "a");
    for (let index = 0; index < 512; index += 1) {
      assert.equal(handle.decode(seed.slice()), "a");
    }
    const stats = runtime.decodeStats().memoState;
    assert.equal(stats.capacityBypassed, true);
    assert.equal(stats.observedContainers, 513);
    assert.equal(stats.entries, 0);
  } finally {
    handle.free();
  }
});
