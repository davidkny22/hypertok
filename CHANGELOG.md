# Changelog

All notable public changes are recorded here.

## 0.3.4

- Verify CDN-fetched vocabulary bytes against their pinned SHA-256 metadata and raise a typed
  integrity error on mismatch.
- Add real Deno CLI coverage for public construction and exact encode-decode round trips.
- Add a default test command, private vulnerability reporting guidance and executable migration
  examples for the supported compatibility shims.
- Declare the intentional ESM-only and binary-asset findings in package type audits.

## 0.3.3

- Fixed tiktoken and Hugging Face shim construction when automatic selection uses a worker or
  shared tier by binding each trusted public handle to its existing resident single view.
- Added real Bun coverage for both synchronous shims and registration mutation coverage for the
  public-to-resident association.

## 0.3.2

- Fixed default WebAssembly loading in Cloudflare Workers and Vercel Edge through package-owned
  static module imports selected by each runtime's package condition.
- Added real Wrangler/workerd and Next.js/Turbopack edge regression coverage for bare
  `fromBytes(bytes)` initialization.

## 0.3.1

- Fixed Cloudflare Workers initialization when the bundled module has no `import.meta.url` and the
  caller supplies a compiled WebAssembly module.
- Added real workerd coverage with and without the `nodejs_compat` compatibility flag.

## 0.3.0

- Added caller-supplied WebAssembly module or byte loading for edge bundlers.
- Added a local-first vocabulary resolver with pinned jsDelivr fallback and bounded timeouts.
- Exported the single-tier WebAssembly asset for static bundler resolution.
- Removed non-runtime WebAssembly name and producer metadata from shipped artifacts.

## 0.2.2

- Added the additive HTK format-v1 cl100k named-pattern identifier and runtime routing.
- Added exact conversion of the Llama-class byte-BPE `Sequence` postprocessor.
- Added independently verified cl100k_base and Meta Llama 3 vocabulary packages.
- Fixed worker lifecycle failures leaving pending calls unsettled, and decode memo
  capacity thrash on very large repeated containers.
- Added exhaustive whitespace-classifier and route-equivalence gates: every scanner
  path is verified against the canonical Unicode White_Space set across all
  1,112,064 scalar values.
- Adopted OpenAI's tiktoken implementation as the benchmark oracle for
  tiktoken-format vocabularies.

## 0.1.0

- Added the validated HTK vocabulary format and bidirectional converter.
- Added exact byte-BPE and SentencePiece loading from HTK bytes.
- Added single, worker, and shared browser execution tiers for byte-BPE vocabularies.
- Added the root JavaScript API and separate tiktoken and Hugging Face compatibility entry points.
- Added five independently packaged launch vocabularies.
- Added the static tokenizer demo and unified browser and Node benchmark harness.
- Added clean-install, packaging, parity, refusal, mutation, and release verification.
