import assert from "node:assert/strict";

import { fromBytes } from "hypertok";

const text = "Deno exactness: hello 世界 👋";
const vocab = await Deno.readFile(
  new URL("../../../hypertok-vocab/gpt2/vocab.htk", import.meta.url),
);
const tokenizer = await fromBytes(vocab, { tier: "single" });
const ids = await tokenizer.encode(text);
const decoded = await tokenizer.decode(ids);

assert(ids.length > 0);
assert.equal(decoded, text);
tokenizer.free();

console.log(JSON.stringify({
  deno: Deno.version.deno,
  v8: Deno.version.v8,
  tier: tokenizer.tier,
  ids: Array.from(ids),
  decoded,
}));
