import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fromBytes } from "../src/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const probes = [
  "",
  "Hello, world! This isn't a drill.\n",
  "  leading and trailing whitespace  ",
  "digits at cl100k boundaries: 1 12 123 1234 1234567",
  "中文 café Ελληνικά العربية हिन्दी",
  "emoji: 🙂🚀👩🏽‍💻 and punctuation—exactly!",
  "line one\r\nline two\tNUL:\u0000:end",
];

async function assertPackagedRoundTrip(name, file = "vocab.htk") {
  const bytes = await readFile(path.join(root, "hypertok-vocab", name, file));
  const tokenizer = await fromBytes(bytes, { tier: "single" });
  try {
    for (const input of probes) {
      const ids = tokenizer.encodeSync(input);
      assert.deepEqual(await tokenizer.encode(input), ids, `${name}: sync/async encode`);
      assert.equal(tokenizer.decode(ids), input, `${name}: encode/decode identity for ${JSON.stringify(input)}`);
    }
  } finally {
    tokenizer.free();
  }
}

test("cl100k-family packages round-trip multilingual and boundary probes through fromBytes", async () => {
  await assertPackagedRoundTrip("cl100k");
  await assertPackagedRoundTrip("llama3");
});

test("the six previously shipped vocabularies retain packaged fromBytes round trips", async () => {
  for (const name of ["o200k", "qwen3-6", "mistral-tekken", "deepseek-v4", "kimi-k3", "gpt2"]) {
    await assertPackagedRoundTrip(name);
  }
});

test("the p50k package exposes round-tripping base and edit vocabularies", async () => {
  await assertPackagedRoundTrip("p50k");
  await assertPackagedRoundTrip("p50k", "p50k-edit.htk");
});

test("the Gemma 4 package round-trips through the public SentencePiece runtime", async () => {
  await assertPackagedRoundTrip("gemma4");
});

test("the GLM-5.2 package round-trips through the public byte-BPE runtime", async () => {
  await assertPackagedRoundTrip("glm5-2");
});

test("the MiniMax M3 package round-trips through the public byte-BPE runtime", async () => {
  await assertPackagedRoundTrip("minimax-m3");
});

test("the Nemotron 3 package round-trips through the public byte-BPE runtime", async () => {
  await assertPackagedRoundTrip("nemotron3");
});

test("the Command A+ package round-trips through the public byte-BPE runtime", async () => {
  await assertPackagedRoundTrip("command-a-plus");
});
