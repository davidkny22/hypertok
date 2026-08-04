import assert from "node:assert/strict";
import { buildBrowserBundle, referencePayloads } from "../browser/build.mjs";
import { loadReferencePayload } from "../node/payload_measurement.mjs";

await buildBrowserBundle();
const measurements = [];
for (const { slug, reference, vocabulary } of referencePayloads) {
  const { adapter, measurement } = await loadReferencePayload(slug, vocabulary);
  try {
    assert.equal(measurement.reference, reference);
    assert.equal(measurement.vocabulary, vocabulary);
    assert.ok(measurement.probeIds.length > 0);
    assert.equal(adapter.decode(adapter.encode("x")), "x");
    assert.ok(measurement.compressedBytes > 0);
    assert.ok(measurement.decompressedBytes > measurement.compressedBytes);
    assert.ok(measurement.transferMilliseconds >= 0);
    assert.ok(measurement.decompressionMilliseconds >= 0);
    assert.ok(measurement.materialisationMilliseconds >= 0);
    measurements.push(measurement);
  } finally {
    adapter.dispose();
  }
}

console.log(`Node reference payloads PASS (${measurements.length}/${referencePayloads.length})`);
for (const measurement of measurements) {
  console.log(
    `${measurement.reference}: gzip=${measurement.compressedBytes}; module=${measurement.decompressedBytes}; transfer=${measurement.transferMilliseconds.toFixed(3)} ms; decompression=${measurement.decompressionMilliseconds.toFixed(3)} ms; materialisation=${measurement.materialisationMilliseconds.toFixed(3)} ms`,
  );
}
