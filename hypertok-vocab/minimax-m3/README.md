# @hypertok/vocab-minimax-m3

**Built with MiniMax M3**

MiniMax M3's byte-level BPE vocabulary encoded as one self-verifying HTK format version 1 file.

```js
import { vocabulary } from "@hypertok/vocab-minimax-m3";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The MiniMax M3 vocabulary covers MiniMax M3 models and tokenizer-compatible derivatives.

The @hypertok/vocab-minimax-m3 package contains vocabulary data and metadata only. It has no
runtime or core dependency. Redistribution is governed by the MiniMax Community License in
`LICENSE`; see `NOTICE` for the pinned source identity and attribution.
