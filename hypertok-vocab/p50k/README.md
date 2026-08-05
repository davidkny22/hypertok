# @hypertok/vocab-p50k

OpenAI `p50k_base` and `p50k_edit` encoded as self-verifying HTK format version 1 files.

```js
import { vocabulary, editVocabulary } from "@hypertok/vocab-p50k";

const baseBytes = new Uint8Array(await (await fetch(vocabulary)).arrayBuffer());
const editBytes = new Uint8Array(await (await fetch(editVocabulary)).arrayBuffer());
```

`vocabulary` is `p50k_base`. `editVocabulary` uses the same mergeable ranks with the
`p50k_edit` fill-in-the-middle special tokens.

The p50k family covers Codex-era code models, edit models, and research baselines that use the
50,000-rank OpenAI byte-BPE vocabulary.

The @hypertok/vocab-p50k package contains vocabulary data and metadata only. It has no runtime or
core dependency. See `NOTICE` for the pinned source identity and attribution.
