# Compatibility shims

The two compatibility entry points preserve encode and decode call sites. They do not preserve
vocabulary acquisition. Hypertok loads vocabulary bytes first, then constructs a shim around the
resident runtime.

Both shims are synchronous and require a resident `single` tier. Worker and shared tiers use the
native asynchronous API. A shim cannot reach either faster tier or silently fall back to one.

## Tiktoken call sites

Import `hypertok/tiktoken` and construct the adapter after loading the matching vocabulary:

```js
import { createTiktokenShim } from "hypertok/tiktoken";

const encoding = createTiktokenShim(runtime, { name: "o200k_base" });
const ids = encoding.encode(text, "all");
const bytes = encoding.decode(ids);
encoding.free();
```

`encode`, `encode_ordinary`, `decode`, `name`, and `free` follow the pinned tiktoken call behavior.
Decode returns exact bytes, including byte sequences that are not valid UTF-8. Vocabulary names,
files, downloads, and model-to-encoding lookup are not compatibility claims.

## Hugging Face call sites

Import `hypertok/huggingface`. Setup must come from the same vocabulary revision as the
loaded bytes:

```js
import { createHuggingFaceShim } from "hypertok/huggingface";

const tokenizer = createHuggingFaceShim(runtime, vocabularySetup);
const encoded = tokenizer.encode(text, {
  text_pair: secondText,
  add_special_tokens: true,
  return_token_type_ids: true,
});
const decoded = tokenizer.decode(encoded.ids, { skip_special_tokens: true });
```

The setup supplies token strings, post-processing over raw sequence ids, special-token strings, the
unknown-token id, and the cleanup default. It does not tokenize text and does not retain a second
tokenizer arena. The shim preserves the pinned encode result shape, pair processing, model markers,
token type ids, special filtering, unknown-id handling, and tokenization-space cleanup.

Tokenizer construction, Hub access, tokenizer JSON parsing, vocabulary inspection, and training APIs
are outside the compatibility contract. A changed import preserves encode and decode call sites only
after the matching hypertok vocabulary and setup metadata have been loaded.

## Overhead and drift

Adapter overhead is measured separately from tokenizer throughput on all six preregistered workloads
by `benches/measure_shim_overhead.mjs`. Every row compares the synchronous resident core with the
matching adapter on the same text, reports n, median, p95, variance, tier, SIMD level, and clock
regime, and checks identical ids before timing is accepted. Hugging Face compatibility includes the
cost of materializing token strings and masks. It is not described as free argument reshaping.

If a target package changes in a way that breaks fidelity, the affected shim is removed until its
contract is restored. A knowingly approximate encode or decode path does not ship.
