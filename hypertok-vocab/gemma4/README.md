# @hypertok/vocab-gemma4

Google Gemma 4's SentencePiece-style BPE vocabulary encoded as one self-verifying HTK format
version 1 file.

```js
import { vocabulary } from "@hypertok/vocab-gemma4";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The Gemma 4 vocabulary covers Google's Gemma 4 family and tokenizer-compatible derivatives.

The @hypertok/vocab-gemma4 package contains vocabulary data and metadata only. It has no runtime
or core dependency. See `NOTICE` for the pinned source identity and attribution.
