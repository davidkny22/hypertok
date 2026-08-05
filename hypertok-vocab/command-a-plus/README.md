# @hypertok/vocab-command-a-plus

Cohere Command A+'s byte-level BPE vocabulary encoded as one self-verifying HTK format version 1
file.

```js
import { vocabulary } from "@hypertok/vocab-command-a-plus";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The Command A+ vocabulary covers Cohere Command A+ and tokenizer-compatible derivatives.

The @hypertok/vocab-command-a-plus package contains vocabulary data and metadata only. It has no
runtime or core dependency. See `NOTICE` for the pinned source identity and attribution.
