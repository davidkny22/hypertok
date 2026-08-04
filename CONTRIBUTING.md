# Contributing

We love contributions. If something in hypertok is slow, wrong, or unreachable, we want
it dead, and we'd love the kill to be yours.

## What we welcome

Welcome outright, open a PR directly:

- correctness fixes of any size
- anything that makes hypertok faster or more efficient, anywhere, with receipts (see
  Performance changes)
- fixes for behavioral reachability: a documented configuration or behavior that cannot
  actually be reached through the public API
- new vocabularies with a published, pinned source and a clean license
- documentation fixes

Discuss first, in an issue, before writing code:

- public API changes
- format changes
- anything touching published performance claims or the shipped feature graph

One exception we're leaving open on purpose: if your discuss-first idea meaningfully improves
the experience while preserving behavior for every existing user, make that case in the
issue and we will bump it up in our queue.

Closed by policy: pure refactors, large-scale reformatting not requested by a maintainer, and style. Change as few lines as
possible. Do not touch files needlessly. A narrow diff is far easier for us to review
and approve.

Maintainers may close issues and PRs that are not useful or productive, without
extended explanation.

## AI-assisted and AI-authored contributions

hypertok was built by AI agents under human direction, so this project judges work,
not authorship. AI-authored, AI-assisted, and hand-written contributions face the
identical bar: gates green, receipts real, and claims reproducible. You remain responsible
for everything you submit, and you must be able to explain and defend the change during
review, whoever or whatever wrote it. We appreciate a note in the PR description about
what you did versus what your tools did, but this is a courtesy we value, not a
requirement. Unverified claims, failing gates, and template boilerplate get closed
regardless of how they were produced.

## Before opening an issue

Search existing issues and PRs, and reduce the report to one vocabulary, one input, and one
execution tier when possible. Correctness reports must include:

- the exact vocabulary package or source revision
- the input as text or reproducible bytes
- expected and actual token IDs
- runtime, browser, operating system, and tier
- a minimal command or repository that reproduces the result

Performance reports must name the workload, reference implementation and version, tier,
SIMD level, clock regime, warmup, sample count, median, p95, and variance. Agreement
must be established before throughput is compared.

## Pull requests

Keep changes narrow and outsider-legible. New upstream-core capability must be additive
and preserve the existing default behavior. New tokenizer behavior must be declared and
refused when unsupported, never approximated.

The public gate ladder is the acceptance contract. Run the profiles that own the
behavior you changed, then record the commands and results in the pull request:

```powershell
./tests/run.ps1 quick
./tests/run.ps1 correctness
./tests/run.ps1 release
./tests/run.ps1 mutation
npm.cmd --prefix benches run benchmark:smoke
```

`quick` owns unit, type, and structural-class behavior. `correctness` owns cross-crate
and browser behavior. `release` owns the installed package, demo, attribution, budgets,
and shipped graph. `mutation` proves the affected verifier turns red for a behavioral
fault. `benchmark:smoke` owns public harness changes and reference reachability.

The PowerShell entrypoint is the current release orchestrator. Its Rust and Node
commands remain directly runnable from `tests/suites/manifest.json` on other operating
systems.

Add focused negative tests for every new assumption. Durable tests assert observable
behavior, refusal, compatibility, or graph safety. They do not freeze source text, file
inventories, local evidence, or implementation layout.

## Performance changes

Two stages, so nobody needs our hardware to contribute:

1. Your PR carries smoke receipts: `benchmark:smoke` plus a focused before-and-after
   measurement of the path you touched, with the configuration and commit stated.
   Every measurement goes through the packaged public runtime, the same entry point a
   user calls. A number measured through a private construction proves nothing here.
2. Acceptance hangs on the full adjudication: the complete benchmark matrix runs via CI
   against your change, and the composed result decides. A change that wins its target
   in isolation but regresses the composed configuration will not be accepted. A small
   local regression inside a larger composed gain might be.

Do not include generated benchmark numbers without the raw run, full configuration,
agreement evidence, and commit hash.

## Correctness receipts

Exactness is the product. Any change that can touch token output carries a round-trip
receipt: the correctness profile green, plus agreement against the pinned reference for
every affected vocabulary, byte for byte. A performance win that costs one token of
exactness is a bug, not a tradeoff.

## Commits

Conventional commits with a scope, on every commit: `fix(decode): ...`, `perf(scanner): ...`,
`docs(readme): ...`. The body is compact, descriptive, and machine-readable: what
changed and why, legible to an outsider without project context. No AI co-authorship
trailers of any kind in the commit itself: no `Co-authored-by` for tools, no
`Assisted-by`, no generated-with stamps. The PR description's Notes section is where
tooling remarks live. Commit history stays about the change.

## Scope and attribution

Preserve the attribution and non-endorsement language in NOTICE. Vocabulary source
licenses and notices must remain attached to their packages. If a change imports a
mechanism from another project or paper, name the source and explain what is adopted
and what differs. Do not publish packages, file upstream issues, or create releases
from a contribution branch.
