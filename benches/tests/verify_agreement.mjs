import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createNodeAdapters, disposeAdapters } from "../adapters/node.mjs";
import { buildAgreementMatrix } from "../common/agreement.mjs";
import { buildAgreementReceipt } from "../common/agreement_receipt.mjs";
import {
  buildArenaRunIdentity,
  nodeArenaArtifacts,
} from "../common/arena_identity.mjs";
import { loadCorpus } from "../common/corpus.mjs";
import { writeRunResult } from "../common/output.mjs";
import {
  availableReferencesForVocabulary,
  oracleReferenceForVocabulary,
  subjectReference,
  unavailableReferencesForVocabulary,
} from "../common/reference_registry.mjs";
import { vocabularyIdentity, vocabularyRegistry } from "../common/vocabularies.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const resultsDirectory = path.join(repositoryDirectory, "results", "harness");
const workloads = loadCorpus();

function currentCommit() {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${repositoryDirectory.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repositoryDirectory, encoding: "utf8" },
  ).trim();
}

const rows = [];
const mutations = [];
for (const { id: vocabulary } of vocabularyRegistry) {
  const adapters = await createNodeAdapters(vocabulary);
  const unavailable = unavailableReferencesForVocabulary(vocabulary);
  const oracleId = oracleReferenceForVocabulary(vocabulary).id;
  try {
    const vocabularyRows = buildAgreementMatrix(workloads, adapters, unavailable, {
      vocabulary,
      oracleReference: oracleId,
    });
    rows.push(...vocabularyRows);

    const measured = vocabularyRows.filter(({ status }) => status !== "unavailable");
    const unavailableRows = vocabularyRows.filter(({ status }) => status === "unavailable");
    const expectedAvailable = availableReferencesForVocabulary(vocabulary);
    assert.equal(measured.length, workloads.length * expectedAvailable.length);
    assert.equal(unavailableRows.length, workloads.length * unavailable.length);
    assert.ok(
      measured
        .filter(({ reference }) => reference === subjectReference.id)
        .every(({ status }) => status === "identical"),
    );
    const unavailableById = new Map(unavailable.map((record) => [record.id, record.reason]));
    assert.ok(
      unavailableRows.every((row) => row.reason === unavailableById.get(row.reference)),
    );

    const oracle = adapters.find(({ id }) => id === oracleId);
    const mutated = Object.freeze({
      ...oracle,
      id: "mutated-oracle",
      encode(text) {
        const ids = oracle.encode(text);
        const changed = Uint32Array.from(ids);
        changed[0] ^= 1;
        return changed;
      },
    });
    const mutationRows = buildAgreementMatrix(
      [workloads[0]],
      [oracle, mutated],
      [],
      { vocabulary, oracleReference: oracleId },
    );
    assert.equal(mutationRows[1].status, "different");
    mutations.push({
      vocabulary,
      name: "perturb-first-token-id",
      observed: "RED",
      mismatch: mutationRows[1].mismatch,
    });
  } finally {
    disposeAdapters(adapters);
  }
}

const runIdentity = buildArenaRunIdentity({
  environment: "node",
  commit: currentCommit(),
  workloads,
  artifacts: nodeArenaArtifacts(),
});
const agreementReceipt = buildAgreementReceipt(runIdentity, rows);
const measured = rows.filter(({ status }) => status !== "unavailable");
const unavailable = rows.filter(({ status }) => status === "unavailable");
const identical = measured.filter(({ status }) => status === "identical");
const different = measured.filter(({ status }) => status === "different");

fs.mkdirSync(resultsDirectory, { recursive: true });
const outputPath = path.join(resultsDirectory, "node-agreement.json");
const output = {
  schemaVersion: 2,
  environment: "node",
  nodeVersion: process.version,
  commit: runIdentity.commit,
  runIdentity,
  agreementReceipt,
  vocabularies: vocabularyIdentity(),
  rows,
  mutations,
};
const publicOutput = writeRunResult({
  runIdentity,
  mode: process.env.HYPERTOK_BENCH_MODE ?? "full",
  axis: "agreement",
  result: output,
});
fs.writeFileSync(outputPath, `${JSON.stringify(publicOutput.result, null, 2)}\n`);

console.log(
  `node agreement PASS (${measured.length}/${measured.length} measured rows classified; ${identical.length} identical; ${different.length} different; ${unavailable.length}/${unavailable.length} unavailable rows recorded)`,
);
for (const row of different) {
  console.log(
    `different: ${row.vocabulary}/${row.reference} on ${row.workload} at token ${row.mismatch.index}`,
  );
}
console.log(`agreement mutations RED (${mutations.length}/${mutations.length})`);
console.log(path.relative(repositoryDirectory, outputPath).replaceAll("\\", "/"));
console.log(path.relative(repositoryDirectory, publicOutput.resultPath).replaceAll("\\", "/"));
