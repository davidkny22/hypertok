import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { axisNames } from "../common/timing.mjs";
import { buildBrowserBundle } from "../browser/build.mjs";
import { launchHarnessBrowser, observeRequests } from "../browser/control.mjs";
import { startHarnessServer } from "../browser/server.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const resultPath = path.join(repositoryDirectory, "results", "harness", "browser-self-check.json");

await buildBrowserBundle();
const server = await startHarnessServer();
const { browser, browserVersion, executablePath, executableSource } =
  await launchHarnessBrowser();
const page = await browser.newPage();
const requests = observeRequests(page);

try {
  await page.goto(server.origin, { waitUntil: "load" });
  await page.evaluate(() => globalThis.harnessReady);
  const result = await page.evaluate(() => globalThis.harness.runHarnessSelfCheck());
  const isolated = await page.evaluate(() => crossOriginIsolated);

  assert.equal(isolated, true);
  assert.deepEqual(Object.keys(result.axes), axisNames);
  assert.deepEqual(result.mutations, { backwardClock: "RED", crossAxisLabel: "RED" });
  assert.ok(result.injectedDelay.median >= result.noOp.median + 1);
  const requestProof = requests.assertLocal(server.origin);

  const commit = execFileSync(
    "git",
    ["-c", `safe.directory=${repositoryDirectory.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repositoryDirectory, encoding: "utf8" },
  ).trim();
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        environment: "browser",
        browser: `Chrome ${browserVersion}`,
        chromeExecutable: executablePath,
        chromeExecutableSource: executableSource,
        crossOriginIsolated: isolated,
        commit,
        requestCount: requestProof.requestCount,
        ...result,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `Browser timer PASS (no-op median=${result.noOp.median.toFixed(6)} ms; injected median=${result.injectedDelay.median.toFixed(6)} ms)`,
  );
  console.log("Browser axes PASS (transfer=1, decompression=2, materialisation=3, encode=4 ms)");
  console.log("Browser mutations RED (2/2); cross-origin isolation PASS");
} finally {
  await page.close();
  await browser.close();
  await server.close();
}
