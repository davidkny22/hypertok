import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserOutputDirectory,
  buildBrowserBundle,
  referencePayloads,
} from "../browser/build.mjs";
import { launchHarnessBrowser, observeRequests } from "../browser/control.mjs";
import {
  disposeReferencePayload,
  loadReferencePayload,
} from "../browser/payload_measurement.mjs";
import { startHarnessServer } from "../browser/server.mjs";

await buildBrowserBundle();
const server = await startHarnessServer();
const { browser } = await launchHarnessBrowser();
const measurements = [];

try {
  for (const { slug, reference, vocabulary } of referencePayloads) {
    const page = await browser.newPage();
    const requests = observeRequests(page);
    try {
      await page.goto(`${server.origin}/blank`, { waitUntil: "load" });
      const measurement = await loadReferencePayload(page, server.origin, slug, vocabulary);
      const bundlePath = path.join(browserOutputDirectory, "references", `${slug}.mjs`);
      const compressedPath = `${bundlePath}.gz`;
      assert.equal(measurement.reference, reference);
      assert.equal(measurement.vocabulary, vocabulary);
      assert.equal(measurement.decompressedBytes, fs.statSync(bundlePath).size);
      assert.equal(measurement.compressedBytes, fs.statSync(compressedPath).size);
      assert.ok(measurement.probeIds.length > 0);
      assert.ok(measurement.transferMilliseconds >= 0);
      assert.ok(measurement.decompressionMilliseconds >= 0);
      assert.ok(measurement.materialisationMilliseconds >= 0);
      requests.assertLocal(server.origin);
      measurements.push(measurement);
      await disposeReferencePayload(page);
    } finally {
      await page.close();
    }
  }

  console.log(`reference payloads PASS (${measurements.length}/${referencePayloads.length})`);
  for (const measurement of measurements) {
    console.log(
      `${measurement.reference}: gzip=${measurement.compressedBytes}; module=${measurement.decompressedBytes}; transfer=${measurement.transferMilliseconds.toFixed(3)} ms; decompression=${measurement.decompressionMilliseconds.toFixed(3)} ms; materialisation=${measurement.materialisationMilliseconds.toFixed(3)} ms`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
