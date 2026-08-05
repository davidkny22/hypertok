# hypertok benchmark harness

The harness measures the checked-in corpus against every registered reference in Node and an
isolated Chrome session for both GPT-2 and o200k. Agreement runs before timing for each vocabulary.
Each timing report carries the agreement key and the identities of its commit, package lock, corpus,
vocabulary artifacts, environment, and reference registry.

## Requirements

- Node 22 or newer
- Google Chrome or Chromium
- Rust and `wasm-bindgen` for artifact rebuilds and native decomposition
- PowerShell for the native decomposition command

Install the exact JavaScript dependency graph from this directory:

```powershell
npm ci
```

Chrome is discovered from standard locations on Windows, macOS, and Linux. Set an explicit path
when discovery does not match the browser under test:

```powershell
$env:HYPERTOK_CHROME_PATH = "C:\path\to\chrome.exe"
```

The umbrella command also accepts `--chrome <path>`.

## Commands

Run the harness contract tests:

```powershell
npm test
```

Run the complete arena with one sample per measurement. This proves orchestration and schemas. Its
rows carry `profile: "arena"` and `mode: "smoke"`. Smoke values are not production
characterization.

```powershell
npm run benchmark:smoke
```

Run the canonical arena benchmark:

```powershell
npm run benchmark
```

The canonical benchmark starts each ordinary throughput row at five samples. It evaluates each
agreeing reference ratio independently for that vocabulary, workload, environment, and decode
regime. When the absolute log throughput gap is smaller than twice the root-sum-square relative
standard deviation, hypertok and that unresolved reference extend to eleven samples. OpenWebText
uses three samples and reports its minimum, maximum, relative range, and relative standard
deviation instead of escalating. Every reported ratio carries the subject noise, reference noise,
combined noise, gap, threshold, and resolution decision.

Both benchmark commands validate the pinned model and corpus, exercise the timer and axis
self-checks, then establish agreement before encode and both decode regimes in Node and isolated
Chrome. Transfer, decompression, materialisation, and memory retain their booked rows while those
product paths are unchanged. Their leaf commands remain available and must be rerun when a change
touches the corresponding path.

Measure cross-session clock drift for the hypertok subject before a full arena run. The command
uses three fresh Node processes and three fresh isolated Chrome lifetimes, with 21 samples at 4 MiB
per workload in each session. Set `HYPERTOK_CONTAINER_IDENTITY` to the qualification record when it
is not at `results/harness/container-identity.json`.

```powershell
npm run measure:stationarity
```

The shipping profile measures native scalar, native vector, WebAssembly scalar, WebAssembly SIMD,
chunked, unchunked, and the pinned gigatoken reference across all ten arena and script-stress
workloads. It also measures paired tiktoken and Hugging Face adapter overhead in isolated Chrome
across the six arena workloads. It requires the source ranks because the upstream reference
consumes that format. Fetch the pinned source and verify its digest before running:

```powershell
Invoke-WebRequest `
  https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken `
  -OutFile C:\path\to\o200k_base.tiktoken
(Get-FileHash C:\path\to\o200k_base.tiktoken -Algorithm SHA256).Hash.ToLowerInvariant()
# expected: 446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d

npm run benchmark:shipping:smoke -- --source-ranks C:\path\to\o200k_base.tiktoken
npm run benchmark:shipping -- --source-ranks C:\path\to\o200k_base.tiktoken
```

The tracked o200k HTK package is the default runtime input. Pass `--htk <path>` only to measure a
different digest-checked copy. The shipping command requires Windows PowerShell, stable Rust,
nightly-2025-11-15, `wasm32-unknown-unknown`, and `wasm-bindgen`.

## Results

Each benchmark command writes one run beneath
`results/benchmark-runs/<run-key>/<session>/`. The run key binds the profile, mode, commit, package
lock, corpus, model, and reference registry. The session groups Node and browser results from one
command. `manifest.json` records every result file's byte length, SHA-256 digest, artifact digest,
and environment-specific run identity. Existing leaf commands also retain their established result
paths for compatibility.

Every available encode or decode row contains:

- vocabulary
- workload and byte count
- reference and exact version
- environment, tier, SIMD level, and clock regime
- sample count, median, p95, variance, relative noise, units, and ratio
- the initial and final sample counts plus whether uncertainty triggered escalation
- comparison noise and its resolution threshold beside every comparable ratio
- per-run stability for OpenWebText rows
- profile, mode, commit, and agreement key

A ratio exists only when the reference emits the same token ids as the oracle on that workload.
Different output remains measured and labelled, with `ratio: null`. An unavailable reference keeps
its exact reason.

Load reports keep transfer, decompression, materialisation, and resident memory separate. Run
`npm run measure:node:load`, `npm run measure:browser:load`, and
`npm run measure:browser:transfer-size` when those paths change. Browser runs record the resolved
executable, browser version, cross-origin isolation, and local-request count.

`npm run measure:browser:transfer-size` records the compressed browser transfer needed to first
tokenize for every available reference and vocabulary. Each self-contained ESM payload includes
the package code, vocabulary data, and required wasm, is served with HTTP gzip content encoding,
and is imported in a fresh isolated page before a one-character encode probe. The report records
exact package versions, gzip body bytes, decoded module bytes, method, and unavailable references.

## Corpus and references

`corpus/manifest.json` fixes seven arena workloads by byte count and SHA-256. The OpenWebText row
uses a deterministic 50,000,000-byte slice of Stanford CS336's pinned `owt_train` sample. Its
`<|endoftext|>` document separators become newlines so every reference receives ordinary text
under one agreement contract. Reproduce the checked-in gzip payload with:

```powershell
node tools/acquire_openwebtext_slice.mjs --force
```

The reference registry
lives in `common/reference_registry.mjs`; Node and browser adapters consume the same records and
record availability per vocabulary. The bare `tiktoken-wasm` package remains an unavailable record
because its exact npm name returned E404. The installed `@goliapkg/tiktoken-wasm` implementation is
measured under its own package and version. A measured row that disagrees with its vocabulary's
oracle remains visible without a ratio.

The public harness welcomes corrections that make a reference use a faster documented
configuration without changing its output contract.
