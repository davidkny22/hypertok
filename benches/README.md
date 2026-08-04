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

Run the complete arena at the registered sample counts:

```powershell
npm run benchmark
```

Both benchmark commands validate the pinned model and corpus, exercise the timer and axis
self-checks, then run agreement before encode, decode, load, and resident-memory measurements in
Node and isolated Chrome.

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
- sample count, median, p95, variance, units, and ratio
- profile, mode, commit, and agreement key

A ratio exists only when the reference emits the same token ids as the oracle on that workload.
Different output remains measured and labelled, with `ratio: null`. An unavailable reference keeps
its exact reason.

Load reports keep transfer, decompression, materialisation, and resident memory separate. Browser
runs record the resolved executable, browser version, cross-origin isolation, and local-request
count.

## Corpus and references

`corpus/manifest.json` fixes six arena workloads by byte count and SHA-256. The reference registry
lives in `common/reference_registry.mjs`; Node and browser adapters consume the same records and
record availability per vocabulary. The bare `tiktoken-wasm` package remains an unavailable record
because its exact npm name returned E404. The installed `@goliapkg/tiktoken-wasm` implementation is
measured under its own package and version. A measured row that disagrees with its vocabulary's
oracle remains visible without a ratio.

The public harness welcomes corrections that make a reference use a faster documented
configuration without changing its output contract.
