import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAgreementReceipt,
  buildAgreementReceipt,
  requireComparableAgreement,
} from "../common/agreement_receipt.mjs";
import { buildRunIdentity, identityDigest } from "../common/identity.mjs";
import {
  availableReferences,
  availableReferencesForVocabulary,
  oracleReferenceForVocabulary,
  referenceRegistry,
  subjectReference,
  unavailableReferences,
  unavailableReferencesForVocabulary,
} from "../common/reference_registry.mjs";
import { benchmarkRow } from "../common/row.mjs";
import { benchmarkConfiguration } from "../common/throughput.mjs";
import { vocabularyRegistry } from "../common/vocabularies.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(benchesDirectory, "package.json")));
const packageLock = JSON.parse(
  fs.readFileSync(path.join(benchesDirectory, "package-lock.json")),
);

assert.ok(referenceRegistry.length > 0);
assert.equal(
  availableReferences.length + unavailableReferences.length,
  referenceRegistry.length,
);
assert.equal(new Set(referenceRegistry.map(({ id }) => id)).size, referenceRegistry.length);
assert.equal(
  new Set(availableReferences.map(({ browserSlug }) => browserSlug)).size,
  availableReferences.length,
);
assert.equal(subjectReference.id, "hypertok");
for (const { id: vocabulary, oracleReference } of vocabularyRegistry) {
  assert.equal(oracleReferenceForVocabulary(vocabulary).id, oracleReference);
  const available = availableReferencesForVocabulary(vocabulary);
  const unavailable = unavailableReferencesForVocabulary(vocabulary);
  assert.equal(available.length + unavailable.length, referenceRegistry.length);
  assert.equal(new Set([...available, ...unavailable].map(({ id }) => id)).size, referenceRegistry.length);
  assert.ok(unavailable.every(({ reason }) => typeof reason === "string" && reason.length > 0));
}
for (const record of availableReferences.filter(({ packageName }) => packageName !== null)) {
  assert.equal(packageJson.dependencies[record.packageName], record.version, record.id);
  assert.equal(
    packageLock.packages[`node_modules/${record.packageName}`].version,
    record.version,
    `${record.id} lock`,
  );
}

const runIdentity = buildRunIdentity({
  profile: "arena",
  environment: "node",
  commit: "a".repeat(40),
  packageLockSha256: "b".repeat(64),
  corpusSha256: "c".repeat(64),
  modelSha256: "d".repeat(64),
  artifactSha256: "e".repeat(64),
  referenceRegistrySha256: identityDigest(referenceRegistry),
  benchmarkConfigurationSha256: "1".repeat(64),
  containerId: "container-test",
  containerIdentitySha256: "f".repeat(64),
});
const rows = vocabularyRegistry.flatMap(({ id: vocabulary }) => {
  const availableIds = new Set(
    availableReferencesForVocabulary(vocabulary).map(({ id }) => id),
  );
  const unavailableById = new Map(
    unavailableReferencesForVocabulary(vocabulary).map((record) => [record.id, record]),
  );
  return referenceRegistry.map((record, index) => ({
    vocabulary,
    workload: "english-prose",
    reference: record.id,
    referenceVersion: record.version,
    status: availableIds.has(record.id) ? "identical" : "unavailable",
    reason: unavailableById.get(record.id)?.reason,
    tokenCount: availableIds.has(record.id) ? 100 + index : undefined,
    tokenSha256: availableIds.has(record.id) ? `${index}`.repeat(64) : undefined,
    mismatch: null,
  }));
});
const receipt = buildAgreementReceipt(runIdentity, rows);
assert.equal(assertAgreementReceipt(receipt, runIdentity), receipt);
assert.equal(
  requireComparableAgreement(receipt, "gpt2", "english-prose", "hypertok").status,
  "identical",
);
assert.equal(
  requireComparableAgreement(receipt, "o200k_base", "english-prose", "tiktoken-wasm").status,
  "unavailable",
);

const changedRun = Object.freeze({ ...runIdentity, commit: "f".repeat(40) });
assert.throws(() => assertAgreementReceipt(receipt, changedRun), /does not match its key/);
assert.throws(
  () => assertAgreementReceipt({ ...receipt, rows: receipt.rows.slice(1) }, runIdentity),
  /does not match its key/,
);
const disagreementReceipt = buildAgreementReceipt(runIdentity, [
  { ...rows[0], status: "different", mismatch: { index: 0, expected: 1, actual: 2 } },
]);
assert.throws(
  () =>
    requireComparableAgreement(
      disagreementReceipt,
      rows[0].vocabulary,
      "english-prose",
      rows[0].reference,
    ),
  /no ratio may be reported/,
);

const validRow = benchmarkRow({
  profile: "arena",
  mode: "smoke",
  axis: "encode",
  vocabulary: "gpt2",
  workload: "english-prose",
  reference: "hypertok",
  referenceVersion: "workspace",
  environment: "node",
  tier: "single",
  simdLevel: "scalar",
  clockRegime: "performance.now",
  status: "measured",
  comparisonStatus: "identical",
  n: 11,
  median: 100,
  p95: 110,
  variance: 4,
  ratio: 1,
  units: "MB/s",
  commit: runIdentity.commit,
  agreementKey: receipt.agreementKey,
});
assert.equal(validRow.axis, "encode");
assert.equal(
  benchmarkRow({ ...validRow, axis: "decode", containerRegime: "fresh" }).containerRegime,
  "fresh",
);
assert.throws(
  () => benchmarkRow({ ...validRow, axis: "decode" }),
  /containerRegime/,
);
assert.throws(
  () => benchmarkRow({ ...validRow, axis: "decode", containerRegime: "blended" }),
  /containerRegime/,
);
assert.throws(() => benchmarkRow({ ...validRow, n: 0 }), /positive integer/);
assert.throws(() => benchmarkRow({ ...validRow, agreementKey: "" }), /agreementKey/);
assert.throws(() => benchmarkRow({ ...validRow, vocabulary: "" }), /vocabulary/);
assert.throws(
  () => buildRunIdentity({ ...runIdentity, runKey: undefined, containerIdentitySha256: undefined }),
  /supplied together/,
);
assert.throws(
  () => benchmarkRow({ ...validRow, comparisonStatus: "different" }),
  /cannot carry a ratio/,
);
assert.equal(
  benchmarkConfiguration({
    HYPERTOK_BENCH_PROFILE: "arena",
    HYPERTOK_BENCH_MODE: "full",
  }).n,
  21,
);
const smokeConfiguration = benchmarkConfiguration({
  HYPERTOK_BENCH_PROFILE: "arena",
  HYPERTOK_BENCH_MODE: "smoke",
  HYPERTOK_BENCH_N: "1",
  HYPERTOK_BENCH_WARMUP: "0",
  HYPERTOK_BENCH_TARGET_BYTES: "1024",
});
assert.equal(smokeConfiguration.mode, "smoke");
assert.equal(smokeConfiguration.n, 1);
assert.deepEqual(smokeConfiguration.decodeContainerRegimes, ["repeated", "fresh"]);
assert.throws(
  () => benchmarkConfiguration({ HYPERTOK_BENCH_PROFILE: "unknown" }),
  /Unknown benchmark profile/,
);

console.log(
  `reference registry PASS (${referenceRegistry.length}/${referenceRegistry.length} records, package versions exact)`,
);
console.log("run identity and agreement receipt PASS (3/3 mutations RED)");
console.log("benchmark row and profile contracts PASS (5/5 mutations RED)");
