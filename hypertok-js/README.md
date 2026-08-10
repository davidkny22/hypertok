# hypertok

**The fastest tokenization on the web.** Exact token ids for every major vocabulary, in the
browser and in Node, measured on your machine, not ours.

<p align="center">
  <a href="https://www.npmjs.com/package/hypertok"><img src="https://img.shields.io/npm/v/hypertok.svg" alt="npm"></a>
  <a href="https://github.com/davidkny22/hypertok/actions"><img src="https://github.com/davidkny22/hypertok/actions/workflows/release-artifact.yml/badge.svg" alt="CI"></a>
</p>

| Workload | hypertok, MB/s | Fastest incumbent, MB/s | Speedup | vs js-tiktoken | vs HF tokenizers |
|---|---:|---|---:|---:|---:|
| English prose | 159 | gpt-tokenizer, 25.5 | 6.2x | 76x | 94x |
| Chinese | 122 | kitoken, 11.1 | 11.0x | 160x | 117x |
| Source code | 205 | goliapkg/tiktoken-wasm, 18.9 | 10.8x | 139x | 176x |
| Emoji-heavy | 151 | goliapkg/tiktoken-wasm, 17.2 | 8.8x | 193x | 67x |
| Long document | 185 | goliapkg/tiktoken-wasm, 22.0 | 8.4x | 100x | 129x |
| Standard text | 205 | goliapkg/tiktoken-wasm, 21.8 | 9.4x | 128x | 216x |
| OpenWebText, 50 MB | 168 | gpt-tokenizer, 3.9 | 42.9x | 79x | 191x |

Isolated Chrome in a Linux container (EPYC 9V74), single thread, encode, GPT-2 vocabulary,
n=5 to 11 per row and n=3 on the 50 MB corpus. Every incumbent runs at its documented fastest
configuration, and token-id agreement is verified against each vocabulary's pinned reference implementation
before any ratio is accepted. Nothing is averaged into one headline score.

At these rates the browser counts a hundred-kilobyte conversation in about a millisecond.

[Try it in your browser](https://davidkny22.github.io/hypertok/) and watch the same race run live on your own
hardware, or clone this repository and run the full harness yourself with
`npm run benchmark` in [`benches/`](https://github.com/davidkny22/hypertok/tree/main/benches).


## Install

```bash
npm install hypertok @hypertok/vocab-o200k
```

The runtime package carries its WebAssembly artifacts. Vocabulary packages carry data and source
license notices only, with no dependency on the core package or its repository state.

## Use

```js
import { fromBytes } from "hypertok";
import { vocabulary } from "@hypertok/vocab-o200k";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
const tokenizer = await fromBytes(bytes);

const detailed = await tokenizer.encodeDetailed("hello world");
console.log(detailed.ids);
console.log(detailed.starts);
console.log(tokenizer.decode(detailed.ids));

tokenizer.free();
```

`fromBytes` accepts a `Uint8Array` or `ArrayBuffer` from any source. It validates the complete HTK
image (hypertok's vocabulary format) before constructing a tokenizer. Unknown format versions, structural classes, sections,
flags, index schemes, or behavior are refused explicitly.

The release gate exercises this public path in Node, Chromium, Deno, Bun, Cloudflare Workers, and
Vercel Edge.

## Core API

```ts
const tokenizer = await fromBytes(bytes, {
  tier: "single" | "worker" | "shared",
  workers: 4,
  moduleSource,
});

await tokenizer.encode(text, { reserved });
tokenizer.encodeSync(text, { reserved });
await tokenizer.encodeDetailed(text, { reserved });
tokenizer.decode(ids);
tokenizer.tokenBytes(id);
tokenizer.free();
```

`reserved` controls how reserved tokens in the input are handled: matched, refused, or encoded
literally, per call.

The handle also exposes:

- `vocabSize`
- `structuralClass`, either `byte_bpe` or `sentencepiece_bpe`
- the selected `tier`
- `formatVersion`
- `prefixMarker` and `suffixMarker`

`encodeDetailed` returns IDs, original-input UTF-8 byte offsets in `starts`, and the reserved token
names found in the input. `encodeSync` is available on the single tier and throws on tiers that cannot execute synchronously.

Edge bundlers can statically import
`hypertok/wasm/single/hypertok_wasm_core_bg.wasm` and pass the resulting bytes or compiled
`WebAssembly.Module` as `moduleSource`. Supplying it bypasses runtime wasm source discovery.

## Execution tiers

- `single` runs in the calling thread and supports synchronous encoding.
- `worker` retains one resident single tokenizer and transfers a compact worker image to ordinary
  Web Workers.
- `shared` uses a threaded WebAssembly artifact when cross-origin isolation, `SharedArrayBuffer`,
  and Web Workers are available.

With no explicit tier, byte-BPE vocabularies select the strongest available tier. SentencePiece
HTK vocabularies use the stable single-tier artifact, and their decode runs the direct decoder
rather than the byte-BPE composed pipeline. All fallback behavior remains exact.

## Vocabulary packages

The launch set is:

- `@hypertok/vocab-o200k`
- `@hypertok/vocab-qwen3-6`
- `@hypertok/vocab-mistral-tekken`
- `@hypertok/vocab-deepseek-v4`
- `@hypertok/vocab-kimi-k3`
- `@hypertok/vocab-gpt2`
- `@hypertok/vocab-cl100k`
- `@hypertok/vocab-llama3`

Each vocabulary serves a model family, not one checkpoint: o200k covers GPT-4o and the o-series,
qwen3-6 covers the Qwen 3.5 and 3.6 lines, mistral-tekken covers Mistral's tekken-based models,
deepseek-v4 covers the DeepSeek V4 line, and kimi-k3 covers the Kimi K3 family. gpt2 is
the comparability standard for r50k-era models and research baselines, and every library in
the demo races on it. cl100k covers GPT-3.5 and GPT-4 era models and the ada-002 embedding
line, and llama3 covers the Meta Llama 3 family. A model absent
from this list likely shares a vocabulary with one that is here; the package metadata's source
digest settles it.

Each package exports a `vocabulary` URL and immutable metadata including the format version, source
revision, source digest, emitted-file digest, vocabulary digest, size, and license. Each `.htk`
file is verified in both directions against its pinned source mapping before it is eligible for a
package.

Server and edge integrations can share the packaged resolver:

```js
import { loadVocab } from "hypertok/vocab-resolve";

const bytes = await loadVocab("o200k");
```

Node resolves and reads the installed `@hypertok/vocab-*` package without a network request. If
local package access is unavailable, the resolver fetches the pinned package version from
jsDelivr under a bounded timeout.

## Compatibility entry points

Two separate entry points preserve encode and decode call sites after the matching vocabulary has
been loaded:

```js
import { createTiktokenShim } from "hypertok/tiktoken";
import { createHuggingFaceShim } from "hypertok/huggingface";
```

The tiktoken shim adds 0 to 2% overhead over calling hypertok directly. The Hugging Face shim
materializes its result fields only when read, so callers that use ids alone pay nothing, and
reading token strings pays the conversion cost, measured and published per workload. The shims
cover encode and decode call sites; the exact boundary is in
[the compatibility guide](https://github.com/davidkny22/hypertok/blob/main/hypertok-js/SHIMS.md).

## Benchmarks

We establish correctness before comparing throughput. The validation suite covers both
structural classes, bidirectional vocabulary mapping, refusal paths, reserved-token behavior,
normalization offsets, chunk overlap, SIMD equivalence, all execution tiers, shims, and planted
mutations.

Decode uses the same arena, and follows the same rules. A repeated container carries token ids
the tokenizer has decoded before, so the decode cache engages. A fresh stream arrives for the
first time and pays the full path. Both are reported, separately:

| Workload | repeated, MB/s | fresh, MB/s | Fastest incumbent (fresh), MB/s | fresh speedup |
|---|---:|---:|---|---:|
| English prose | 569 | 408 | gpt-tokenizer, 236 | 1.7x |
| Chinese | 1,151 | 122 | goliapkg/tiktoken-wasm, 93 | 1.3x |
| Source code | 1,784 | 285 | gpt-tokenizer, 380 | 0.8x |
| Emoji-heavy | 1,390 | 207 | @dqbd/tiktoken, 136 | 1.5x |
| Long document | 2,952 | 153 | gpt-tokenizer, 242 | 0.6x |
| Standard text | 2,504 | 556 | gpt-tokenizer, 442 | 1.3x |
| OpenWebText, 50 MB | 191 | 195 | gpt-tokenizer, 261 | 0.7x |

All benchmarks were run in the same environment. hypertok wins 239 of the 256 decided decode
comparisons across both vocabularies and both environments; the 17 it loses on are in the
tables above and in BENCHMARKS.md, row by row. Decided means the reference produced
identical token ids; disagreeing rows carry no ratio.

The harness in [`benches/`](https://github.com/davidkny22/hypertok/tree/main/benches) measures browser and Node behavior on English, Chinese,
source code, emoji-heavy text, a long document, a third-party standard text, and a 50 MB
OpenWebText slice. It reports transfer, decompression, materialization, encode, decode, and
resident memory separately. Every row records its workload, tier, SIMD level, clock regime,
sample count, median, p95, variance, ratio, and commit. `@huggingface/tokenizers`, `kitoken`,
`gpt-tokenizer`, `js-tiktoken`, `@dqbd/tiktoken`, `@goliapkg/tiktoken-wasm`, `tiktoken-wasm`,
and `@lenml/tokenizers` are all registered in the arena. tiktoken-wasm could not be installed
for the published run (npm E404) and is recorded as unavailable.

The full results, including decode, load, and resident memory, can be found here:
[BENCHMARKS.md](https://github.com/davidkny22/hypertok/blob/main/BENCHMARKS.md).

<!-- container-arena:start -->
The published run covers 546 measured rows at tag `bench-2026-08-04`, across two vocabularies, in Node
and isolated Chrome. hypertok wins every measured encode comparison. On decode, it wins 239 of
256, and all 17 losses sit in the fresh-container regime, listed row by row in BENCHMARKS.md.
<!-- container-arena:end -->

## What it costs

![speed vs resident memory, GPT-2 long document](https://github.com/davidkny22/hypertok/raw/main/assets/pareto-speed-memory.png)

We cannot claim hypertok is pareto optimal yet. The engine keeps its tables resident.
For GPT-2, gpt-tokenizer holds only 3.1 MB, where hypertok holds 20.2 MB. (That said,
over the wire it's only about 0.27 MB gzipped with the GPT-2 vocabulary included,
sitting beside the leanest pure-JS bundles.) Constructing the tokenizer from its vocabulary bytes takes about 114 ms the first time.
If you tokenize one short prompt per page load and never again, a small pure-JS
library serves you fine. hypertok is built for the paths where tokenization is
traffic: gateways, RAG chunking, editors, anything counting tokens all day. But we
believe, either way, that this represents a meaningful step in the right direction.

## Known issues

- SentencePiece vocabularies run the single tier; the parallel tiers currently serve byte-BPE.
- The shared tier requires cross-origin isolation, which the host must opt into with headers.
- Build orchestration uses PowerShell; the benchmark and test tooling underneath is portable
  Node and Cargo.

## Credits

hypertok descends from [gigatoken](https://github.com/marcelroed/gigatoken) by Marcel Rød (MIT),
whose engine we compiled, profiled, and then rebuilt for the web. The lineage includes gigatoken's
own two-phase scanner, which had never been built for wasm before this project. We anchor
correctness to exact agreement with each vocabulary's pinned reference implementation.
Vocabulary data comes from the model publishers named in each package's NOTICE. The demo bundles
js-tiktoken, gpt-tokenizer, @dqbd/tiktoken, and @huggingface/tokenizers as live opponents, under
their own licenses. Unicode data is Unicode 17.0.0.

## AI use disclosure

<details>
<summary>How this was built</summary>

I'm a conceptual builder: I design, my agents work. The skills I built that govern the process,
along with hypertok's decision ledger and spec as a worked example, will be released shortly. The
bundle explains what I do and how I work better than a paragraph can.

</details>

## Citation

```bibtex
@software{kogan2026hypertok,
  author = {David Kogan},
  title = {hypertok: Exact BPE Tokenization at Native-Class Speed in the Browser},
  url = {https://github.com/davidkny22/hypertok},
  year = {2026},
}
```

## License

MIT. Vocabulary packages carry their sources' licenses in their NOTICE files.
