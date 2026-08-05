# @hypertok/vocab-glm5-2

Z.ai GLM-5.2's byte-level BPE vocabulary encoded as one self-verifying HTK format version 1 file.

```js
import { vocabulary } from "@hypertok/vocab-glm5-2";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The GLM-5.2 vocabulary covers Z.ai GLM-5.2 models and tokenizer-compatible derivatives.

The @hypertok/vocab-glm5-2 package contains vocabulary data and metadata only. It has no runtime
or core dependency. See `NOTICE` for the pinned source identity and attribution.
