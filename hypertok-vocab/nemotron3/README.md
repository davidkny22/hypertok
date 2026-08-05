# @hypertok/vocab-nemotron3

NVIDIA Nemotron 3's byte-level BPE vocabulary encoded as one self-verifying HTK format version 1
file.

```js
import { vocabulary } from "@hypertok/vocab-nemotron3";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The Nemotron 3 vocabulary covers NVIDIA Nemotron 3 Nano models and tokenizer-compatible
derivatives.

The @hypertok/vocab-nemotron3 package contains vocabulary data and metadata only. It has no
runtime or core dependency. Redistribution is governed by the NVIDIA Nemotron Open Model License
in `LICENSE`; see `NOTICE` for the pinned source identity and required attribution.
