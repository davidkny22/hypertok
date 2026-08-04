import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadExecutionArtifactManifest,
  validateExecutionArtifactManifest,
} from "./artifact_manifest.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = process.argv[2]
  ? path.resolve(repository, process.argv[2])
  : path.join(repository, "results", "execution-tiers", "artifacts.json");

const loaded = loadExecutionArtifactManifest(repository, manifestPath);
const manifest = loaded.document;
const missingFeature = structuredClone(manifest);
missingFeature.artifacts.find(({ id }) => id.endsWith("-shipping")).features.pop();
assert.throws(
  () => validateExecutionArtifactManifest(missingFeature, { repository }),
  /lacks/,
);
const staleDigest = structuredClone(manifest);
staleDigest.artifacts[0].files[0].sha256 = "0".repeat(64);
assert.throws(() => validateExecutionArtifactManifest(staleDigest, { repository }), /digest/);
const escapedPath = structuredClone(manifest);
escapedPath.artifacts[0].files[0].path = "../outside.wasm";
assert.throws(() => validateExecutionArtifactManifest(escapedPath, { repository }), /escapes/);

console.log(`execution artifact manifest PASS (${manifest.artifacts.length} artifacts)`);
console.log("artifact manifest mutations RED (shipping feature, digest, escaped path)");
