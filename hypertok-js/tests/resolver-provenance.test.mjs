import assert from "node:assert/strict";
import test from "node:test";

import {
  createResolvedVocabLoader,
  resolverOwnedBytes,
  resolverOwnedWorkerImage,
} from "../src/resolver-provenance.mjs";
import { fromResolvedVocab } from "../src/resolver-runtime.mjs";

test("only resolver-minted handles reach trusted construction", async () => {
  const source = new Uint8Array([1, 2, 3]);
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
  const tokenizer = { free() {} };
  const wasmModule = {
    async default() {},
    WasmTokenizer: {
      fromResolverTrustedHtk(bytes) {
        received = bytes;
        return tokenizer;
      },
    },
  };
  assert.strictEqual(await fromResolvedVocab(handle, { wasmModule }), tokenizer);
  assert.strictEqual(received, source);
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
