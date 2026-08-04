# @hypertok/vocab-kimi-k3

Kimi K3 encoded as one self-verifying HTK format version 1 file.

```js
import { vocabulary } from "@hypertok/vocab-kimi-k3";

const response = await fetch(vocabulary);
const bytes = new Uint8Array(await response.arrayBuffer());
```

The @hypertok/vocab-kimi-k3 package contains vocabulary data and metadata only. It has no runtime
or core dependency. The Kimi K3 License contains additional conditions. Read `LICENSE` before use
or redistribution. See `NOTICE` for the pinned source identity and attribution.
