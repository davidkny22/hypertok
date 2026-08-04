import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildBrowserBundle, referenceSlugs } from "../browser/build.mjs";
import { launchHarnessBrowser, observeRequests } from "../browser/control.mjs";
import { startHarnessServer } from "../browser/server.mjs";
import { buildAgreementReceipt } from "../common/agreement_receipt.mjs";
import {
  browserArenaArtifacts,
  buildArenaRunIdentity,
} from "../common/arena_identity.mjs";
import { loadCorpus } from "../common/corpus.mjs";
import { writeRunResult } from "../common/output.mjs";
import {
  availableReferencesForVocabulary,
  subjectReference,
  unavailableReferencesForVocabulary,
} from "../common/reference_registry.mjs";
import { vocabularyIdentity, vocabularyRegistry } from "../common/vocabularies.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const resultPath = path.join(repositoryDirectory, "results", "harness", "browser-agreement.json");

function currentCommit() {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${repositoryDirectory.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repositoryDirectory, encoding: "utf8" },
  ).trim();
}

const browserOutputDirectory = await buildBrowserBundle();
const server = await startHarnessServer();
const { browser, browserVersion, executablePath, executableSource } =
  await launchHarnessBrowser();
const page = await browser.newPage();
const requests = observeRequests(page);

try {
  await page.goto(server.origin, { waitUntil: "load" });
  await page.evaluate(() => globalThis.harnessReady);
  const isolated = await page.evaluate(() => crossOriginIsolated);
  const result = await page.evaluate(() => globalThis.harness.runAgreement());
  const workloads = loadCorpus();
  const runIdentity = buildArenaRunIdentity({
    environment: "browser",
    commit: currentCommit(),
    workloads,
    artifacts: browserArenaArtifacts(browserOutputDirectory, referenceSlugs),
  });
  const agreementReceipt = buildAgreementReceipt(runIdentity, result.rows);
  const measured = result.rows.filter(({ status }) => status !== "unavailable");
  const unavailable = result.rows.filter(({ status }) => status === "unavailable");
  const identical = measured.filter(({ status }) => status === "identical");
  const different = measured.filter(({ status }) => status === "different");

  assert.equal(isolated, true);
  for (const { id: vocabulary } of vocabularyRegistry) {
    const vocabularyRows = result.rows.filter((row) => row.vocabulary === vocabulary);
    const measuredRows = vocabularyRows.filter(({ status }) => status !== "unavailable");
    const unavailableRows = vocabularyRows.filter(({ status }) => status === "unavailable");
    assert.equal(
      measuredRows.length,
      workloads.length * availableReferencesForVocabulary(vocabulary).length,
    );
    assert.equal(
      unavailableRows.length,
      workloads.length * unavailableReferencesForVocabulary(vocabulary).length,
    );
    assert.ok(
      measuredRows
        .filter(({ reference }) => reference === subjectReference.id)
        .every(({ status }) => status === "identical"),
    );
    const unavailableById = new Map(
      unavailableReferencesForVocabulary(vocabulary).map((record) => [
        record.id,
        record.reason,
      ]),
    );
    assert.ok(
      unavailableRows.every((row) => row.reason === unavailableById.get(row.reference)),
    );
  }
  assert.ok(result.mutations.every(({ observed }) => observed === "RED"));
  const requestProof = requests.assertLocal(server.origin);

  const output = {
    schemaVersion: 2,
    environment: "browser",
    browser: `Chrome ${browserVersion}`,
    chromeExecutable: executablePath,
    chromeExecutableSource: executableSource,
    crossOriginIsolated: isolated,
    commit: runIdentity.commit,
    runIdentity,
    agreementReceipt,
    vocabularies: vocabularyIdentity(),
    requestPolicy: {
      localOnly: true,
      requestCount: requestProof.requestCount,
      failedRequestCount: requestProof.failedRequestCount,
    },
    rows: result.rows,
    mutations: result.mutations,
  };
  const publicOutput = writeRunResult({
    runIdentity,
    mode: process.env.HYPERTOK_BENCH_MODE ?? "full",
    axis: "agreement",
    result: output,
  });
  fs.writeFileSync(resultPath, `${JSON.stringify(publicOutput.result, null, 2)}\n`);

  console.log(
    `browser agreement PASS (${measured.length}/${measured.length} measured rows classified; ${identical.length} identical; ${different.length} different; ${unavailable.length}/${unavailable.length} unavailable rows recorded)`,
  );
  for (const row of different) {
    console.log(
      `different: ${row.vocabulary}/${row.reference} on ${row.workload} at token ${row.mismatch.index}`,
    );
  }
  console.log(`agreement mutations RED (${result.mutations.length}/${result.mutations.length})`);
  console.log(
    `cross-origin isolation PASS; local-only requests ${requestProof.requestCount}/${requestProof.requestCount}`,
  );
  console.log(path.relative(repositoryDirectory, resultPath).replaceAll("\\", "/"));
  console.log(path.relative(repositoryDirectory, publicOutput.resultPath).replaceAll("\\", "/"));
} finally {
  await page.close();
  await browser.close();
  await server.close();
}
