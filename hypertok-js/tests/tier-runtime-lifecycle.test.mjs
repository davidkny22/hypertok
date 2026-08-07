import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Worker as NodeWorker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { fromBytes } from "../src/index.mjs";
import { createHuggingFaceShim } from "../src/huggingface-shim.mjs";
import { resolveShimRuntime } from "../src/shim-runtime.mjs";
import { createTiktokenShim } from "../src/tiktoken-shim.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bootstrap = new URL("./fixtures/node-worker-bootstrap.mjs", import.meta.url);
const vocabulary = new Uint8Array(
  await readFile(path.join(root, "hypertok-vocab", "o200k", "vocab.htk")),
);
const gpt2Vocabulary = new Uint8Array(
  await readFile(path.join(root, "hypertok-vocab", "gpt2", "vocab.htk")),
);
const created = [];
let delayedOperations = new Set();

class BrowserWorkerHarness {
  constructor(target) {
    this.dead = false;
    this.listeners = new Map();
    this.inner = new NodeWorker(bootstrap, {
      type: "module",
      workerData: { target: target.href },
    });
    this.inner.on("message", (data) => this.dispatch("message", { data }));
    this.inner.on("error", (error) => this.dispatch("error", error));
    created.push(this);
  }

  addEventListener(type, listener) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  postMessage(value, transfer = []) {
    if (this.dead || delayedOperations.has(value.operation)) return;
    this.inner.postMessage(value, transfer);
  }

  terminate() {
    this.dead = true;
    return this.inner.terminate();
  }

  injectError(message) {
    this.dead = true;
    this.dispatch("error", { message, filename: "lifecycle-test", lineno: 1, colno: 1 });
    void this.inner.terminate();
  }
}

globalThis.Worker = BrowserWorkerHarness;

function setIsolation(isolated) {
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    value: isolated,
    configurable: true,
  });
}

async function openTier(tier, bytes = vocabulary) {
  created.length = 0;
  delayedOperations = new Set();
  setIsolation(tier === "shared");
  const tokenizer = await fromBytes(bytes, { tier, workers: 1 });
  assert.equal(tokenizer.tier, tier);
  assert.equal(created.length, 1);
  return tokenizer;
}

async function withTimeout(promise, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("worker-fault-falls-back-to-single", async () => {
  const tokenizer = await openTier("worker");
  try {
    const expected = await tokenizer.encode("hello");
    created[0].injectError("injected worker fault");
    assert.deepEqual(await withTimeout(tokenizer.encode("hello")), expected);
  } finally {
    tokenizer.free();
  }
});

test("shared-tier-fault-falls-back-to-single", async () => {
  const tokenizer = await openTier("shared");
  try {
    const expected = await tokenizer.encode("hello");
    created[0].injectError("injected shared-controller fault");
    assert.deepEqual(await withTimeout(tokenizer.encode("hello")), expected);
  } finally {
    tokenizer.free();
  }
});

test("public-free-rejects-inflight-worker-and-shared-call", async () => {
  for (const tier of ["worker", "shared"]) {
    const tokenizer = await openTier(tier);
    await tokenizer.encode("hello");
    delayedOperations = new Set([tier === "worker" ? "encodePretokens" : "encode"]);
    const pending = tokenizer.encode("world");
    await Promise.resolve();
    tokenizer.free();
    await assert.rejects(() => withTimeout(pending), /execution worker closed/);
  }
});

test("registered worker and shared handles expose one resident view only to synchronous shims", async () => {
  const text = "resident shim lifecycle";
  for (const tier of ["worker", "shared"]) {
    const tokenizer = await openTier(tier, gpt2Vocabulary);
    const expected = Array.from(await tokenizer.encode(text));
    assert.throws(() => tokenizer.encodeSync(text), new RegExp(`unavailable on the ${tier} tier`));
    const resident = resolveShimRuntime(tokenizer);
    assert.equal(resident.tier, "single");
    assert.equal(resident.lifecycle().singleLoads, 1);
    assert.equal(resident.lifecycle().residentSingleIdentity, 1);

    const tiktoken = createTiktokenShim(tokenizer, { name: "gpt2" });
    assert.deepEqual(Array.from(tiktoken.encode_ordinary(text)), expected);
    assert.equal(new TextDecoder().decode(tiktoken.decode(expected)), text);

    const huggingFace = createHuggingFaceShim(tokenizer, {
      tokenString(id) {
        return Number.isInteger(id) && id >= 0 && id < tokenizer.vocabSize ? String(id) : undefined;
      },
      postProcess(first, second) {
        const ids = second === null ? [...first] : [...first, ...second];
        return { ids, token_type_ids: ids.map(() => 0) };
      },
      specialTokens: [],
      unknownTokenId: 0,
      cleanUpTokenizationSpaces: false,
    });
    const encoded = huggingFace.encode(text, {
      add_special_tokens: false,
      return_token_type_ids: false,
    });
    assert.deepEqual(encoded.ids, expected);
    assert.equal(
      huggingFace.decode(encoded.ids, { clean_up_tokenization_spaces: false }),
      text,
    );

    tiktoken.free();
    await assert.rejects(() => tokenizer.encode("after shim free"), /execution-tier session is closed/);
  }
});

test("worker-and-shared-preserve-the-canonical-FEFF-boundary-at-every-size", async () => {
  const paddings = [0, 50, 200, 2_000, 100_000];
  const single = await fromBytes(gpt2Vocabulary, { tier: "single" });
  try {
    for (const tier of ["worker", "shared"]) {
      const tokenizer = await openTier(tier, gpt2Vocabulary);
      try {
        for (const padding of paddings) {
          const text = `${"x".repeat(padding)}.\n\n\ufeff\ufeffAlso on HuffPost:\n\n${"y".repeat(padding)}`;
          const expected = Array.from(single.encodeSync(text));
          assert.ok(
            expected.some((id, index) => id === 198 && expected[index + 1] === 198),
            `single merged the newline pair before U+FEFF at padding ${padding}`,
          );
          assert.deepEqual(
            Array.from(await withTimeout(tokenizer.encode(text), 5000)),
            expected,
            `${tier} diverged at padding ${padding}`,
          );
        }
      } finally {
        tokenizer.free();
      }
    }
  } finally {
    single.free();
  }
});
