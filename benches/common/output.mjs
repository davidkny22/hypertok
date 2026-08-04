import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRunIdentity, identityDigest } from "./identity.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function publicIdentity(runIdentity, mode) {
  return Object.freeze({
    schemaVersion: 1,
    profile: runIdentity.profile,
    mode,
    commit: runIdentity.commit,
    packageLockSha256: runIdentity.packageLockSha256,
    corpusSha256: runIdentity.corpusSha256,
    modelSha256: runIdentity.modelSha256,
    referenceRegistrySha256: runIdentity.referenceRegistrySha256,
    ...(runIdentity.benchmarkConfigurationSha256 === undefined
      ? {}
      : {
          benchmarkConfigurationSha256: runIdentity.benchmarkConfigurationSha256,
        }),
    ...(runIdentity.containerId === undefined
      ? {}
      : {
          containerId: runIdentity.containerId,
          containerIdentitySha256: runIdentity.containerIdentitySha256,
        }),
  });
}

function runSession(environment) {
  const session = environment.HYPERTOK_RUN_SESSION ??
    new Date().toISOString().replaceAll(":", "-");
  if (!/^[A-Za-z0-9._-]+$/.test(session)) {
    throw new Error(`Invalid benchmark run session: ${session}`);
  }
  return session;
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function writeAtomically(filePath, bytes) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, bytes);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return Object.freeze({ bytes, sha256: sha256(bytes) });
}

function validateManifest(manifest, { runKey, session, directory }) {
  if (
    manifest.runKey !== runKey ||
    manifest.session !== session ||
    identityDigest(manifest.identity) !== runKey ||
    manifest.files === null ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  ) {
    throw new Error("Benchmark run manifest identity mismatch");
  }
  for (const [filename, entry] of Object.entries(manifest.files)) {
    if (path.basename(filename) !== filename || entry === null || typeof entry !== "object") {
      throw new Error("Benchmark run manifest file entry is invalid");
    }
    const filePath = path.join(directory, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Benchmark run manifest file is missing: ${filename}`);
    }
    const bytes = fs.readFileSync(filePath);
    if (entry.bytes !== bytes.length || entry.sha256 !== sha256(bytes)) {
      throw new Error(`Benchmark run manifest file mismatch: ${filename}`);
    }
  }
}

export function writeRunResult({
  runIdentity,
  mode,
  axis,
  result,
  environment = process.env,
  outputRoot = path.join(repositoryDirectory, "results", "benchmark-runs"),
}) {
  assertRunIdentity(runIdentity);
  if (!["smoke", "full"].includes(mode)) {
    throw new Error(`Invalid benchmark mode: ${mode}`);
  }
  if (typeof axis !== "string" || !/^[a-z-]+$/.test(axis)) {
    throw new Error(`Invalid benchmark result axis: ${axis}`);
  }
  if (result.environment !== runIdentity.environment) {
    throw new Error("Benchmark result environment does not match its run identity");
  }
  const identity = publicIdentity(runIdentity, mode);
  const runKey = identityDigest(identity);
  const session = runSession(environment);
  const directory = path.join(outputRoot, runKey, session);
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${result.environment}-${axis}.json`;
  const resultPath = path.join(directory, filename);
  const completeResult = Object.freeze({
    ...result,
    publicRun: Object.freeze({ runKey, session }),
  });
  const manifestPath = path.join(directory, "manifest.json");
  const existing = readManifest(manifestPath);
  if (existing !== null) {
    validateManifest(existing, { runKey, session, directory });
  }

  const bytes = jsonBytes(completeResult);
  let written;
  if (fs.existsSync(resultPath)) {
    const current = fs.readFileSync(resultPath);
    if (!current.equals(bytes)) {
      throw new Error(`Benchmark result already exists with different content: ${filename}`);
    }
    written = Object.freeze({ bytes: current, sha256: sha256(current) });
  } else {
    written = writeAtomically(resultPath, bytes);
  }
  const manifest = {
    schemaVersion: 1,
    runKey,
    session,
    identity,
    files: {
      ...(existing?.files ?? {}),
      [filename]: {
        axis,
        environment: result.environment,
        artifactSha256: runIdentity.artifactSha256,
        runIdentityKey: runIdentity.runKey,
        bytes: written.bytes.length,
        sha256: written.sha256,
      },
    },
  };
  writeAtomically(manifestPath, jsonBytes(manifest));
  return Object.freeze({
    result: completeResult,
    runKey,
    session,
    resultPath,
    manifestPath,
  });
}
