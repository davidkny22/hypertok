# @hypertok/vocab-llama3

**Built with Meta Llama 3**

The Meta Llama 3 family tokenizer encoded as one self-verifying HTK format version 1 file.

```js
import { vocabulary } from "@hypertok/vocab-llama3";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The Llama 3 family vocabulary covers Meta Llama 3 models and tokenizer-compatible derivatives.

The @hypertok/vocab-llama3 package contains vocabulary data and metadata only. It has no runtime
or core dependency. Redistribution is governed by the Meta Llama 3 Community License in
`LICENSE`; see `NOTICE` for the pinned mirror and upstream identities and required attribution.
