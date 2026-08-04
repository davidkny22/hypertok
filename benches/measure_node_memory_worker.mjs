import { createNodeAdapter } from "./adapters/node.mjs";

const [reference, vocabulary = "gpt2"] = process.argv.slice(2);
if (reference === undefined) {
  throw new Error("usage: measure_node_memory_worker.mjs <reference> <vocabulary>");
}
if (typeof globalThis.gc !== "function") {
  throw new Error("Node memory worker requires --expose-gc");
}

globalThis.gc();
const before = process.memoryUsage();
const adapter = await createNodeAdapter(reference, vocabulary);
adapter.encode("x");
globalThis.gc();
const after = process.memoryUsage();

process.stdout.write(
  `${JSON.stringify({
    reference: adapter.id,
    vocabulary: adapter.vocabulary,
    referenceVersion: adapter.version,
    residentDelta: after.rss - before.rss,
    totalRss: after.rss,
    baselineRss: before.rss,
    heapUsedDelta: after.heapUsed - before.heapUsed,
    externalDelta: after.external - before.external,
    arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
  })}\n`,
);
adapter.dispose();
