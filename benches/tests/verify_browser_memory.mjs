import assert from "node:assert/strict";
import {
  cdpResidentBytes,
  measureBrowserMemory,
} from "../browser/memory_measurement.mjs";

const directPage = {
  evaluate: async (operation) =>
    operation.toString().includes("globalThis.gc") ? undefined : { bytes: 120 },
  context: () => {
    throw new Error("CDP must remain dormant when the browser API succeeds");
  },
};
assert.deepEqual(await measureBrowserMemory(directPage), {
  bytes: 120,
  method: "measureUserAgentSpecificMemory",
  details: { bytes: 120 },
});

const commands = [];
let detached = false;
const fallbackPage = {
  evaluate: async (operation) => {
    if (operation.toString().includes("globalThis.gc")) return undefined;
    throw new Error("measureUserAgentSpecificMemory is not available");
  },
  context: () => ({
    newCDPSession: async () => ({
      send: async (command) => {
        commands.push(command);
        if (command === "Runtime.getHeapUsage") {
          return { usedSize: 10, embedderHeapUsedSize: 20, backingStorageSize: 30 };
        }
        return {};
      },
      detach: async () => {
        detached = true;
      },
    }),
  }),
};
assert.deepEqual(await measureBrowserMemory(fallbackPage), {
  bytes: 60,
  method: "cdp-runtime-heap-usage",
  details: { usedSize: 10, embedderHeapUsedSize: 20, backingStorageSize: 30 },
});
assert.deepEqual(commands, ["HeapProfiler.collectGarbage", "Runtime.getHeapUsage"]);
assert.equal(detached, true);

assert.equal(cdpResidentBytes({ usedSize: 10 }), 10);
assert.throws(() => cdpResidentBytes({ usedSize: -1 }), /non-negative/);
assert.notEqual(
  cdpResidentBytes({ usedSize: 11, embedderHeapUsedSize: 20, backingStorageSize: 30 }),
  60,
);

await assert.rejects(
  measureBrowserMemory({
    evaluate: async (operation) => {
      if (operation.toString().includes("globalThis.gc")) return undefined;
      throw new Error("unexpected browser failure");
    },
  }),
  /unexpected browser failure/,
);

console.log("browser memory methods PASS (direct and CDP fallback)");
console.log("browser memory mutations RED (component and unrelated-error controls)");
