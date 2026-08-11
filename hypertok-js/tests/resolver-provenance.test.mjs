import assert from "node:assert/strict";
import test from "node:test";

import {
  createResolvedVocabLoader,
  resolverOwnedBytes,
  resolverOwnedWorkerImage,
} from "../src/resolver-provenance.mjs";
import { fromResolvedVocab } from "../src/resolver-runtime.mjs";

test("only resolver-minted handles reach trusted construction", async () => {
  const source = new Uint8Array(64);
  const view = new DataView(source.buffer);
  view.setUint16(8, 1, true);
  view.setUint8(10, 0);
  view.setUint32(16, 50_257, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 64, true);
  const handle = await createResolvedVocabLoader(async () => source)("gpt2");
  assert.equal(Object.isFrozen(handle), true);
  assert.deepEqual([...Object.keys(handle)], []);
  assert.strictEqual(resolverOwnedBytes(handle), source);
  assert.throws(
    () => resolverOwnedBytes(source),
    /requires a resolver-owned vocabulary handle/u,
  );
  assert.throws(
    () => resolverOwnedBytes(Object.freeze(Object.create(null))),
    /requires a resolver-owned vocabulary handle/u,
  );

  let received;
  let closed = false;
  const runtime = {
    tier: "single",
    optimizations: () => ({ decode: { leanDispatch: false } }),
    encode: async () => new Uint32Array([1]),
    encodeSync: () => new Uint32Array([1]),
    encodeInto: async () => 1,
    encodeDetailed: async () => ({ ids: new Uint32Array([1]) }),
    decode: () => "probe",
    tokenBytes: () => new Uint8Array([1]),
    close: async () => {
      closed = true;
    },
  };
  const publicRuntime = await fromResolvedVocab(handle, {
    wasmModule: {},
    runtimeFactory: async (options) => {
      received = options;
      return runtime;
    },
  });
  assert.equal(publicRuntime.tier, "single");
  assert.equal(publicRuntime.vocabSize, 50_257);
  assert.strictEqual(received.vocabulary, source);
  assert.equal(received.resolverTrusted, true);
  assert.equal(received.resolverWarmup, false);
  publicRuntime.free();
  await Promise.resolve();
  assert.equal(closed, true);
});

test("resolver warmup reaches only the trusted construction route", async () => {
  const source = new Uint8Array(64);
  const view = new DataView(source.buffer);
  view.setUint16(8, 1, true);
  view.setUint8(10, 0);
  view.setUint32(16, 50_257, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 64, true);
  const handle = await createResolvedVocabLoader(async () => source)("gpt2");
  let received;
  const runtime = {
    tier: "single",
    optimizations: () => ({ decode: { leanDispatch: false } }),
    encode: async () => new Uint32Array([1]),
    encodeSync: () => new Uint32Array([1]),
    encodeInto: async () => 1,
    encodeDetailed: async () => ({ ids: new Uint32Array([1]) }),
    decode: () => "probe",
    tokenBytes: () => new Uint8Array([1]),
    close: async () => {},
  };
  const publicRuntime = await fromResolvedVocab(handle, {
    wasmModule: {},
    warmup: true,
    runtimeFactory: async (options) => {
      received = options;
      return runtime;
    },
  });
  assert.equal(received.resolverTrusted, true);
  assert.equal(received.resolverWarmup, true);
  assert.equal(publicRuntime.encodeSync("probe")[0], 1);
  publicRuntime.free();
});

test("ordinary bytes cannot select the trusted constructor", async () => {
  let calls = 0;
  const wasmModule = {
    async default() {},
    WasmTokenizer: {
      fromResolverTrustedHtk() {
        calls += 1;
      },
    },
  };
  await assert.rejects(
    fromResolvedVocab(new Uint8Array([1, 2, 3]), { wasmModule }),
    /requires a resolver-owned vocabulary handle/u,
  );
  assert.equal(calls, 0);
});

test("worker transfer bytes come from the resolver-owned built-state section", async () => {
  const bytes = new Uint8Array(176);
  const view = new DataView(bytes.buffer);
  view.setUint32(24, 1, true);
  view.setUint32(28, 64, true);
  view.setUint32(64, 1026, true);
  view.setUint32(68, 96, true);
  view.setBigUint64(72, 80n, true);
  view.setUint32(116, 4, true);
  view.setUint32(120, 3, true);
  bytes.set([7, 8, 9], 164);
  const handle = await createResolvedVocabLoader(async () => bytes)("gpt2");
  assert.deepEqual([...resolverOwnedWorkerImage(handle)], [7, 8, 9]);
  assert.throws(
    () => resolverOwnedWorkerImage(Object.freeze(Object.create(null))),
    /requires a resolver-owned vocabulary handle/u,
  );
});
