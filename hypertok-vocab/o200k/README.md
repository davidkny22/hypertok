# @hypertok/vocab-o200k

OpenAI `o200k_base` encoded as one self-verifying HTK format version 1 file.

```js
import { vocabulary } from "@hypertok/vocab-o200k";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The @hypertok/vocab-o200k package contains vocabulary data and metadata only. It has no runtime or
core dependency. See `NOTICE` for the pinned source identity and attribution.
