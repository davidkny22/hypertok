import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunIdentity } from "../common/identity.mjs";
import { writeRunResult } from "../common/output.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDirectory = path.resolve(benchesDirectory, "..", "results");
fs.mkdirSync(resultsDirectory, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(resultsDirectory, ".benchmark-output-test-"));
const outputRoot = path.join(testRoot, "runs");
const session = `test-${process.pid}`;
const environment = { HYPERTOK_RUN_SESSION: session };

function digest(label) {
  return crypto.createHash("sha256").update(label).digest("hex");
}

function identity(runtimeEnvironment, artifact) {
  return buildRunIdentity({
    profile: "arena",
    environment: runtimeEnvironment,
    commit: "0123456789abcdef0123456789abcdef01234567",
    packageLockSha256: digest("package lock"),
    corpusSha256: digest("corpus"),
    modelSha256: digest("model"),
    artifactSha256: digest(artifact),
    referenceRegistrySha256: digest("registry"),
    benchmarkConfigurationSha256: digest("decode repeated and fresh"),
  });
}

const nodeIdentity = identity("node", "node artifact");
const browserIdentity = identity("browser", "browser artifact");
const nodeResult = { schemaVersion: 1, environment: "node", rows: [] };
const browserResult = { schemaVersion: 1, environment: "browser", rows: [] };

try {
  const nodeOutput = writeRunResult({
    runIdentity: nodeIdentity,
    mode: "smoke",
    axis: "agreement",
    result: nodeResult,
    environment,
    outputRoot,
  });
  const browserOutput = writeRunResult({
    runIdentity: browserIdentity,
    mode: "smoke",
    axis: "encode",
    result: browserResult,
    environment,
    outputRoot,
  });

  assert.equal(nodeOutput.runKey, browserOutput.runKey);
  assert.equal(nodeOutput.session, session);
  assert.equal(browserOutput.session, session);
  const changedRegimeIdentity = Object.freeze({
    ...nodeIdentity,
    benchmarkConfigurationSha256: digest("decode repeated only"),
  });
  const changedRegimeOutput = writeRunResult({
    runIdentity: buildRunIdentity({
      ...changedRegimeIdentity,
      runKey: undefined,
    }),
    mode: "smoke",
    axis: "agreement",
    result: nodeResult,
    environment,
    outputRoot,
  });
  assert.notEqual(changedRegimeOutput.runKey, nodeOutput.runKey);
  const manifestBytes = fs.readFileSync(nodeOutput.manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    "browser-encode.json",
    "node-agreement.json",
  ]);
  for (const [filename, entry] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(path.join(path.dirname(nodeOutput.manifestPath), filename));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  }

  writeRunResult({
    runIdentity: nodeIdentity,
    mode: "smoke",
    axis: "agreement",
    result: nodeResult,
    environment,
    outputRoot,
  });

  assert.throws(
    () => writeRunResult({
      runIdentity: nodeIdentity,
      mode: "smoke",
      axis: "agreement",
      result: { ...nodeResult, rows: [{ changed: true }] },
      environment,
      outputRoot,
    }),
    /already exists with different content/,
  );
  assert.throws(
    () => writeRunResult({
      runIdentity: nodeIdentity,
      mode: "smoke",
      axis: "encode",
      result: browserResult,
      environment,
      outputRoot,
    }),
    /environment does not match/,
  );
  assert.throws(
    () => writeRunResult({
      runIdentity: nodeIdentity,
      mode: "smoke",
      axis: "../escape",
      result: nodeResult,
      environment,
      outputRoot,
    }),
    /Invalid benchmark result axis/,
  );
  assert.throws(
    () => writeRunResult({
      runIdentity: nodeIdentity,
      mode: "quick",
      axis: "encode",
      result: nodeResult,
      environment,
      outputRoot,
    }),
    /Invalid benchmark mode/,
  );
  assert.throws(
    () => writeRunResult({
      runIdentity: nodeIdentity,
      mode: "smoke",
      axis: "encode",
      result: nodeResult,
      environment: { HYPERTOK_RUN_SESSION: "../escape" },
      outputRoot,
    }),
    /Invalid benchmark run session/,
  );

  const validManifest = fs.readFileSync(nodeOutput.manifestPath);
  const changedManifest = JSON.parse(validManifest);
  changedManifest.identity.commit = "changed";
  fs.writeFileSync(nodeOutput.manifestPath, `${JSON.stringify(changedManifest)}\n`);
  assert.throws(
    () => writeRunResult({
      runIdentity: nodeIdentity,
      mode: "smoke",
      axis: "decode",
      result: nodeResult,
      environment,
      outputRoot,
    }),
    /manifest identity mismatch/,
  );
  fs.writeFileSync(nodeOutput.manifestPath, validManifest);

  const resultBytes = fs.readFileSync(nodeOutput.resultPath);
  fs.appendFileSync(nodeOutput.resultPath, "changed\n");
  assert.throws(
    () => writeRunResult({
      runIdentity: nodeIdentity,
      mode: "smoke",
      axis: "decode",
      result: nodeResult,
      environment,
      outputRoot,
    }),
    /manifest file mismatch/,
  );
  fs.writeFileSync(nodeOutput.resultPath, resultBytes);

  console.log("benchmark output manifest PASS (two files, one run identity)");
  console.log("output mutations RED (overwrite, identity, axis, mode, session, manifest, file)");
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
