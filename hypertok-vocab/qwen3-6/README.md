# @hypertok/vocab-qwen3-6

Qwen 3.6 encoded as one self-verifying HTK format version 1 file.

```js
import { vocabulary } from "@hypertok/vocab-qwen3-6";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The @hypertok/vocab-qwen3-6 package contains vocabulary data and metadata only. It has no runtime
or core dependency. See `NOTICE` for the pinned source identity and attribution.
