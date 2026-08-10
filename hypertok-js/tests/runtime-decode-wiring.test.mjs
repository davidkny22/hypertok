import assert from "node:assert/strict";
import { test } from "node:test";
import { createTierRuntime } from "../src/tier-runtime.mjs";

const moduleSource = `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const entries = [
  encoder.encode("a"),
  encoder.encode("bc"),
  Uint8Array.of(0xe2),
  Uint8Array.of(0x82, 0xac),
];
export const events = [];
function gather(ids) {
  const pieces = Array.from(ids, (id) => {
    const bytes = entries[id];
    if (!(bytes instanceof Uint8Array)) throw new RangeError("unknown token id " + id);
    return bytes;
  });
  const output = new Uint8Array(pieces.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of pieces) {
    output.set(bytes, offset);
    offset += bytes.length;
  }
  return output;
}
export default async function initialize() {}
export class WasmTokenizer {
  static fromHuggingFace() { return new WasmTokenizer(); }
  decode(ids) { events.push("raw"); return decoder.decode(gather(ids)); }
  decodeAssemblyBytes(ids) { events.push("assembly"); return gather(ids); }
  tokenBytes(id) {
    const bytes = entries[id];
    if (!(bytes instanceof Uint8Array)) throw new RangeError("unknown token id " + id);
    return bytes;
  }
  vocabSize() { return entries.length; }
  reservedNamesJson() { return "[]"; }
  free() { events.push("free"); }
}
`;
const moduleUrl = `data:text/javascript,${encodeURIComponent(moduleSource)}`;
const module = await import(moduleUrl);

async function runtime(optimizations) {
  return createTierRuntime({
    unthreadedModuleUrl: moduleUrl,
    vocabulary: Uint8Array.of(1),
    format: "huggingface",
    tier: "single",
    capabilities: {
      isolated: false,
      sharedArrayBuffer: false,
      worker: false,
    },
    optimizations,
  });
}

test("auto decode reaches table, mixed runs, and the assembly refuge", async () => {
  module.events.length = 0;
  const tokenizer = await runtime();
  assert.equal(tokenizer.decode([0, 1]), "abc");
  assert.deepEqual(module.events, []);
  const sparse = [...Array(10).fill(0), 2, 3, ...Array(10).fill(0)];
  assert.equal(tokenizer.decode(sparse), `${"a".repeat(10)}\u20ac${"a".repeat(10)}`);
  assert.equal(tokenizer.decode(sparse), `${"a".repeat(10)}€${"a".repeat(10)}`);
  assert.deepEqual(module.events, []);
  const oneDirtyRun = [2, 3, 2, 3, ...Array(6).fill(0)];
  assert.equal(tokenizer.decode(oneDirtyRun), `\u20ac\u20ac${"a".repeat(6)}`);
  assert.deepEqual(module.events, []);
  const twoDirtyRuns = [2, 3, 0, 2, 3, ...Array(5).fill(0)];
  assert.equal(tokenizer.decode(twoDirtyRuns), `\u20aca\u20ac${"a".repeat(5)}`);
  assert.deepEqual(module.events, ["assembly"]);
  assert.equal(tokenizer.decode(Uint32Array.of(2, 3)), "€");
  assert.deepEqual(module.events, ["assembly", "assembly"]);
  assert.equal(tokenizer.decode(Uint32Array.of(2)), "�");
  assert.deepEqual(tokenizer.decodeBytes([2]), Uint8Array.of(0xe2));
  assert.equal(tokenizer.decodeStats().assemblyEnabled, true);
  assert.equal(tokenizer.decodeStats().table, true);
  assert.equal(tokenizer.decodeStats().byteTable, false);
  assert.equal(tokenizer.decodeStats().mixedRuns, true);
  assert.equal(tokenizer.decodeStats().runCache, true);
  assert.equal(tokenizer.decodeStats().nativeLatin1, false);
  assert.equal(tokenizer.decodeStats().portableLatin1, false);
  assert.equal(tokenizer.decodeStats().leanDispatch, false);
  assert.equal(tokenizer.decodeStats().memo, true);
  assert.equal(tokenizer.decodeStats().tableState.mixedCalls, 3);
  assert.equal(tokenizer.decodeStats().tableState.mixedRunFallbackCalls, 1);
  assert.ok(tokenizer.decodeStats().tableState.runCacheState.hits > 0);
  assert.equal(tokenizer.decodeStats().tableState.leanDispatchEnabled, false);
  const repeated = [0, 1];
  assert.equal(tokenizer.decode(repeated), "abc");
  assert.equal(tokenizer.decode(repeated), "abc");
  assert.equal(tokenizer.decode(repeated), "abc");
  assert.equal(tokenizer.decodeStats().memoState.hits, 1);
  await tokenizer.close();
});

test("explicit byte-table decode keeps dirty bytes on the JS side", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeByteTable: "on" });
  assert.equal(tokenizer.decode(Uint32Array.of(2, 3)), "€");
  assert.deepEqual(module.events, []);
  assert.equal(tokenizer.decodeStats().byteTable, true);
  assert.equal(tokenizer.decodeStats().tableState.byteTableCalls, 1);
  assert.equal(tokenizer.decodeStats().tableState.byteTableState.decoderCalls, 1);
  await tokenizer.close();
});

test("explicit mixed-run decode stitches sparse dirty bytes without assembly", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeMixedRuns: "on" });
  const ids = [...Array(10).fill(0), 2, 3, ...Array(10).fill(0)];
  assert.equal(tokenizer.decode(ids), `${"a".repeat(10)}€${"a".repeat(10)}`);
  assert.deepEqual(module.events, []);
  assert.equal(tokenizer.decodeStats().mixedRuns, true);
  assert.equal(tokenizer.decodeStats().tableState.mixedCalls, 1);
  assert.equal(tokenizer.decodeStats().tableState.byteTableState.runDecoderCalls, 1);
  await tokenizer.close();
});

test("explicit maximal-run cache reuses only the complete dirty run", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeMemo: "off", decodeRunCache: "on" });
  const ids = [...Array(10).fill(0), 2, 3, ...Array(10).fill(0)];
  const expected = `${"a".repeat(10)}\u20ac${"a".repeat(10)}`;
  assert.equal(tokenizer.decode(ids), expected);
  assert.equal(tokenizer.decode(ids), expected);
  assert.deepEqual(module.events, []);
  assert.equal(tokenizer.decodeStats().runCache, true);
  assert.equal(tokenizer.decodeStats().tableState.runCacheState.hits, 1);
  assert.equal(tokenizer.decodeStats().tableState.runCacheState.misses, 1);

  ids[11] = 2;
  assert.equal(tokenizer.decode(ids), `${"a".repeat(10)}\ufffd\ufffd${"a".repeat(10)}`);
  assert.equal(tokenizer.decodeStats().tableState.runCacheState.misses, 2);
  await tokenizer.close();

  const refuge = await runtime({ decodeMemo: "off", decodeRunCache: "off" });
  assert.equal(refuge.decode([0, 2, 3, 0]), "a\u20aca");
  assert.equal(refuge.decodeStats().runCache, false);
  assert.equal(refuge.decodeStats().tableState.runCacheState, null);
  await refuge.close();
});

test("explicit native Latin-1 decode routes dirty-dense bytes without assembly", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeMemo: "off", decodeLatin1Native: "on" });
  assert.equal(tokenizer.decode([2, 3]), "\u20ac");
  assert.equal(tokenizer.decode([2]), "\ufffd");
  assert.deepEqual(module.events, []);
  assert.equal(tokenizer.decodeStats().nativeLatin1, true);
  assert.equal(tokenizer.decodeStats().tableState.nativeLatin1State.available, true);
  assert.equal(tokenizer.decodeStats().tableState.nativeLatin1State.decoderCalls, 2);
  await tokenizer.close();
});

test("explicit portable Latin-1 decode routes dirty-dense bytes without assembly", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeMemo: "off", decodeLatin1Portable: "on" });
  assert.equal(tokenizer.decode([2, 3]), "\u20ac");
  assert.equal(tokenizer.decode([2]), "\ufffd");
  assert.deepEqual(module.events, []);
  assert.equal(tokenizer.decodeStats().portableLatin1, true);
  assert.equal(tokenizer.decodeStats().tableState.portableLatin1State.portableDecoderCalls, 2);
  await tokenizer.close();
});

test("explicit fused validation reaches assembly with one natural-array conversion", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeFusedValidation: "on" });
  assert.equal(tokenizer.decode([2, 3]), "\u20ac");
  assert.deepEqual(module.events, ["assembly"]);
  assert.equal(tokenizer.decodeStats().fusedValidation, true);
  assert.equal(tokenizer.decodeStats().tableState.fusedValidationEnabled, true);
  await tokenizer.close();
});

test("explicit lean dispatch preserves stats and closed-session refusal", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeLeanDispatch: "on" });
  assert.equal(tokenizer.decode([0, 1]), "abc");
  assert.equal(tokenizer.decodeStats().leanDispatch, true);
  assert.equal(tokenizer.decodeStats().tableState.leanDispatchEnabled, true);
  assert.equal(tokenizer.decodeStats().tableState.tableCalls, 1);
  await tokenizer.close();
  assert.throws(() => tokenizer.decode([0]), /execution-tier session is closed/);
});

test("explicit direct scratch reaches assembly without changing typed input routing", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeMemo: "off", decodeDirectScratch: "on" });
  const dense = [2, 3, 2, 3];
  assert.equal(tokenizer.decode(dense), "€€");
  assert.deepEqual(module.events, ["assembly"]);
  const beforeTyped = tokenizer.decodeStats().tableState.directScratchCalls;
  assert.equal(tokenizer.decode(Uint32Array.from(dense)), "€€");
  assert.equal(tokenizer.decodeStats().tableState.directScratchCalls, beforeTyped);
  assert.equal(tokenizer.decodeStats().directScratch, true);
  await tokenizer.close();
});

test("explicit memo verifies content and preserves a reachable cache-off refuge", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeMemo: "on" });
  const ids = [0, 1, 0];
  assert.equal(tokenizer.decode(ids), "abca");
  assert.equal(tokenizer.decode(ids), "abca");
  assert.equal(tokenizer.decode(ids), "abca");
  assert.equal(tokenizer.decodeStats().memo, true);
  assert.equal(tokenizer.decodeStats().memoState.hits, 1);
  ids[1] = 0;
  assert.equal(tokenizer.decode(ids), "aaa");
  assert.equal(tokenizer.decodeStats().memoState.mismatches, 1);
  await tokenizer.close();

  const refuge = await runtime({ decodeMemo: "off" });
  const refugeIds = [0, 1, 0];
  assert.equal(refuge.decode(refugeIds), "abca");
  assert.equal(refuge.decode(refugeIds), "abca");
  assert.equal(refuge.decodeStats().memo, false);
  assert.equal(refuge.decodeStats().memoState, null);
  await refuge.close();
});

test("decodeTable off reaches assembly without the table", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeTable: "off" });
  assert.equal(tokenizer.decode([0, 1]), "abc");
  assert.deepEqual(module.events, ["assembly"]);
  assert.equal(tokenizer.decodeStats().assemblyEnabled, true);
  assert.equal(tokenizer.decodeStats().table, false);
  await tokenizer.close();
});

test("decodeAssembly off reaches the raw refuge", async () => {
  module.events.length = 0;
  const tokenizer = await runtime({ decodeAssembly: "off" });
  assert.equal(tokenizer.decode([0, 1]), "abc");
  assert.deepEqual(module.events, ["raw"]);
  assert.equal(tokenizer.decodeStats().assemblyEnabled, false);
  assert.equal(tokenizer.decodeStats().table, false);
  await tokenizer.close();
});
