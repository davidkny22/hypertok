# @hypertok/vocab-gpt2

GPT-2 encoded as one self-verifying HTK format version 1 file.

GPT-2 is the comparability standard for r50k-era models and research baselines.

```js
import { vocabulary } from "@hypertok/vocab-gpt2";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The @hypertok/vocab-gpt2 package contains vocabulary data and metadata only. It has no runtime or
core dependency. See `NOTICE` for the pinned source identity, license record, and attribution.
