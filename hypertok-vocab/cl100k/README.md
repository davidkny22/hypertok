# @hypertok/vocab-cl100k

OpenAI `cl100k_base` encoded as one self-verifying HTK format version 1 file.

```js
import { vocabulary } from "@hypertok/vocab-cl100k";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The cl100k family covers GPT-3.5 and GPT-4 era models and the `text-embedding-ada-002`
embedding line.

The @hypertok/vocab-cl100k package contains vocabulary data and metadata only. It has no runtime
or core dependency. See `NOTICE` for the pinned source identity and attribution.
