import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserBundle } from "../browser/build.mjs";
import { launchHarnessBrowser, observeRequests } from "../browser/control.mjs";
import { startHarnessServer } from "../browser/server.mjs";
import { availableReferencesForVocabulary } from "../common/reference_registry.mjs";
import { vocabularyRegistry } from "../common/vocabularies.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await buildBrowserBundle();
const server = await startHarnessServer();
const { browser } = await launchHarnessBrowser();
const page = await browser.newPage();
const requests = observeRequests(page);

try {
  await page.goto(server.origin, { waitUntil: "load" });
  await page.evaluate(() => globalThis.harnessReady);
  const probe = await page.evaluate(() => globalThis.harness.probeAdapters());

  assert.equal(probe.crossOriginIsolated, true);
  const expectedPairs = vocabularyRegistry.flatMap(({ id: vocabulary }) =>
    availableReferencesForVocabulary(vocabulary).map(({ id: reference }) =>
      `${vocabulary}\u0000${reference}`,
    ),
  );
  assert.deepEqual(
    new Set(probe.rows.map(({ vocabulary, reference }) => `${vocabulary}\u0000${reference}`)),
    new Set(expectedPairs),
  );
  assert.ok(probe.rows.every(({ status }) => status === "identical"));
  assert.ok(probe.rows.every(({ decodeExact }) => decodeExact));
  const requestProof = requests.assertLocal(server.origin);

  console.log(`browser adapter agreement PASS (${probe.rows.length}/${expectedPairs.length} available probe rows)`);
  console.log(`browser adapter decode PASS (${probe.rows.length}/${probe.rows.length} exact)`);
  console.log("cross-origin isolated clock PASS");
  console.log(`local-only requests PASS (${requestProof.requestCount}/${requestProof.requestCount})`);
  console.log(`bundle directory: ${path.relative(benchesDirectory, path.join(benchesDirectory, "..", "results", "harness", "browser"))}`);
} finally {
  await page.close();
  await browser.close();
  await server.close();
}
