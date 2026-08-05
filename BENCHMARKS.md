# hypertok full benchmark, tag bench-2026-08-04

**Result: PASS.** The `arena/full` command completed all 12 ordered commands on the code published at tag `bench-2026-08-04`, measured as commit `b0c4bd0543d7d3ebb18194edce34d79521b09a1e` in the development lineage.

Generated from the run manifest on 2026-08-04 UTC. This report renders 756 of 756 performance records (546 measured, 210 unavailable) and preserves every comparison classification.

## Scope and method

- Command: `npm --prefix benches run benchmark` (`profile=arena`, `mode=full`).
- Ordered gates: pinned GPT-2 model, corpus, Node self-check, isolated-Chromium self-check, cross-environment self-check, Node agreement, browser agreement, cross-environment agreement, Node encode, browser encode, Node decode, browser decode.
- Workloads: `english-prose`, `chinese`, `source-code`, `emoji-heavy`, `long-document`, `standard-text`, and the deterministic 50,000,000-byte `openwebtext-slice`.
- Ordinary rows start at `n=5` and may extend to `n=11`; OpenWebText uses `n=3` and records stability. Warmup count is 2.
- Decode uses 4,096-byte field segments and natural ID containers in two separate regimes: `repeated` and `fresh`.
- Transfer, construction, and resident memory are carried forward from their booked runs and reported in their own section below.

## Execution identity

| Field | Value |
| --- | --- |
| Container hostname | ba8abf0d2661 |
| Commit | b0c4bd0543d7d3ebb18194edce34d79521b09a1e (development lineage) |
| Public tag | bench-2026-08-04 |
| Public run key | 58a3fcccae1b8590f6585b073ea5b21687ca8eb786efa3d7e982759bf2267244 |
| Session | container-b0c4bd0-full-3 |
| Profile / mode | arena / full |
| Host | Linux 6.12.13 x86_64; AMD EPYC 9V74 80-Core Processor; 22,995,924 kB MemTotal |
| Node | v24.14.0 |
| Chromium | Chrome 149.0.7827.0; SHA-256 434d2607c55941dcaa7fdd19b0800ee90488922fd9744a6642ef527ba8fabf63 |
| Browser isolation | crossOriginIsolated=true; encode local requests=134; decode local requests=333 |
| Rust / wasm-bindgen | rustc 1.97.1; wasm-bindgen-cli 0.2.125; wasm32-unknown-unknown |
| Node run-identity key | cb6cb6ded7c78a362b226f683cf2e10eee3656a219604b385cdae9b576a1a980 |
| Browser run-identity key | 78e2685de9d9915fa473008e7545cc0a7aabb165f446857c4ea34fb1b04d185c |
| Node agreement key (N) | f73f4d936d5f137065bd53dc2123bea60d6f7d03837e973ab2f069d9d36a09a2 |
| Browser agreement key (B) | 91fdecd6a688c979e7088764f8d4c6883e7d5f9f7967e8cc31ec730c9ecfc9ae |

### Identity digests

| Input | SHA-256 |
| --- | --- |
| package-lock | 8ab1645370459bc8efcd398285088dcbab6539140e1dba5e6cda9ceb3a8f136e |
| corpus | b30961f6ec50dc2674637fd9775e3632a724338ad89f4ad47c8bce1ea52d5228 |
| model | 913fc9d3fc6097222b51b0947e1455be780b383ce50f9e8529fb59c7781080dd |
| reference registry | 7317aabbfe8e899e0d1596beb880218cab0f98bd078b6348b772385ffae9de84 |
| benchmark configuration | 08a47b8b5b8f65f8786ac5b3262baea920d922719247fd28355a5b32d388fe0d |
| Node artifact | 5ff7daabe4e3b301bf50fc9cc37233d9cc73bf4baaccb43c19d8bf607db21b80 |
| Browser artifact | 940b5d723146c2fd651cfcbbd3677dbce3c9c9ab63835dab571219b6db5db3af |

## Gate summary

| Gate | Result | Evidence |
| --- | --- | --- |
| Pinned GPT-2 model | PASS | vocab=50,257; merges=50,000; digest and missing-model mutations RED |
| Corpus | PASS | 7/7 workloads; script corpus 10/10; unknown-role mutation RED |
| Node self-check | PASS | timer, four axes, 2/2 mutations RED |
| Browser self-check | PASS | timer, four axes, 2/2 mutations RED; cross-origin isolation PASS |
| Cross-environment self-check | PASS | statistics, four axes, two mutations |
| Node agreement | PASS | 91/91 measured classified: 78 identical, 13 different; 35/35 unavailable |
| Browser agreement | PASS | same classifications; 19/19 requests local; 2/2 mutations RED |
| Cross-environment agreement | PASS | 126/126 Node/browser records identical |
| Encode | PASS | 126 Node + 126 browser rows |
| Decode | PASS | 252 Node + 252 browser rows across repeated/fresh regimes |
| Adaptive sampling | RECORDED | 38 rows extended beyond initial n; final n appears per row |

## Hypertok medians

All values are MB/s. These convenience tables are duplicated from the complete source tables below.

| Workload | Node GPT-2 | Chrome GPT-2 | Node o200k | Chrome o200k |
| --- | --- | --- | --- | --- |
| english-prose | 203.396 | 159.255 | 215.780 | 100.555 |
| chinese | 139.593 | 121.943 | 150.306 | 130.827 |
| source-code | 216.811 | 205.057 | 246.426 | 206.641 |
| emoji-heavy | 153.681 | 151.312 | 167.276 | 148.337 |
| long-document | 244.491 | 185.206 | 228.781 | 187.559 |
| standard-text | 258.802 | 204.652 | 279.416 | 240.729 |
| openwebtext-slice | 195.037 | 167.898 | 192.430 | 160.679 |

### Decode — repeated container

| Workload | Node GPT-2 | Chrome GPT-2 | Node o200k | Chrome o200k |
| --- | --- | --- | --- | --- |
| english-prose | 2230.322 | 568.557 | 2010.762 | 1689.878 |
| chinese | 1402.949 | 1150.767 | 2772.764 | 2370.580 |
| source-code | 2269.431 | 1784.000 | 2980.487 | 2432.727 |
| emoji-heavy | 1770.393 | 1389.684 | 2258.625 | 1760.267 |
| long-document | 3057.496 | 2952.184 | 3675.564 | 3280.204 |
| standard-text | 3093.895 | 2503.580 | 3454.421 | 2888.746 |
| openwebtext-slice | 168.432 | 190.542 | 394.234 | 510.022 |

### Decode — fresh container

| Workload | Node GPT-2 | Chrome GPT-2 | Node o200k | Chrome o200k |
| --- | --- | --- | --- | --- |
| english-prose | 502.757 | 408.293 | 432.042 | 482.822 |
| chinese | 161.389 | 121.693 | 48.648 | 48.458 |
| source-code | 451.035 | 284.681 | 558.346 | 637.143 |
| emoji-heavy | 266.887 | 207.090 | 277.509 | 225.675 |
| long-document | 125.003 | 152.805 | 486.091 | 630.809 |
| standard-text | 452.944 | 556.351 | 445.756 | 260.790 |
| openwebtext-slice | 143.109 | 195.435 | 367.059 | 494.609 |

## Agreement classifications

The Node and browser agreement records are identical. The table below lists every `different` classification; all other measured rows are `identical`. Unavailable rows remain unavailable in the complete tables.

| Vocabulary | Workload | Reference | Version | Token count | First mismatch index | Expected | Actual | Tier | SIMD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt2 | english-prose | kitoken | 0.11.0 | 47022 | 32379 | 470 | 6 | single | scalar |
| gpt2 | standard-text | kitoken | 0.11.0 | 39690 | 18073 | 338 | 6 | single | scalar |
| gpt2 | openwebtext-slice | kitoken | 0.11.0 | 11373184 | 357974 | 338 | 6 | single | scalar |
| gpt2 | openwebtext-slice | @dqbd/tiktoken | 1.0.21 | 11373183 | 6099494 | 628 | 198 | single | scalar |
| gpt2 | openwebtext-slice | @goliapkg/tiktoken-wasm | 3.5.1 | 11373183 | 6099494 | 628 | 198 | single | scalar |
| o200k_base | english-prose | @goliapkg/tiktoken-wasm | 3.5.1 | 39789 | 59 | 370 | 201 | single | scalar |
| o200k_base | chinese | @goliapkg/tiktoken-wasm | 3.5.1 | 202639 | 9 | 78137 | 370 | single | scalar |
| o200k_base | source-code | @goliapkg/tiktoken-wasm | 3.5.1 | 3603 | 40 | 279 | 198 | single | scalar |
| o200k_base | long-document | @goliapkg/tiktoken-wasm | 3.5.1 | 170405 | 6164 | 279 | 198 | single | scalar |
| o200k_base | standard-text | @goliapkg/tiktoken-wasm | 3.5.1 | 34859 | 13 | 2499 | 279 | single | scalar |
| o200k_base | openwebtext-slice | gpt-tokenizer | 3.4.0 | 10624164 | 286902 | 5574 | 5416 | single | scalar |
| o200k_base | openwebtext-slice | js-tiktoken | 1.0.21 | 10624149 | 287294 | 2322 | 65363 | single | scalar |
| o200k_base | openwebtext-slice | @goliapkg/tiktoken-wasm | 3.5.1 | 10659832 | 245 | 279 | 198 | single | scalar |

## Complete performance tables

Each row is tied to the commit, public run key, session, container hostname, and environment identity above. `N` and `B` map to the full agreement keys above. Clock aliases preserve the exact source clock regimes:

- `NE`: `performance.now; Node single process; warm cache`
- `BE`: `performance.now; cross-origin isolated Chrome; warm cache`
- `NDR` / `NDF`: Node warm cache; 4096-byte field segments; natural ID containers; repeated / fresh container regime
- `BDR` / `BDF`: cross-origin isolated Chrome warm cache; 4096-byte field segments; natural ID containers; repeated / fresh container regime

`Ratio` is hypertok divided by the named reference for that same environment/vocabulary/workload/axis/regime. `Noise` is relative noise. OpenWebText `Stability` is `relative range / relative standard deviation`. Unavailable rows carry their registry reason.
Displayed medians, p95 values, and ratios are rounded to three decimals; variance uses five significant digits and percentages use two decimals. The source JSON files named in the manifest retain full precision.

### Encode — Node — gpt2

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NE | identical | — | 5 | 1.863 | 1.984 | 0.24982 | 26.82% | 109.156 | — | N |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NE | identical | — | 5 | 0.952 | 0.993 | 0.00041123 | 2.13% | 146.707 | — | N |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NE | identical | — | 5 | 1.436 | 1.459 | 0.00011376 | 0.74% | 150.988 | — | N |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NE | identical | — | 5 | 2.731 | 2.759 | 0.075942 | 10.09% | 56.264 | — | N |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NE | identical | — | 5 | 1.436 | 1.503 | 0.0026019 | 3.55% | 170.215 | — | N |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NE | identical | — | 5 | 1.081 | 1.154 | 0.0018283 | 3.96% | 239.477 | — | N |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NE | identical | — | 3 | 1.178 | 1.243 | 0.0010196 | 2.71% | 165.530 | 5.98% / 2.71% | N |
| english-prose (152,089 B) | kitoken | 0.11.0 | single | scalar | NE | different | — | 5 | 18.002 | 18.349 | 0.13876 | 2.07% | — | — | N |
| chinese (592,645 B) | kitoken | 0.11.0 | single | scalar | NE | identical | — | 5 | 13.001 | 13.231 | 0.065867 | 1.97% | 10.737 | — | N |
| source-code (11,150 B) | kitoken | 0.11.0 | single | scalar | NE | identical | — | 5 | 16.033 | 16.331 | 0.26983 | 3.24% | 13.523 | — | N |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | single | scalar | NE | identical | — | 5 | 15.205 | 15.861 | 0.20471 | 2.98% | 10.108 | — | N |
| long-document (738,046 B) | kitoken | 0.11.0 | single | scalar | NE | identical | — | 5 | 18.367 | 18.734 | 0.031559 | 0.97% | 13.312 | — | N |
| standard-text (125,179 B) | kitoken | 0.11.0 | single | scalar | NE | different | — | 5 | 17.087 | 17.156 | 0.045709 | 1.25% | — | — | N |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | single | scalar | NE | different | — | 3 | 20.756 | 21.518 | 0.31577 | 2.71% | — | 6.62% / 2.71% | N |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 27.107 | 29.236 | 13.978 | 13.79% | 7.504 | — | N |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 2.152 | 2.262 | 0.0059142 | 3.57% | 64.870 | — | N |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 3.299 | 5.356 | 1.0699 | 31.36% | 65.729 | — | N |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 8.825 | 9.929 | 1.6489 | 14.55% | 17.414 | — | N |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 9.665 | 13.556 | 5.0945 | 23.35% | 25.297 | — | N |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 13.385 | 23.919 | 22.924 | 35.77% | 19.336 | — | N |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 3 | 3.573 | 3.634 | 0.0094976 | 2.73% | 54.591 | 6.45% / 2.73% | N |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 3.300 | 3.715 | 0.053933 | 7.04% | 61.643 | — | N |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 0.962 | 0.965 | 0.0000082136 | 0.30% | 145.125 | — | N |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 2.000 | 2.147 | 0.0078324 | 4.42% | 108.380 | — | N |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 0.974 | 0.988 | 0.000056163 | 0.77% | 157.793 | — | N |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 2.666 | 2.868 | 0.0071582 | 3.17% | 91.711 | — | N |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 2.583 | 2.754 | 0.016512 | 4.97% | 100.176 | — | N |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 3 | 2.703 | 2.710 | 0.0055557 | 2.76% | 72.169 | 5.99% / 2.76% | N |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 7.104 | 7.225 | 0.0063060 | 1.12% | 28.632 | — | N |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 9.251 | 9.262 | 0.0031025 | 0.60% | 15.089 | — | N |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 5.248 | 5.362 | 0.0071576 | 1.61% | 41.314 | — | N |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 7.988 | 8.194 | 0.091334 | 3.78% | 19.240 | — | N |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 7.933 | 8.146 | 0.014083 | 1.50% | 30.820 | — | N |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 6.376 | 6.542 | 0.013930 | 1.85% | 40.587 | — | N |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | different | — | 3 | 8.393 | 8.654 | 0.015353 | 1.48% | — | 3.15% / 1.48% | N |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | identical | — | 5 | 26.635 | 26.886 | 3.9768 | 7.49% | 7.636 | — | N |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | identical | — | 5 | 0.977 | 0.981 | 0.0000083525 | 0.30% | 142.821 | — | N |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | identical | — | 5 | 22.019 | 22.378 | 0.12977 | 1.64% | 9.846 | — | N |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | identical | — | 5 | 19.212 | 20.040 | 5.0372 | 11.68% | 7.999 | — | N |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | identical | — | 5 | 27.347 | 27.542 | 0.10053 | 1.16% | 8.940 | — | N |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | identical | — | 5 | 22.551 | 23.386 | 2.5995 | 7.15% | 11.476 | — | N |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | different | — | 3 | 29.462 | 29.555 | 0.045145 | 0.72% | — | 1.66% / 0.72% | N |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NE | identical | — | 5 | 1.683 | 2.153 | 0.048686 | 13.11% | 120.858 | — | N |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NE | identical | — | 5 | 0.910 | 0.956 | 0.00056157 | 2.60% | 153.429 | — | N |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NE | identical | — | 5 | 1.277 | 1.288 | 0.000035235 | 0.46% | 169.765 | — | N |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NE | identical | — | 5 | 2.403 | 2.465 | 0.0021218 | 1.92% | 63.958 | — | N |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NE | identical | — | 5 | 1.503 | 1.549 | 0.0068536 | 5.51% | 162.640 | — | N |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NE | identical | — | 5 | 1.054 | 1.079 | 0.00040073 | 1.90% | 245.614 | — | N |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NE | identical | — | 3 | 1.189 | 1.239 | 0.042083 | 17.25% | 164.015 | 38.52% / 17.25% | N |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 203.396 | 208.278 | 230.50 | 7.46% | 1.000 | — | N |
| chinese (592,645 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 139.593 | 143.827 | 52.960 | 5.21% | 1.000 | — | N |
| source-code (11,150 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 216.811 | 244.587 | 155.30 | 5.75% | 1.000 | — | N |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 153.681 | 177.635 | 375.00 | 12.60% | 1.000 | — | N |
| long-document (738,046 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 244.491 | 251.656 | 1049.9 | 13.25% | 1.000 | — | N |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 258.802 | 267.410 | 1305.1 | 13.96% | 1.000 | — | N |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | NE | identical | — | 3 | 195.037 | 202.734 | 14.499 | 1.95% | 1.000 | 4.31% / 1.95% | N |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |

### Encode — Node — o200k_base

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 24.112 | 26.015 | 4.1436 | 8.44% | 8.949 | — | N |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 14.601 | 14.936 | 0.22854 | 3.27% | 10.294 | — | N |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 10.165 | 17.619 | 15.760 | 39.05% | 24.243 | — | N |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 8.872 | 9.908 | 0.55853 | 8.42% | 18.855 | — | N |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 12.296 | 13.802 | 0.92682 | 7.83% | 18.606 | — | N |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | identical | — | 5 | 12.901 | 16.641 | 5.3632 | 17.95% | 21.658 | — | N |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | NE | different | — | 3 | 5.451 | 5.465 | 0.0055003 | 1.36% | — | 3.01% / 1.36% | N |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 3.492 | 3.565 | 0.0035344 | 1.70% | 61.801 | — | N |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 0.512 | 0.515 | 0.0000039636 | 0.39% | 293.526 | — | N |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 2.244 | 2.620 | 0.023926 | 6.89% | 109.833 | — | N |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 0.790 | 0.800 | 0.000036700 | 0.77% | 211.819 | — | N |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 2.392 | 2.880 | 0.049216 | 9.27% | 95.648 | — | N |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 2.085 | 2.259 | 0.014589 | 5.79% | 134.020 | — | N |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | NE | different | — | 3 | 2.421 | 2.444 | 0.0020351 | 1.86% | — | 4.35% / 1.86% | N |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 4.666 | 4.713 | 0.0011605 | 0.73% | 46.241 | — | N |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 7.180 | 7.221 | 0.020342 | 1.99% | 20.935 | — | N |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 3.507 | 3.536 | 0.0055822 | 2.13% | 70.268 | — | N |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 6.137 | 6.162 | 0.0016165 | 0.66% | 27.258 | — | N |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 5.318 | 5.338 | 0.0040423 | 1.20% | 43.019 | — | N |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 5 | 4.388 | 4.494 | 0.19042 | 9.95% | 63.683 | — | N |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NE | identical | — | 3 | 5.363 | 5.496 | 0.080321 | 5.29% | 35.884 | 12.25% / 5.29% | N |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | different | — | 5 | 54.094 | 54.564 | 2.2558 | 2.78% | — | — | N |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | different | — | 5 | 0.888 | 0.956 | 0.0020084 | 5.05% | — | — | N |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | different | — | 5 | 45.350 | 45.518 | 0.29002 | 1.19% | — | — | N |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | identical | — | 5 | 19.873 | 20.005 | 0.076730 | 1.39% | 8.417 | — | N |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | different | — | 5 | 54.268 | 56.091 | 5.2591 | 4.23% | — | — | N |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | different | — | 5 | 40.928 | 42.062 | 0.77883 | 2.16% | — | — | N |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NE | different | — | 3 | 55.671 | 57.347 | 0.64054 | 1.44% | — | 3.09% / 1.44% | N |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 215.780 | 222.828 | 19.314 | 2.04% | 1.000 | — | N |
| chinese (592,645 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 150.306 | 151.490 | 0.79388 | 0.59% | 1.000 | — | N |
| source-code (11,150 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 246.426 | 250.861 | 10.920 | 1.34% | 1.000 | — | N |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 167.276 | 168.031 | 1.4710 | 0.73% | 1.000 | — | N |
| long-document (738,046 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 228.781 | 232.059 | 3.5608 | 0.82% | 1.000 | — | N |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | NE | identical | — | 5 | 279.416 | 295.212 | 86.252 | 3.32% | 1.000 | — | N |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | NE | identical | — | 3 | 192.430 | 198.961 | 33.194 | 2.99% | 1.000 | 7.33% / 2.99% | N |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| english-prose (152,089 B) | kitoken | 0.11.0 | — | — | NE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | kitoken | 0.11.0 | — | — | NE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | kitoken | 0.11.0 | — | — | NE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | — | — | NE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | kitoken | 0.11.0 | — | — | NE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | kitoken | 0.11.0 | — | — | NE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | — | — | NE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | — | — | NE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | NE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |

### Encode — Chrome — gpt2

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BE | identical | — | 5 | 1.702 | 1.921 | 0.033493 | 10.76% | 93.597 | — | B |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BE | identical | — | 5 | 1.044 | 1.060 | 0.0029356 | 5.19% | 116.821 | — | B |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BE | identical | — | 5 | 1.167 | 1.291 | 0.0058866 | 6.57% | 175.720 | — | B |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BE | identical | — | 5 | 2.263 | 2.324 | 0.0036717 | 2.68% | 66.860 | — | B |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BE | identical | — | 5 | 1.435 | 1.502 | 0.0051137 | 4.98% | 129.059 | — | B |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BE | identical | — | 5 | 0.946 | 1.062 | 0.0033189 | 6.09% | 216.272 | — | B |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BE | identical | — | 3 | 0.877 | 1.048 | 0.0071015 | 9.61% | 191.454 | 21.18% / 9.61% | B |
| english-prose (152,089 B) | kitoken | 0.11.0 | single | scalar | BE | different | — | 5 | 16.885 | 16.922 | 9.6970 | 18.44% | — | — | B |
| chinese (592,645 B) | kitoken | 0.11.0 | single | scalar | BE | identical | — | 5 | 11.086 | 11.523 | 0.11300 | 3.03% | 11.000 | — | B |
| source-code (11,150 B) | kitoken | 0.11.0 | single | scalar | BE | identical | — | 5 | 13.988 | 14.571 | 0.28247 | 3.80% | 14.659 | — | B |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | single | scalar | BE | identical | — | 5 | 13.285 | 13.781 | 0.31146 | 4.20% | 11.390 | — | B |
| long-document (738,046 B) | kitoken | 0.11.0 | single | scalar | BE | identical | — | 5 | 16.325 | 16.864 | 0.14645 | 2.34% | 11.345 | — | B |
| standard-text (125,179 B) | kitoken | 0.11.0 | single | scalar | BE | different | — | 5 | 15.690 | 15.749 | 0.015147 | 0.78% | — | — | B |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | single | scalar | BE | different | — | 3 | 18.771 | 18.798 | 0.0042810 | 0.35% | — | 0.80% / 0.35% | B |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 25.540 | 26.087 | 0.68917 | 3.25% | 6.236 | — | B |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 2.476 | 2.543 | 0.0039097 | 2.53% | 49.249 | — | B |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 3.347 | 5.284 | 1.0689 | 30.89% | 61.268 | — | B |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 9.194 | 10.810 | 0.75312 | 9.44% | 16.458 | — | B |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 11.866 | 16.417 | 5.2731 | 19.35% | 15.609 | — | B |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 15.397 | 19.631 | 7.5763 | 17.88% | 13.292 | — | B |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 3 | 3.914 | 3.955 | 0.0041277 | 1.64% | 42.892 | 3.88% / 1.64% | B |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 2.109 | 2.641 | 0.071239 | 12.66% | 75.510 | — | B |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 0.760 | 0.815 | 0.0076505 | 11.51% | 160.416 | — | B |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 1.475 | 1.578 | 0.0057204 | 5.13% | 139.019 | — | B |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 0.783 | 0.810 | 0.00057880 | 3.07% | 193.152 | — | B |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 1.850 | 1.968 | 0.0060311 | 4.20% | 100.137 | — | B |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 1.596 | 1.785 | 0.052743 | 14.39% | 128.253 | — | B |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 3 | 2.131 | 2.137 | 0.35685 | 28.04% | 78.805 | 59.62% / 28.04% | B |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 6.688 | 6.716 | 0.0030617 | 0.83% | 23.812 | — | B |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 9.026 | 9.306 | 0.59540 | 8.55% | 13.510 | — | B |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 4.638 | 4.861 | 0.041675 | 4.40% | 44.215 | — | B |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 7.598 | 7.766 | 0.90546 | 12.52% | 19.914 | — | B |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 6.539 | 6.651 | 1.4078 | 18.15% | 28.324 | — | B |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 5.845 | 5.911 | 0.037945 | 3.33% | 35.014 | — | B |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | different | — | 3 | 7.776 | 7.838 | 0.062793 | 3.22% | — | 7.20% / 3.22% | B |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | identical | — | 5 | 24.780 | 25.170 | 0.37611 | 2.47% | 6.427 | — | B |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | identical | — | 5 | 0.889 | 0.912 | 0.0024076 | 5.52% | 137.170 | — | B |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | identical | — | 5 | 18.925 | 19.224 | 0.54671 | 3.91% | 10.835 | — | B |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | identical | — | 5 | 17.151 | 17.556 | 0.25510 | 2.94% | 8.822 | — | B |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | identical | — | 5 | 22.041 | 23.467 | 1.0180 | 4.58% | 8.403 | — | B |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | identical | — | 5 | 21.834 | 22.507 | 1.8782 | 6.28% | 9.373 | — | B |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | different | — | 3 | 26.391 | 27.740 | 0.44968 | 2.54% | — | 5.63% / 2.54% | B |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BE | identical | — | 5 | 1.724 | 1.968 | 0.036709 | 11.11% | 92.385 | — | B |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BE | identical | — | 5 | 1.011 | 1.045 | 0.0013425 | 3.62% | 120.628 | — | B |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BE | identical | — | 5 | 1.124 | 1.239 | 0.0063909 | 7.11% | 182.494 | — | B |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BE | identical | — | 5 | 2.248 | 2.312 | 0.0053448 | 3.25% | 67.307 | — | B |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BE | identical | — | 5 | 1.438 | 1.521 | 0.016730 | 8.99% | 128.769 | — | B |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BE | identical | — | 5 | 1.011 | 1.190 | 0.016033 | 12.52% | 202.343 | — | B |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BE | identical | — | 3 | 1.101 | 1.104 | 0.00022877 | 1.37% | 152.441 | 3.02% / 1.37% | B |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 159.255 | 168.054 | 156.97 | 7.87% | 1.000 | — | B |
| chinese (592,645 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 121.943 | 135.307 | 278.47 | 13.68% | 1.000 | — | B |
| source-code (11,150 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 205.057 | 208.249 | 6.9913 | 1.29% | 1.000 | — | B |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 151.312 | 157.167 | 105.72 | 6.80% | 1.000 | — | B |
| long-document (738,046 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 185.206 | 192.450 | 105.13 | 5.54% | 1.000 | — | B |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 204.652 | 217.073 | 101.34 | 4.92% | 1.000 | — | B |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | BE | identical | — | 3 | 167.898 | 172.688 | 1731.1 | 24.78% | 1.000 | 53.94% / 24.78% | B |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |

### Encode — Chrome — o200k_base

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 27.453 | 28.777 | 5.9791 | 8.91% | 3.663 | — | B |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 15.976 | 19.068 | 3.2286 | 11.25% | 8.189 | — | B |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 11.637 | 18.411 | 15.903 | 34.27% | 17.757 | — | B |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 11.696 | 12.131 | 0.50508 | 6.08% | 12.683 | — | B |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 16.148 | 16.432 | 1.0414 | 6.32% | 11.615 | — | B |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | identical | — | 5 | 13.634 | 17.930 | 7.1695 | 19.64% | 17.657 | — | B |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | BE | different | — | 3 | 5.250 | 5.568 | 0.033209 | 3.47% | — | 8.20% / 3.47% | B |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 1.923 | 2.196 | 0.037516 | 10.07% | 52.294 | — | B |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 0.443 | 0.469 | 0.00015848 | 2.84% | 295.135 | — | B |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 1.624 | 1.793 | 0.0052032 | 4.44% | 127.208 | — | B |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 0.695 | 0.707 | 0.000045304 | 0.97% | 213.354 | — | B |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 1.875 | 2.134 | 0.036922 | 10.25% | 100.030 | — | B |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 1.674 | 1.675 | 0.0029330 | 3.24% | 143.808 | — | B |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | BE | different | — | 3 | 1.906 | 1.907 | 0.00024290 | 0.82% | — | 1.78% / 0.82% | B |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 4.398 | 4.452 | 0.047478 | 4.95% | 22.861 | — | B |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 6.794 | 6.915 | 0.16137 | 5.91% | 19.255 | — | B |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 2.966 | 3.154 | 0.014762 | 4.10% | 69.672 | — | B |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 4.641 | 5.526 | 0.37478 | 13.19% | 31.963 | — | B |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 4.807 | 4.919 | 0.050670 | 4.68% | 39.022 | — | B |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 5 | 4.349 | 4.471 | 0.0095305 | 2.25% | 55.359 | — | B |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BE | identical | — | 3 | 5.039 | 5.070 | 0.00050716 | 0.45% | 31.890 | 1.09% / 0.45% | B |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | different | — | 5 | 49.140 | 49.784 | 11.632 | 6.94% | — | — | B |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | different | — | 5 | 0.786 | 0.878 | 0.0061278 | 9.95% | — | — | B |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | different | — | 5 | 39.037 | 40.000 | 1.2588 | 2.87% | — | — | B |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | identical | — | 5 | 16.508 | 18.073 | 0.63128 | 4.81% | 8.986 | — | B |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | different | — | 5 | 43.697 | 44.528 | 0.41032 | 1.47% | — | — | B |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | different | — | 5 | 34.062 | 35.562 | 1.9409 | 4.09% | — | — | B |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BE | different | — | 3 | 44.200 | 44.689 | 0.10119 | 0.72% | — | 1.74% / 0.72% | B |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 100.555 | 108.441 | 22.823 | 4.75% | 1.000 | — | B |
| chinese (592,645 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 130.827 | 135.307 | 121.84 | 8.44% | 1.000 | — | B |
| source-code (11,150 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 206.641 | 210.709 | 15.388 | 1.90% | 1.000 | — | B |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 148.337 | 153.959 | 283.86 | 11.36% | 1.000 | — | B |
| long-document (738,046 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 187.559 | 197.075 | 1666.0 | 21.76% | 1.000 | — | B |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | BE | identical | — | 5 | 240.729 | 252.038 | 25.310 | 2.09% | 1.000 | — | B |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | BE | identical | — | 3 | 160.679 | 163.439 | 1040.8 | 20.08% | 1.000 | 43.42% / 20.08% | B |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| english-prose (152,089 B) | kitoken | 0.11.0 | — | — | BE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | kitoken | 0.11.0 | — | — | BE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | kitoken | 0.11.0 | — | — | BE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | — | — | BE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | kitoken | 0.11.0 | — | — | BE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | kitoken | 0.11.0 | — | — | BE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | — | — | BE | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | — | — | BE | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | BE | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |

### Decode repeated — Node — gpt2

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDR | identical | true | 5 | 9.222 | 9.645 | 0.37086 | 6.60% | 241.854 | — | N |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDR | identical | true | 5 | 8.200 | 8.232 | 1.3326 | 14.08% | 171.088 | — | N |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDR | identical | true | 5 | 9.728 | 9.820 | 0.060762 | 2.53% | 233.296 | — | N |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDR | identical | true | 5 | 9.012 | 9.089 | 0.012326 | 1.23% | 196.445 | — | N |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDR | identical | true | 5 | 9.510 | 9.579 | 8.1490 | 30.02% | 321.489 | — | N |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDR | identical | true | 5 | 9.214 | 9.655 | 0.10477 | 3.51% | 335.765 | — | N |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDR | identical | true | 3 | 10.038 | 10.042 | 0.012842 | 1.13% | 16.780 | 2.42% / 1.13% | N |
| english-prose (152,089 B) | kitoken | 0.11.0 | single | scalar | NDR | different | true | 5 | 143.995 | 151.930 | 69.076 | 5.77% | — | — | N |
| chinese (592,645 B) | kitoken | 0.11.0 | single | scalar | NDR | identical | true | 5 | 72.280 | 72.522 | 0.37268 | 0.84% | 19.410 | — | N |
| source-code (11,150 B) | kitoken | 0.11.0 | single | scalar | NDR | identical | true | 5 | 178.638 | 187.036 | 141.19 | 6.65% | 12.704 | — | N |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | single | scalar | NDR | identical | true | 5 | 133.744 | 136.295 | 8.7492 | 2.21% | 13.237 | — | N |
| long-document (738,046 B) | kitoken | 0.11.0 | single | scalar | NDR | identical | true | 5 | 158.704 | 159.444 | 1.1625 | 0.68% | 19.265 | — | N |
| standard-text (125,179 B) | kitoken | 0.11.0 | single | scalar | NDR | different | true | 5 | 153.810 | 158.551 | 30.470 | 3.59% | — | — | N |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | single | scalar | NDR | different | true | 3 | 153.750 | 155.895 | 1.4454 | 0.78% | — | 1.83% / 0.78% | N |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 11 (escalated 5→11) | 390.237 | 452.315 | 1444.0 | 9.74% | 5.715 | — | N |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 12.412 | 13.224 | 0.65203 | 6.51% | 113.032 | — | N |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 323.043 | 326.282 | 7859.8 | 27.44% | 7.025 | — | N |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 11.207 | 13.650 | 1.8702 | 12.20% | 157.978 | — | N |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 146.963 | 160.816 | 280.18 | 11.39% | 20.805 | — | N |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 357.360 | 364.414 | 113.42 | 2.98% | 8.658 | — | N |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 3 | 170.473 | 175.808 | 20.990 | 2.69% | 0.988 | 6.58% / 2.69% | N |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 11 (escalated 5→11) | 66.018 | 66.752 | 4.7098 | 3.29% | 33.784 | — | N |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 32.683 | 32.704 | 1.6873 | 3.97% | 42.926 | — | N |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 67.916 | 73.411 | 105.47 | 15.12% | 33.415 | — | N |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 58.948 | 59.432 | 0.084051 | 0.49% | 30.033 | — | N |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 56.247 | 57.134 | 131.32 | 20.37% | 54.359 | — | N |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 56.923 | 61.641 | 248.76 | 27.71% | 54.353 | — | N |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 3 | 55.582 | 56.405 | 0.31411 | 1.01% | 3.030 | 2.45% / 1.01% | N |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 11 (escalated 5→11) | 146.164 | 147.719 | 168.53 | 8.88% | 15.259 | — | N |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 100.261 | 100.469 | 7.2593 | 2.69% | 13.993 | — | N |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 191.111 | 199.189 | 92.846 | 5.04% | 11.875 | — | N |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 150.307 | 153.070 | 175.19 | 8.81% | 11.779 | — | N |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 143.904 | 145.786 | 4.4190 | 1.46% | 21.247 | — | N |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 144.450 | 145.518 | 0.54335 | 0.51% | 21.418 | — | N |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | different | true | 3 | 138.170 | 138.864 | 3.9820 | 1.44% | — | 3.28% / 1.44% | N |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | identical | true | 11 (escalated 5→11) | 202.584 | 207.422 | 134.96 | 5.73% | 11.009 | — | N |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | identical | true | 5 | 100.925 | 102.282 | 79.593 | 8.84% | 13.901 | — | N |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | identical | true | 5 | 188.755 | 201.058 | 75.409 | 4.60% | 12.023 | — | N |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | identical | true | 5 | 147.441 | 148.949 | 6.3289 | 1.71% | 12.007 | — | N |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | identical | true | 5 | 189.834 | 194.291 | 279.13 | 8.80% | 16.106 | — | N |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | identical | true | 5 | 200.113 | 202.398 | 2.1365 | 0.73% | 15.461 | — | N |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | different | true | 3 | 207.560 | 207.628 | 0.55045 | 0.36% | — | 0.77% / 0.36% | N |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDR | identical | true | 5 | 8.445 | 8.921 | 0.061006 | 2.92% | 264.102 | — | N |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDR | identical | true | 5 | 7.339 | 7.589 | 0.050855 | 3.07% | 191.158 | — | N |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDR | identical | true | 5 | 8.871 | 9.485 | 0.093574 | 3.45% | 255.829 | — | N |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDR | identical | true | 5 | 8.500 | 8.614 | 0.080261 | 3.33% | 208.275 | — | N |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDR | identical | true | 5 | 9.099 | 9.407 | 0.028570 | 1.86% | 336.014 | — | N |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDR | identical | true | 5 | 8.807 | 9.193 | 0.13347 | 4.15% | 351.318 | — | N |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDR | identical | true | 3 | 8.932 | 8.988 | 0.0010457 | 0.36% | 18.857 | 0.86% / 0.36% | N |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | NDR | identical | true | 11 (escalated 5→11) | 2230.322 | 2855.113 | 1.0767e+6 | 46.52% | 1.000 | — | N |
| chinese (592,645 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 1402.949 | 1409.797 | 7117.7 | 6.01% | 1.000 | — | N |
| source-code (11,150 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 2269.431 | 2272.708 | 25650 | 7.06% | 1.000 | — | N |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 1770.393 | 1770.987 | 0.70620 | 0.05% | 1.000 | — | N |
| long-document (738,046 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 3057.496 | 3491.164 | 1.9640e+5 | 14.49% | 1.000 | — | N |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 3093.895 | 3106.975 | 34306 | 5.99% | 1.000 | — | N |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | NDR | identical | true | 3 | 168.432 | 168.785 | 0.35185 | 0.35% | 1.000 | 0.83% / 0.35% | N |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |

### Decode repeated — Node — o200k_base

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 420.323 | 426.491 | 208.03 | 3.43% | 4.784 | — | N |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 37.339 | 46.121 | 51.812 | 19.28% | 74.260 | — | N |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 435.857 | 438.907 | 94.325 | 2.23% | 6.838 | — | N |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 11.726 | 13.070 | 3.7918 | 16.61% | 192.611 | — | N |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 399.387 | 421.265 | 8434.7 | 23.00% | 9.203 | — | N |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | identical | true | 5 | 375.072 | 378.094 | 124.66 | 2.98% | 9.210 | — | N |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDR | different | true | 3 | 297.308 | 301.343 | 8.4903 | 0.98% | — | 2.39% / 0.98% | N |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 64.519 | 65.264 | 92.290 | 14.89% | 31.166 | — | N |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 53.340 | 53.648 | 0.098935 | 0.59% | 51.983 | — | N |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 98.096 | 100.061 | 497.35 | 22.73% | 30.383 | — | N |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 75.540 | 76.256 | 1.6225 | 1.69% | 29.900 | — | N |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 52.303 | 56.173 | 57.478 | 14.50% | 70.274 | — | N |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 56.867 | 58.846 | 9.1696 | 5.32% | 60.745 | — | N |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | NDR | different | true | 3 | 39.244 | 40.972 | 0.76617 | 2.23% | — | 5.00% / 2.23% | N |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 158.498 | 161.475 | 10.074 | 2.00% | 12.686 | — | N |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 165.441 | 165.940 | 11.459 | 2.05% | 16.760 | — | N |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 240.119 | 242.690 | 3.7852 | 0.81% | 12.413 | — | N |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 174.228 | 175.767 | 0.96686 | 0.56% | 12.964 | — | N |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 142.375 | 144.277 | 6.4925 | 1.79% | 25.816 | — | N |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 5 | 146.483 | 149.608 | 4.9010 | 1.51% | 23.582 | — | N |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDR | identical | true | 3 | 119.256 | 124.170 | 7.6966 | 2.33% | 3.306 | 5.47% / 2.33% | N |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | different | true | 5 | 222.067 | 223.930 | 41.859 | 2.91% | — | — | N |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | different | true | 5 | 175.312 | 176.815 | 5.2694 | 1.31% | — | — | N |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | different | true | 5 | 248.849 | 252.492 | 4.8004 | 0.88% | — | — | N |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | identical | true | 5 | 180.932 | 182.277 | 10.624 | 1.80% | 12.483 | — | N |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | different | true | 5 | 202.637 | 206.441 | 55.184 | 3.67% | — | — | N |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | different | true | 5 | 214.423 | 215.344 | 7.7556 | 1.30% | — | — | N |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDR | different | true | 3 | 199.537 | 202.093 | 14.365 | 1.90% | — | 4.51% / 1.90% | N |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 2010.762 | 2027.664 | 971.62 | 1.55% | 1.000 | — | N |
| chinese (592,645 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 2772.764 | 2814.961 | 98605 | 11.32% | 1.000 | — | N |
| source-code (11,150 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 2980.487 | 3008.026 | 1.0170e+5 | 10.70% | 1.000 | — | N |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 2258.625 | 2262.302 | 12.044 | 0.15% | 1.000 | — | N |
| long-document (738,046 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 3675.564 | 3872.143 | 51319 | 6.16% | 1.000 | — | N |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | NDR | identical | true | 5 | 3454.421 | 3462.702 | 128.13 | 0.33% | 1.000 | — | N |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | NDR | identical | true | 3 | 394.234 | 402.694 | 44.318 | 1.69% | 1.000 | 4.14% / 1.69% | N |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| english-prose (152,089 B) | kitoken | 0.11.0 | — | — | NDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | kitoken | 0.11.0 | — | — | NDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | kitoken | 0.11.0 | — | — | NDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | — | — | NDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | kitoken | 0.11.0 | — | — | NDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | kitoken | 0.11.0 | — | — | NDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | — | — | NDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | — | — | NDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | NDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |

### Decode repeated — Chrome — gpt2

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDR | identical | true | 5 | 9.420 | 10.111 | 0.21237 | 4.89% | 60.355 | — | B |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDR | identical | true | 5 | 5.843 | 8.368 | 3.9164 | 33.87% | 196.951 | — | B |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDR | identical | true | 5 | 9.827 | 10.891 | 2.7164 | 16.77% | 181.533 | — | B |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDR | identical | true | 5 | 10.011 | 10.224 | 0.069351 | 2.63% | 138.816 | — | B |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDR | identical | true | 5 | 8.278 | 9.893 | 5.1160 | 27.32% | 356.620 | — | B |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDR | identical | true | 5 | 9.730 | 10.056 | 0.85444 | 9.50% | 257.300 | — | B |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDR | identical | true | 3 | 10.518 | 10.558 | 0.0032489 | 0.54% | 18.115 | 1.29% / 0.54% | B |
| english-prose (152,089 B) | kitoken | 0.11.0 | single | scalar | BDR | different | true | 5 | 133.411 | 138.263 | 34.893 | 4.43% | — | — | B |
| chinese (592,645 B) | kitoken | 0.11.0 | single | scalar | BDR | identical | true | 5 | 67.964 | 69.073 | 5.0975 | 3.32% | 16.932 | — | B |
| source-code (11,150 B) | kitoken | 0.11.0 | single | scalar | BDR | identical | true | 5 | 166.211 | 166.729 | 1249.0 | 21.26% | 10.733 | — | B |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | single | scalar | BDR | identical | true | 5 | 112.597 | 117.875 | 40.008 | 5.62% | 12.342 | — | B |
| long-document (738,046 B) | kitoken | 0.11.0 | single | scalar | BDR | identical | true | 5 | 128.692 | 132.504 | 57.013 | 5.87% | 22.940 | — | B |
| standard-text (125,179 B) | kitoken | 0.11.0 | single | scalar | BDR | different | true | 5 | 137.559 | 141.179 | 5.8855 | 1.76% | — | — | B |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | single | scalar | BDR | different | true | 3 | 130.914 | 132.480 | 5.7368 | 1.83% | — | 4.34% / 1.83% | B |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 11 (escalated 5→11) | 255.612 | 506.963 | 14552 | 47.19% | 2.224 | — | B |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 14.092 | 15.074 | 0.20251 | 3.19% | 81.660 | — | B |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 366.575 | 379.574 | 2472.9 | 13.57% | 4.867 | — | B |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 16.274 | 16.855 | 0.75957 | 5.36% | 85.395 | — | B |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 216.754 | 241.586 | 5853.3 | 35.30% | 13.620 | — | B |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 452.454 | 460.782 | 25.907 | 1.12% | 5.533 | — | B |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 3 | 264.236 | 265.696 | 23.336 | 1.83% | 0.721 | 4.12% / 1.83% | B |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 11 (escalated 5→11) | 67.073 | 71.403 | 13.427 | 5.46% | 8.477 | — | B |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 32.980 | 35.392 | 5.2682 | 6.96% | 34.893 | — | B |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 80.360 | 82.212 | 75.762 | 10.83% | 22.200 | — | B |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 63.778 | 64.322 | 102.42 | 15.87% | 21.789 | — | B |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 64.741 | 70.966 | 205.46 | 22.14% | 45.600 | — | B |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 59.233 | 66.762 | 56.124 | 12.65% | 42.267 | — | B |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 3 | 56.490 | 57.031 | 4.3630 | 3.70% | 3.373 | 8.28% / 3.70% | B |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 11 (escalated 5→11) | 123.650 | 139.212 | 93.110 | 7.80% | 4.598 | — | B |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 84.543 | 85.642 | 48.503 | 8.24% | 13.612 | — | B |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 183.918 | 189.117 | 15.767 | 2.16% | 9.700 | — | B |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 136.103 | 138.241 | 33.360 | 4.24% | 10.211 | — | B |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 40.720 | 62.256 | 126.68 | 27.64% | 72.500 | — | B |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 134.360 | 135.329 | 5.0229 | 1.67% | 18.633 | — | B |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | different | true | 3 | 122.108 | 133.445 | 65.136 | 6.61% | — | 16.13% / 6.61% | B |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | identical | true | 11 (escalated 5→11) | 181.058 | 197.518 | 169.81 | 7.20% | 3.140 | — | B |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | identical | true | 5 | 98.201 | 98.857 | 3.4687 | 1.90% | 11.718 | — | B |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | identical | true | 5 | 206.641 | 209.882 | 6.5914 | 1.24% | 8.633 | — | B |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | identical | true | 5 | 148.755 | 148.755 | 2.0463 | 0.96% | 9.342 | — | B |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | identical | true | 5 | 176.989 | 193.967 | 1926.9 | 24.80% | 16.680 | — | B |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | identical | true | 5 | 197.132 | 201.360 | 62.275 | 4.00% | 12.700 | — | B |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | different | true | 3 | 194.382 | 199.450 | 14.021 | 1.93% | — | 4.71% / 1.93% | B |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDR | identical | true | 5 | 9.519 | 9.679 | 0.44629 | 7.02% | 59.729 | — | B |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDR | identical | true | 5 | 7.912 | 8.126 | 0.22723 | 6.02% | 145.437 | — | B |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDR | identical | true | 5 | 9.562 | 10.123 | 9.3568 | 31.99% | 186.567 | — | B |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDR | identical | true | 5 | 8.957 | 9.560 | 0.17427 | 4.66% | 155.158 | — | B |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDR | identical | true | 5 | 9.171 | 9.345 | 0.21859 | 5.10% | 321.920 | — | B |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDR | identical | true | 5 | 9.031 | 9.351 | 1.6703 | 14.31% | 277.233 | — | B |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDR | identical | true | 3 | 10.023 | 10.140 | 0.0063171 | 0.79% | 19.009 | 1.93% / 0.79% | B |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | BDR | identical | true | 11 (escalated 5→11) | 568.557 | 2339.831 | 7.9263e+5 | 156.59% | 1.000 | — | B |
| chinese (592,645 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 1150.767 | 1162.049 | 20.365 | 0.39% | 1.000 | — | B |
| source-code (11,150 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 1784.000 | 1845.517 | 605.50 | 1.38% | 1.000 | — | B |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 1389.684 | 1427.243 | 755.85 | 1.98% | 1.000 | — | B |
| long-document (738,046 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 2952.184 | 2952.184 | 536.13 | 0.78% | 1.000 | — | B |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 2503.580 | 2503.580 | 1.5464e-10 | 0.00% | 1.000 | — | B |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | BDR | identical | true | 3 | 190.542 | 193.480 | 3.8163 | 1.03% | 1.000 | 2.49% / 1.03% | B |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |

### Decode repeated — Chrome — o200k_base

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 533.646 | 584.958 | 7329.1 | 16.04% | 3.167 | — | B |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 68.712 | 71.317 | 32.104 | 8.25% | 34.500 | — | B |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 504.906 | 504.906 | 2204.3 | 9.30% | 4.818 | — | B |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 22.114 | 24.585 | 1.3241 | 5.20% | 79.600 | — | B |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 251.036 | 508.997 | 10946 | 41.68% | 13.067 | — | B |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | identical | true | 5 | 463.626 | 469.421 | 12438 | 24.06% | 6.231 | — | B |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDR | different | true | 3 | 370.796 | 377.843 | 118.23 | 2.93% | — | 6.95% / 2.93% | B |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 70.168 | 71.153 | 7.6561 | 3.94% | 24.083 | — | B |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 54.571 | 55.936 | 22.311 | 8.66% | 43.440 | — | B |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 93.403 | 109.224 | 153.76 | 13.28% | 26.045 | — | B |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 78.818 | 79.770 | 281.81 | 21.30% | 22.333 | — | B |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 66.521 | 67.309 | 402.06 | 30.14% | 49.311 | — | B |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 60.134 | 66.408 | 23.117 | 8.00% | 48.038 | — | B |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | BDR | different | true | 3 | 46.695 | 48.010 | 0.48091 | 1.49% | — | 3.40% / 1.49% | B |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 132.539 | 138.578 | 83.235 | 6.88% | 12.750 | — | B |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 130.827 | 135.928 | 17.841 | 3.23% | 18.120 | — | B |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 223.000 | 229.700 | 33.259 | 2.59% | 10.909 | — | B |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 158.583 | 161.492 | 2.7960 | 1.05% | 11.100 | — | B |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 110.901 | 116.228 | 6.4293 | 2.29% | 29.578 | — | B |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 5 | 128.389 | 129.944 | 23.520 | 3.78% | 22.500 | — | B |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDR | identical | true | 3 | 102.430 | 106.049 | 19.205 | 4.28% | 4.979 | 10.31% / 4.28% | B |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | different | true | 5 | 203.464 | 209.778 | 214.04 | 7.19% | — | — | B |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | different | true | 5 | 164.853 | 168.365 | 47.234 | 4.17% | — | — | B |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | different | true | 5 | 264.950 | 267.600 | 40.290 | 2.40% | — | — | B |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | identical | true | 5 | 149.598 | 168.716 | 86.121 | 6.20% | 11.767 | — | B |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | different | true | 5 | 203.039 | 207.608 | 19.774 | 2.19% | — | — | B |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | different | true | 5 | 203.543 | 205.211 | 396.99 | 9.79% | — | — | B |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDR | different | true | 3 | 186.539 | 188.437 | 39.567 | 3.37% | — | 7.61% / 3.37% | B |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 1689.878 | 2534.817 | 6.6236e+5 | 48.16% | 1.000 | — | B |
| chinese (592,645 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 2370.580 | 2370.580 | 9799.3 | 4.18% | 1.000 | — | B |
| source-code (11,150 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 2432.727 | 2432.727 | 6575.7 | 3.33% | 1.000 | — | B |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 1760.267 | 1886.000 | 50480 | 12.76% | 1.000 | — | B |
| long-document (738,046 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 3280.204 | 3354.755 | 2128.1 | 1.41% | 1.000 | — | B |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | BDR | identical | true | 5 | 2888.746 | 2888.746 | 2747.3 | 1.81% | 1.000 | — | B |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | BDR | identical | true | 3 | 510.022 | 513.057 | 48.398 | 1.36% | 1.000 | 3.14% / 1.36% | B |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| english-prose (152,089 B) | kitoken | 0.11.0 | — | — | BDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | kitoken | 0.11.0 | — | — | BDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | kitoken | 0.11.0 | — | — | BDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | — | — | BDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | kitoken | 0.11.0 | — | — | BDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | kitoken | 0.11.0 | — | — | BDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | — | — | BDR | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | — | — | BDR | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | BDR | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |

### Decode fresh — Node — gpt2

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDF | identical | true | 5 | 9.910 | 10.158 | 0.039560 | 2.01% | 50.730 | — | N |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDF | identical | true | 5 | 8.202 | 8.330 | 0.010693 | 1.26% | 19.677 | — | N |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDF | identical | true | 5 | 10.319 | 10.365 | 0.10150 | 3.09% | 43.711 | — | N |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDF | identical | true | 5 | 9.778 | 9.810 | 0.083737 | 2.96% | 27.296 | — | N |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDF | identical | true | 5 | 9.425 | 9.803 | 0.10071 | 3.37% | 13.263 | — | N |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDF | identical | true | 5 | 9.651 | 9.768 | 0.039799 | 2.07% | 46.932 | — | N |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | NDF | identical | true | 3 | 9.744 | 10.123 | 0.034361 | 1.90% | 14.686 | 4.17% / 1.90% | N |
| english-prose (152,089 B) | kitoken | 0.11.0 | single | scalar | NDF | different | true | 5 | 157.268 | 161.732 | 12.819 | 2.28% | — | — | N |
| chinese (592,645 B) | kitoken | 0.11.0 | single | scalar | NDF | identical | true | 5 | 71.820 | 73.209 | 1.9434 | 1.94% | 2.247 | — | N |
| source-code (11,150 B) | kitoken | 0.11.0 | single | scalar | NDF | identical | true | 5 | 182.122 | 183.471 | 81.253 | 4.95% | 2.477 | — | N |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | single | scalar | NDF | identical | true | 5 | 132.656 | 135.256 | 8.5590 | 2.21% | 2.012 | — | N |
| long-document (738,046 B) | kitoken | 0.11.0 | single | scalar | NDF | identical | true | 5 | 160.405 | 161.402 | 7.6140 | 1.72% | 0.779 | — | N |
| standard-text (125,179 B) | kitoken | 0.11.0 | single | scalar | NDF | different | true | 5 | 153.475 | 157.422 | 175.06 | 8.62% | — | — | N |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | single | scalar | NDF | different | true | 3 | 131.787 | 157.532 | 159.02 | 9.57% | — | 20.98% / 9.57% | N |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 5 | 281.752 | 385.301 | 2939.7 | 19.24% | 1.784 | — | N |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 5 | 8.730 | 9.083 | 0.037100 | 2.21% | 18.487 | — | N |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 5 | 330.569 | 333.898 | 118.08 | 3.29% | 1.364 | — | N |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 5 | 8.323 | 9.719 | 1.4579 | 14.51% | 32.065 | — | N |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 142.734 | 153.040 | 258.00 | 11.25% | 0.876 | — | N |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 5 | 347.389 | 366.344 | 574.70 | 6.90% | 1.304 | — | N |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 3 | 180.204 | 182.585 | 25.573 | 2.81% | 0.794 | 6.50% / 2.81% | N |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 61.433 | 62.612 | 0.62203 | 1.28% | 8.184 | — | N |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 32.501 | 33.223 | 8.4647 | 8.95% | 4.966 | — | N |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 69.871 | 70.700 | 0.70653 | 1.20% | 6.455 | — | N |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 59.634 | 60.738 | 0.53226 | 1.22% | 4.475 | — | N |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 55.395 | 56.550 | 67.378 | 14.82% | 2.257 | — | N |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 57.547 | 57.959 | 0.35643 | 1.04% | 7.871 | — | N |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 3 | 49.858 | 53.733 | 4.6018 | 4.30% | 2.870 | 10.05% / 4.30% | N |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 146.859 | 148.835 | 4.1548 | 1.39% | 3.423 | — | N |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 101.183 | 101.675 | 3.3295 | 1.80% | 1.595 | — | N |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 196.382 | 198.944 | 6.7732 | 1.33% | 2.297 | — | N |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 151.876 | 152.843 | 2.2377 | 0.98% | 1.757 | — | N |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 137.616 | 145.692 | 11.993 | 2.52% | 0.908 | — | N |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 145.508 | 145.823 | 7.1873 | 1.84% | 3.113 | — | N |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | different | true | 3 | 128.361 | 136.742 | 18.545 | 3.35% | — | 7.59% / 3.35% | N |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | identical | true | 5 | 200.865 | 202.084 | 1.6001 | 0.63% | 2.503 | — | N |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | identical | true | 5 | 100.376 | 102.031 | 1.1170 | 1.05% | 1.608 | — | N |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | identical | true | 5 | 200.066 | 204.270 | 20.103 | 2.24% | 2.254 | — | N |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | identical | true | 5 | 147.463 | 148.399 | 1.8799 | 0.93% | 1.810 | — | N |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | identical | true | 5 | 194.323 | 197.715 | 5.5065 | 1.21% | 0.643 | — | N |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | identical | true | 5 | 196.324 | 198.042 | 96.516 | 5.00% | 2.307 | — | N |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | different | true | 3 | 205.481 | 207.659 | 2.2920 | 0.74% | — | 1.79% / 0.74% | N |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDF | identical | true | 5 | 9.188 | 9.349 | 0.043323 | 2.27% | 54.717 | — | N |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDF | identical | true | 5 | 7.545 | 7.686 | 0.020773 | 1.91% | 21.391 | — | N |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDF | identical | true | 5 | 9.280 | 9.345 | 0.047260 | 2.34% | 48.602 | — | N |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDF | identical | true | 5 | 8.376 | 8.865 | 0.051786 | 2.72% | 31.862 | — | N |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDF | identical | true | 5 | 8.646 | 8.861 | 0.44864 | 7.75% | 14.458 | — | N |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDF | identical | true | 5 | 8.761 | 9.173 | 0.99458 | 11.38% | 51.697 | — | N |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | single | scalar | NDF | identical | true | 3 | 8.788 | 8.964 | 0.036607 | 2.18% | 16.285 | 5.28% / 2.18% | N |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | NDF | identical | true | 5 | 502.757 | 515.751 | 689.80 | 5.22% | 1.000 | — | N |
| chinese (592,645 B) | hypertok | workspace | single | scalar | NDF | identical | true | 5 | 161.389 | 173.036 | 80.966 | 5.58% | 1.000 | — | N |
| source-code (11,150 B) | hypertok | workspace | single | scalar | NDF | identical | true | 5 | 451.035 | 455.634 | 119.20 | 2.42% | 1.000 | — | N |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | NDF | identical | true | 5 | 266.887 | 272.667 | 27.716 | 1.97% | 1.000 | — | N |
| long-document (738,046 B) | hypertok | workspace | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 125.003 | 138.046 | 448.73 | 16.95% | 1.000 | — | N |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | NDF | identical | true | 5 | 452.944 | 458.538 | 99.781 | 2.21% | 1.000 | — | N |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | NDF | identical | true | 3 | 143.109 | 145.416 | 1.5689 | 0.88% | 1.000 | 2.03% / 0.88% | N |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |

### Decode fresh — Node — o200k_base

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 405.914 | 420.760 | 4972.4 | 17.37% | 1.064 | — | N |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 44.734 | 54.735 | 48.442 | 15.56% | 1.087 | — | N |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 5 | 439.563 | 442.981 | 485.07 | 5.01% | 1.270 | — | N |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 5 | 16.146 | 18.635 | 3.1509 | 10.99% | 17.187 | — | N |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 5 | 154.395 | 288.761 | 6339.8 | 51.57% | 3.148 | — | N |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 358.601 | 383.731 | 4861.5 | 19.44% | 1.243 | — | N |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | NDF | different | true | 3 | 281.039 | 284.867 | 7.8555 | 1.00% | — | 2.44% / 1.00% | N |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 62.231 | 63.074 | 343.09 | 29.76% | 6.943 | — | N |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 47.153 | 50.750 | 24.086 | 10.41% | 1.032 | — | N |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 93.904 | 97.675 | 8.7323 | 3.15% | 5.946 | — | N |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 73.878 | 74.336 | 512.83 | 30.65% | 3.756 | — | N |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 48.913 | 50.992 | 1.9694 | 2.87% | 9.938 | — | N |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 52.534 | 56.652 | 185.12 | 25.90% | 8.485 | — | N |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | NDF | different | true | 3 | 39.118 | 40.545 | 6.2290 | 6.38% | — | 14.98% / 6.38% | N |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 154.868 | 158.766 | 93.670 | 6.25% | 2.790 | — | N |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 167.571 | 169.921 | 5.5453 | 1.41% | 0.290 | — | N |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 236.084 | 241.814 | 7.5320 | 1.16% | 2.365 | — | N |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 173.112 | 173.875 | 10.366 | 1.86% | 1.603 | — | N |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 144.229 | 144.641 | 7.9999 | 1.96% | 3.370 | — | N |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 5 | 146.456 | 147.338 | 14.939 | 2.64% | 3.044 | — | N |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | NDF | identical | true | 3 | 111.173 | 113.096 | 3.8782 | 1.77% | 3.302 | 4.31% / 1.77% | N |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | different | true | 5 | 203.912 | 217.060 | 196.16 | 6.87% | — | — | N |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | different | true | 5 | 170.822 | 171.661 | 19.055 | 2.56% | — | — | N |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | different | true | 5 | 246.160 | 251.129 | 39.213 | 2.54% | — | — | N |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | identical | true | 5 | 175.535 | 177.761 | 22.256 | 2.69% | 1.581 | — | N |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | different | true | 5 | 197.447 | 205.534 | 322.30 | 9.09% | — | — | N |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | different | true | 5 | 208.723 | 210.558 | 244.35 | 7.49% | — | — | N |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | NDF | different | true | 3 | 194.891 | 198.674 | 11.418 | 1.73% | — | 4.24% / 1.73% | N |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 432.042 | 580.227 | 12047 | 25.40% | 1.000 | — | N |
| chinese (592,645 B) | hypertok | workspace | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 48.648 | 50.603 | 54.656 | 15.20% | 1.000 | — | N |
| source-code (11,150 B) | hypertok | workspace | single | scalar | NDF | identical | true | 5 | 558.346 | 570.092 | 1752.5 | 7.50% | 1.000 | — | N |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | NDF | identical | true | 5 | 277.509 | 287.523 | 28.614 | 1.93% | 1.000 | — | N |
| long-document (738,046 B) | hypertok | workspace | single | scalar | NDF | identical | true | 5 | 486.091 | 561.459 | 12877 | 23.34% | 1.000 | — | N |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | NDF | identical | true | 11 (escalated 5→11) | 445.756 | 476.805 | 216.57 | 3.30% | 1.000 | — | N |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | NDF | identical | true | 3 | 367.059 | 400.087 | 537.26 | 6.31% | 1.000 | 15.39% / 6.31% | N |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | N |
| english-prose (152,089 B) | kitoken | 0.11.0 | — | — | NDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | kitoken | 0.11.0 | — | — | NDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | kitoken | 0.11.0 | — | — | NDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | — | — | NDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | kitoken | 0.11.0 | — | — | NDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | kitoken | 0.11.0 | — | — | NDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | — | — | NDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | N |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | — | — | NDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | N |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | NDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | N |

### Decode fresh — Chrome — gpt2

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDF | identical | true | 5 | 9.823 | 10.144 | 0.049092 | 2.26% | 41.564 | — | B |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDF | identical | true | 5 | 8.552 | 8.758 | 0.28484 | 6.24% | 14.230 | — | B |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDF | identical | true | 5 | 9.132 | 10.469 | 12.481 | 38.69% | 31.176 | — | B |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDF | identical | true | 5 | 9.774 | 10.474 | 1.1306 | 10.88% | 21.188 | — | B |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDF | identical | true | 5 | 9.465 | 10.200 | 0.19030 | 4.61% | 16.145 | — | B |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDF | identical | true | 5 | 9.827 | 10.304 | 0.34254 | 5.96% | 56.615 | — | B |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | single | scalar | BDF | identical | true | 3 | 10.399 | 10.436 | 0.36403 | 5.80% | 18.793 | 12.48% / 5.80% | B |
| english-prose (152,089 B) | kitoken | 0.11.0 | single | scalar | BDF | different | true | 5 | 139.852 | 144.503 | 121.04 | 7.87% | — | — | B |
| chinese (592,645 B) | kitoken | 0.11.0 | single | scalar | BDF | identical | true | 5 | 65.849 | 68.159 | 16.848 | 6.23% | 1.848 | — | B |
| source-code (11,150 B) | kitoken | 0.11.0 | single | scalar | BDF | identical | true | 5 | 156.950 | 161.205 | 45.120 | 4.28% | 1.814 | — | B |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | single | scalar | BDF | identical | true | 5 | 109.788 | 110.941 | 11.067 | 3.03% | 1.886 | — | B |
| long-document (738,046 B) | kitoken | 0.11.0 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 135.421 | 141.524 | 35.332 | 4.39% | 1.128 | — | B |
| standard-text (125,179 B) | kitoken | 0.11.0 | single | scalar | BDF | different | true | 5 | 141.179 | 141.712 | 3.3291 | 1.29% | — | — | B |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | single | scalar | BDF | different | true | 3 | 130.787 | 130.923 | 3.2363 | 1.38% | — | 2.97% / 1.38% | B |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 235.797 | 444.055 | 7344.1 | 36.34% | 1.732 | — | B |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 5 | 14.892 | 15.044 | 0.12693 | 2.39% | 8.171 | — | B |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 379.574 | 449.748 | 4907.6 | 18.46% | 0.750 | — | B |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 5 | 15.901 | 16.149 | 0.35176 | 3.73% | 13.024 | — | B |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 5 | 241.586 | 250.610 | 82.041 | 3.75% | 0.633 | — | B |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 5 | 441.808 | 455.196 | 124.77 | 2.53% | 1.259 | — | B |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 3 | 260.851 | 272.717 | 36.885 | 2.33% | 0.749 | 5.25% / 2.33% | B |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 68.819 | 70.987 | 7.7486 | 4.04% | 5.933 | — | B |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 35.308 | 35.691 | 0.68653 | 2.35% | 3.447 | — | B |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 82.593 | 83.235 | 0.17812 | 0.51% | 3.447 | — | B |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 61.191 | 65.195 | 92.767 | 15.74% | 3.384 | — | B |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 70.357 | 72.857 | 1.8328 | 1.92% | 2.172 | — | B |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 20.321 | 31.308 | 82.827 | 44.79% | 27.378 | — | B |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 3 | 53.026 | 55.882 | 1.8236 | 2.55% | 3.686 | 5.42% / 2.55% | B |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 124.663 | 129.713 | 22.435 | 3.80% | 3.275 | — | B |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 89.321 | 89.659 | 0.66428 | 0.91% | 1.362 | — | B |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 179.597 | 191.828 | 1276.4 | 19.89% | 1.585 | — | B |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 135.753 | 140.821 | 47.546 | 5.08% | 1.525 | — | B |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 127.030 | 132.148 | 86.475 | 7.32% | 1.203 | — | B |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 134.601 | 135.085 | 0.81186 | 0.67% | 4.133 | — | B |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | different | true | 3 | 123.831 | 124.265 | 1.4337 | 0.97% | — | 2.20% / 0.97% | B |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | identical | true | 5 | 181.599 | 191.910 | 145.41 | 6.64% | 2.248 | — | B |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | identical | true | 5 | 92.891 | 97.635 | 64.331 | 8.63% | 1.310 | — | B |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 189.787 | 193.913 | 129.94 | 6.01% | 1.500 | — | B |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | identical | true | 5 | 135.753 | 141.957 | 31.081 | 4.11% | 1.525 | — | B |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 187.559 | 192.199 | 36.313 | 3.21% | 0.815 | — | B |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | identical | true | 5 | 197.132 | 199.224 | 33.138 | 2.92% | 2.822 | — | B |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | different | true | 3 | 196.390 | 197.570 | 0.32398 | 0.29% | — | 0.63% / 0.29% | B |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDF | identical | true | 5 | 9.555 | 9.606 | 0.048110 | 2.30% | 42.732 | — | B |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDF | identical | true | 5 | 7.963 | 8.035 | 0.010318 | 1.28% | 15.282 | — | B |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDF | identical | true | 5 | 9.401 | 9.968 | 8.8245 | 31.60% | 30.282 | — | B |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDF | identical | true | 5 | 8.333 | 9.197 | 0.39515 | 7.54% | 24.851 | — | B |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDF | identical | true | 5 | 9.576 | 9.677 | 0.0061096 | 0.82% | 15.957 | — | B |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDF | identical | true | 5 | 9.660 | 9.747 | 0.44698 | 6.92% | 57.593 | — | B |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | single | scalar | BDF | identical | true | 3 | 9.959 | 10.100 | 0.26485 | 5.17% | 19.623 | 11.60% / 5.17% | B |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 408.293 | 620.771 | 10944 | 25.62% | 1.000 | — | B |
| chinese (592,645 B) | hypertok | workspace | single | scalar | BDF | identical | true | 5 | 121.693 | 134.083 | 56.550 | 6.18% | 1.000 | — | B |
| source-code (11,150 B) | hypertok | workspace | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 284.681 | 486.545 | 9954.1 | 35.05% | 1.000 | — | B |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | BDF | identical | true | 5 | 207.090 | 223.763 | 238.93 | 7.46% | 1.000 | — | B |
| long-document (738,046 B) | hypertok | workspace | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 152.805 | 170.057 | 868.38 | 19.28% | 1.000 | — | B |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | BDF | identical | true | 5 | 556.351 | 560.503 | 132.43 | 2.07% | 1.000 | — | B |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | BDF | identical | true | 3 | 195.435 | 200.989 | 33.409 | 2.96% | 1.000 | 7.19% / 2.96% | B |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |

### Decode fresh — Chrome — o200k_base

| Workload (bytes) | Reference | Version | Tier | SIMD | Clock | Status | Exact | n | Median | p95 | Variance | Noise | Ratio | Stability | Agreement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english-prose (152,089 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 511.224 | 596.427 | 8414.2 | 17.94% | 0.944 | — | B |
| chinese (592,645 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 58.245 | 69.682 | 110.33 | 18.03% | 0.832 | — | B |
| source-code (11,150 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 5 | 477.857 | 500.187 | 4119.6 | 13.43% | 1.333 | — | B |
| emoji-heavy (3,772 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 5 | 21.115 | 23.325 | 10.829 | 15.58% | 10.688 | — | B |
| long-document (738,046 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 490.396 | 536.761 | 6183.3 | 16.03% | 1.286 | — | B |
| standard-text (125,179 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 444.422 | 466.506 | 10954 | 23.55% | 0.587 | — | B |
| openwebtext-slice (50,000,000 B) | gpt-tokenizer | 3.4.0 | single | scalar | BDF | different | true | 3 | 377.202 | 380.778 | 2.9000 | 0.45% | — | 0.97% / 0.45% | B |
| english-prose (152,089 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 65.204 | 65.556 | 318.50 | 27.37% | 7.405 | — | B |
| chinese (592,645 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 56.658 | 57.566 | 2.8160 | 2.96% | 0.855 | — | B |
| source-code (11,150 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 24.086 | 28.378 | 13.856 | 15.45% | 26.452 | — | B |
| emoji-heavy (3,772 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 59.202 | 68.227 | 284.12 | 28.47% | 3.812 | — | B |
| long-document (738,046 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 62.388 | 66.133 | 271.52 | 26.41% | 10.111 | — | B |
| standard-text (125,179 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 65.999 | 66.232 | 0.63341 | 1.21% | 3.951 | — | B |
| openwebtext-slice (50,000,000 B) | js-tiktoken | 1.0.21 | single | scalar | BDF | different | true | 3 | 50.460 | 52.827 | 2.1811 | 2.93% | — | 7.04% / 2.93% | B |
| english-prose (152,089 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 134.295 | 136.098 | 66.863 | 6.09% | 3.595 | — | B |
| chinese (592,645 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 133.780 | 140.771 | 423.53 | 15.38% | 0.362 | — | B |
| source-code (11,150 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 221.157 | 223.933 | 4.9720 | 1.01% | 2.881 | — | B |
| emoji-heavy (3,772 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 158.108 | 159.060 | 1.8727 | 0.87% | 1.427 | — | B |
| long-document (738,046 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 119.328 | 124.146 | 13.779 | 3.11% | 5.286 | — | B |
| standard-text (125,179 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 5 | 132.231 | 134.360 | 0.81135 | 0.68% | 1.972 | — | B |
| openwebtext-slice (50,000,000 B) | @dqbd/tiktoken | 1.0.21 | single | scalar | BDF | identical | true | 3 | 109.698 | 109.963 | 4.9370 | 2.03% | 4.509 | 4.41% / 2.03% | B |
| english-prose (152,089 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | different | true | 5 | 204.834 | 206.222 | 101.02 | 4.91% | — | — | B |
| chinese (592,645 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | different | true | 5 | 161.045 | 163.039 | 411.60 | 12.60% | — | — | B |
| source-code (11,150 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | different | true | 5 | 261.073 | 266.269 | 11.039 | 1.27% | — | — | B |
| emoji-heavy (3,772 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | identical | true | 5 | 176.027 | 178.405 | 2.0801 | 0.82% | 1.282 | — | B |
| long-document (738,046 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | different | true | 5 | 199.742 | 200.012 | 0.95908 | 0.49% | — | — | B |
| standard-text (125,179 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | different | true | 5 | 204.652 | 213.373 | 33.812 | 2.84% | — | — | B |
| openwebtext-slice (50,000,000 B) | @goliapkg/tiktoken-wasm | 3.5.1 | single | scalar | BDF | different | true | 3 | 187.508 | 189.912 | 21.462 | 2.47% | — | 5.76% / 2.47% | B |
| english-prose (152,089 B) | hypertok | workspace | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 482.822 | 715.713 | 17242 | 27.20% | 1.000 | — | B |
| chinese (592,645 B) | hypertok | workspace | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 48.458 | 53.057 | 9.7189 | 6.43% | 1.000 | — | B |
| source-code (11,150 B) | hypertok | workspace | single | scalar | BDF | identical | true | 5 | 637.143 | 644.819 | 886.62 | 4.67% | 1.000 | — | B |
| emoji-heavy (3,772 B) | hypertok | workspace | single | scalar | BDF | identical | true | 5 | 225.675 | 231.614 | 121.28 | 4.88% | 1.000 | — | B |
| long-document (738,046 B) | hypertok | workspace | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 630.809 | 686.554 | 43327 | 33.00% | 1.000 | — | B |
| standard-text (125,179 B) | hypertok | workspace | single | scalar | BDF | identical | true | 11 (escalated 5→11) | 260.790 | 605.705 | 25223 | 60.90% | 1.000 | — | B |
| openwebtext-slice (50,000,000 B) | hypertok | workspace | single | scalar | BDF | identical | true | 3 | 494.609 | 494.780 | 840.85 | 5.86% | 1.000 | 12.45% / 5.86% | B |
| english-prose (152,089 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | @huggingface/tokenizers | 0.1.3 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @huggingface/tokenizers | — | 0 | — | — | — | — | — | — | B |
| english-prose (152,089 B) | kitoken | 0.11.0 | — | — | BDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | kitoken | 0.11.0 | — | — | BDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | kitoken | 0.11.0 | — | — | BDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | kitoken | 0.11.0 | — | — | BDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | kitoken | 0.11.0 | — | — | BDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | kitoken | 0.11.0 | — | — | BDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | kitoken | 0.11.0 | — | — | BDF | unavailable: Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact | — | 0 | — | — | — | — | — | — | B |
| english-prose (152,089 B) | @lenml/tokenizers | 3.7.2 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | @lenml/tokenizers | 3.7.2 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | @lenml/tokenizers | 3.7.2 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | @lenml/tokenizers | 3.7.2 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | @lenml/tokenizers | 3.7.2 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | @lenml/tokenizers | 3.7.2 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | @lenml/tokenizers | 3.7.2 | — | — | BDF | unavailable: No official o200k tokenizer.json is published for @lenml/tokenizers | — | 0 | — | — | — | — | — | — | B |
| english-prose (152,089 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| chinese (592,645 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| source-code (11,150 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| emoji-heavy (3,772 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| long-document (738,046 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| standard-text (125,179 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |
| openwebtext-slice (50,000,000 B) | tiktoken-wasm | — | — | — | BDF | unavailable: The exact bare npm package name returned E404 on 2026-07-30 | — | 0 | — | — | — | — | — | — | B |

## Carried-forward axes: transfer, construction, and resident memory

These axes come from the booked browser ledger at commit `c6c1cb9`, measured in local
cross-origin isolated Chrome 150 with gzip-as-served transfer and
`measureUserAgentSpecificMemory` residency. The product paths these axes measure did not
change between `c6c1cb9` and `b0c4bd0`. Both hashes identify states of the development
lineage; the published code for this run is tag `bench-2026-08-04`.

### First-tokenize transfer, gzip as served

| Reference | Vocabulary | Compressed transfer | Decompressed |
|---|---|---:|---:|
| @huggingface/tokenizers | gpt2 | 0.754 MB | 2.889 MB |
| kitoken | gpt2 | 1.706 MB | 5.318 MB |
| gpt-tokenizer | gpt2 | 0.211 MB | 0.575 MB |
| js-tiktoken | gpt2 | 0.236 MB | 0.557 MB |
| @dqbd/tiktoken | gpt2 | 0.803 MB | 1.979 MB |
| @goliapkg/tiktoken-wasm | gpt2 | 6.558 MB | 9.320 MB |
| @lenml/tokenizers | gpt2 | 0.612 MB | 1.828 MB |
| hypertok | gpt2 | 0.269 MB | 0.587 MB |
| gpt-tokenizer | o200k_base | 1.075 MB | 2.996 MB |
| js-tiktoken | o200k_base | 1.137 MB | 2.337 MB |
| @dqbd/tiktoken | o200k_base | 1.704 MB | 3.759 MB |
| @goliapkg/tiktoken-wasm | o200k_base | 6.558 MB | 9.320 MB |
| hypertok | o200k_base | 1.213 MB | 2.222 MB |

### Construction and resident memory

| Reference | Vocabulary | Construction median | Resident median |
|---|---|---:|---:|
| @huggingface/tokenizers | gpt2 | 84.7 ms | 19.1 MB |
| kitoken | gpt2 | 159.7 ms | 28.8 MB |
| gpt-tokenizer | gpt2 | 25.4 ms | 3.1 MB |
| js-tiktoken | gpt2 | 74.4 ms | 11.4 MB |
| @dqbd/tiktoken | gpt2 | 58.6 ms | 13.3 MB |
| @goliapkg/tiktoken-wasm | gpt2 | 103.5 ms | 47.7 MB |
| @lenml/tokenizers | gpt2 | 112.1 ms | 13.9 MB |
| hypertok | gpt2 | 114.2 ms | 20.2 MB |
| gpt-tokenizer | o200k_base | 86.6 ms | 12.8 MB |
| js-tiktoken | o200k_base | 325.1 ms | 45.7 MB |
| @dqbd/tiktoken | o200k_base | 137.5 ms | 37.0 MB |
| @goliapkg/tiktoken-wasm | o200k_base | 164.4 ms | 67.3 MB |
| hypertok | o200k_base | 243.8 ms | 51.2 MB |

## Source manifest

| Artifact | Axis | Environment | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| node-agreement.json | agreement | node | 93488 | 13b2daec6a941712a232a8ea0415c25176becf05cbbca5d34a7a8241969e56e3 |
| browser-agreement.json | agreement | browser | 93736 | 94c9cf8454b231fb57dfdb2d843436b9eef05a859ad2b571a281fc325f729274 |
| node-encode.json | encode | node | 185289 | 4089ea43a07771c4af7dadb90a18fe9865458c7e218a0c15c6e4c9cc68127d86 |
| browser-encode.json | encode | browser | 186555 | 48fcccc4bbab556f33f478ea4c0271a00a03f88b59e6593879b7d4050b6cb1e4 |
| node-decode.json | decode | node | 397578 | 5e7e8b686f7ccd8295b5de45a8c8bcce73c09d9f55a4c2146b375e3decc23c04 |
| browser-decode.json | decode | browser | 399804 | bba6db8a67c03f94c8c41243c4683b02adf41a79b183081c6bd8b3b4341baf66 |

Manifest SHA-256: `916610267f575896227ff184ae8f4bba638f481ea26ea47860b5d2eafd51434e`.

Reconciliation: **PASS — 756/756 performance rows rendered; 6/6 manifest-listed artifact hashes and byte sizes verified before generation.**

