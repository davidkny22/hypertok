# Migrating to hypertok

Hypertok's shims preserve encode and decode call sites. Vocabulary acquisition remains explicit so
the loaded bytes and shim setup always identify the same tokenizer.

The examples use GPT-2 and begin with one shared helper:

```js
import { fromBytes } from "hypertok";
import { loadVocab } from "hypertok/vocab-resolve";

const text = "hello 世界 👋";
async function makeGpt2Runtime() {
  return fromBytes(await loadVocab("gpt2"), { tier: "single" });
}
```

## From js-tiktoken

Replace the encoding object with the tiktoken shim. `encode_ordinary` is the direct path for text
whose special-token policy is handled separately. Decode returns bytes, so convert them to text
only when valid UTF-8 text is the intended result.

```js
import { createTiktokenShim } from "hypertok/tiktoken";

const jsTiktokenEncoding = createTiktokenShim(await makeGpt2Runtime(), { name: "gpt2" });
const jsTiktokenIds = jsTiktokenEncoding.encode_ordinary(text);
const jsTiktokenDecoded = new TextDecoder().decode(jsTiktokenEncoding.decode(jsTiktokenIds));
jsTiktokenEncoding.free();
```

Model-name lookup is not shimmed. Select and load the matching `@hypertok/vocab-*` package
explicitly.

## From gpt-tokenizer

Keep function-shaped call sites with two local adapters around the tiktoken shim:

```js
import { createTiktokenShim } from "hypertok/tiktoken";

const gptTokenizerEncoding = createTiktokenShim(await makeGpt2Runtime(), { name: "gpt2" });
const encode = (value) => gptTokenizerEncoding.encode_ordinary(value);
const decode = (tokens) => new TextDecoder().decode(gptTokenizerEncoding.decode(tokens));
const gptTokenizerIds = encode(text);
const gptTokenizerDecoded = decode(gptTokenizerIds);
gptTokenizerEncoding.free();
```

The adapters preserve ordinary encode and text decode calls. Import-time model selection and
gpt-tokenizer-specific helpers are outside the shim contract.

## From Hugging Face tokenizers

Supply setup derived from the same tokenizer revision as the `.htk` bytes. GPT-2 has no added
post-processing tokens, so its setup can return the first sequence unchanged:

```js
import { createHuggingFaceShim } from "hypertok/huggingface";

const huggingFaceMigrationRuntime = await makeGpt2Runtime();
const tokenDecoder = new TextDecoder();
const huggingFaceMigration = createHuggingFaceShim(huggingFaceMigrationRuntime, {
  tokenString: (id) => tokenDecoder.decode(huggingFaceMigrationRuntime.tokenBytes(id)),
  postProcess: (first) => ({ ids: first }),
  specialTokens: ["<|endoftext|>"],
  unknownTokenId: 50256,
  cleanUpTokenizationSpaces: false,
});
const huggingFaceMigrationEncoding = huggingFaceMigration.encode(text, {
  add_special_tokens: false,
});
const huggingFaceMigrationDecoded = huggingFaceMigration.decode(
  huggingFaceMigrationEncoding.ids,
  { clean_up_tokenization_spaces: false },
);
huggingFaceMigration.free();
```

For a tokenizer with model markers or pair processing, its `postProcess` function must reproduce
that pinned source revision exactly. Hub access, tokenizer JSON parsing, training and vocabulary
inspection are not shimmed.
