import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAgreementReceipt } from "../common/agreement_receipt.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultDirectory = path.resolve(benchesDirectory, "..", "results", "harness");
const nodeResult = JSON.parse(fs.readFileSync(path.join(resultDirectory, "node-agreement.json")));
const browserResult = JSON.parse(fs.readFileSync(path.join(resultDirectory, "browser-agreement.json")));

assert.equal(
  assertAgreementReceipt(nodeResult.agreementReceipt, nodeResult.runIdentity).agreementKey,
  nodeResult.agreementReceipt.agreementKey,
);
assert.equal(
  assertAgreementReceipt(browserResult.agreementReceipt, browserResult.runIdentity).agreementKey,
  browserResult.agreementReceipt.agreementKey,
);

assert.equal(nodeResult.commit, browserResult.commit);
assert.deepEqual(nodeResult.vocabularies, browserResult.vocabularies);
assert.equal(nodeResult.runIdentity.corpusSha256, browserResult.runIdentity.corpusSha256);
assert.equal(
  nodeResult.runIdentity.referenceRegistrySha256,
  browserResult.runIdentity.referenceRegistrySha256,
);
assert.equal(nodeResult.rows.length, browserResult.rows.length);
assert.deepEqual(nodeResult.mutations, browserResult.mutations);
assert.ok(nodeResult.mutations.every(({ observed }) => observed === "RED"));

for (let index = 0; index < nodeResult.rows.length; index += 1) {
  const nodeRow = nodeResult.rows[index];
  const browserRow = browserResult.rows[index];
  assert.deepEqual(
    {
      vocabulary: nodeRow.vocabulary,
      workload: nodeRow.workload,
      workloadBytes: nodeRow.workloadBytes,
      reference: nodeRow.reference,
      referenceVersion: nodeRow.referenceVersion,
      status: nodeRow.status,
      tokenCount: nodeRow.tokenCount,
      tokenSha256: nodeRow.tokenSha256,
      mismatch: nodeRow.mismatch,
      reason: nodeRow.reason,
    },
    {
      vocabulary: browserRow.vocabulary,
      workload: browserRow.workload,
      workloadBytes: browserRow.workloadBytes,
      reference: browserRow.reference,
      referenceVersion: browserRow.referenceVersion,
      status: browserRow.status,
      tokenCount: browserRow.tokenCount,
      tokenSha256: browserRow.tokenSha256,
      mismatch: browserRow.mismatch,
      reason: browserRow.reason,
    },
    `Node and browser disagreement at row ${index}`,
  );
}

console.log(
  `cross-environment agreement PASS (${nodeResult.rows.length}/${nodeResult.rows.length} rows identical between Node and browser records)`,
);
