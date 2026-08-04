import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScriptCorpus } from "./corpus.mjs";
import { buildRunIdentity, identityDigest } from "./identity.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedSourceSha256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";

const shippingReferenceRegistry = Object.freeze({
  hypertok: Object.freeze({ version: "0.10.0" }),
  gigatoken: Object.freeze({
    version: "0.10.0",
    commit: "34a1599f0c0ae7d7cd0d1c530e6522320158b360",
  }),
  shims: Object.freeze({
    tiktoken: Object.freeze({ version: "0.1.0" }),
    huggingface: Object.freeze({ version: "0.1.0" }),
  }),
});

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sourceRanksPath(environment) {
  const filePath = environment.HYPERTOK_SOURCE_RANKS;
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("The shipping profile requires HYPERTOK_SOURCE_RANKS");
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Shipping source ranks not found: ${filePath}`);
  }
  const digest = sha256File(filePath);
  if (digest !== expectedSourceSha256) {
    throw new Error(`Shipping source ranks digest mismatch: ${digest}`);
  }
  return filePath;
}

function artifactIdentity(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("Shipping identity requires at least one artifact");
  }
  return identityDigest(
    artifacts
      .map(({ label, filePath }) => ({ label, sha256: sha256File(filePath) }))
      .sort((left, right) => left.label.localeCompare(right.label)),
  );
}

export function buildShippingRunIdentity({
  environment,
  commit,
  artifacts,
  variables = process.env,
}) {
  const workloads = loadScriptCorpus();
  const sourcePath = sourceRanksPath(variables);
  return buildRunIdentity({
    profile: "shipping",
    environment,
    commit,
    packageLockSha256: sha256File(path.join(benchesDirectory, "package-lock.json")),
    corpusSha256: identityDigest(
      workloads.map(({ id, role, bytes, sha256 }) => ({ id, role, bytes, sha256 })),
    ),
    modelSha256: sha256File(sourcePath),
    artifactSha256: artifactIdentity(artifacts),
    referenceRegistrySha256: identityDigest(shippingReferenceRegistry),
  });
}
