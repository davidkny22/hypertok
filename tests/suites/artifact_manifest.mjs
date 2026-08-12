import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOptimizationConfig } from "../../hypertok-js/src/optimization-config.mjs";

export const shippingFeatures = resolveOptimizationConfig().artifactFeatures;
const singleOnlyShippingFeatures = new Set([
  "opt-decode-assembly",
  "opt-decode-borrowed-output",
  "opt-decode-utf16-output",
  "opt-resolver-provenance",
]);
const sharedShippingFeatures = shippingFeatures.filter(
  (feature) => !singleOnlyShippingFeatures.has(feature),
);

export function validateExecutionArtifactManifest(
  document,
  { repository, readFile = fs.readFileSync } = {},
) {
  assert.equal(document.schemaVersion, 1);
  assert.ok(Array.isArray(document.artifacts) && document.artifacts.length > 0);
  const ids = document.artifacts.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, "artifact ids must be unique");
  const roots = {};
  for (const artifact of document.artifacts) {
    assert.match(artifact.id, /^[a-z0-9-]+$/u);
    assert.ok(["single", "shared"].includes(artifact.threading), artifact.id);
    assert.ok(["scalar", "simd128"].includes(artifact.simdLevel), artifact.id);
    assert.ok(Array.isArray(artifact.features), artifact.id);
    assert.equal(new Set(artifact.features).size, artifact.features.length, artifact.id);
    if (artifact.id.endsWith("-shipping")) {
      const expectedFeatures = artifact.threading === "shared"
        ? sharedShippingFeatures
        : shippingFeatures;
      for (const feature of expectedFeatures) {
        assert.ok(artifact.features.includes(feature), `${artifact.id} lacks ${feature}`);
      }
      for (const feature of artifact.features.filter((entry) => entry.startsWith("opt-"))) {
        assert.ok(expectedFeatures.includes(feature), `${artifact.id} carries dormant ${feature}`);
      }
    }
    assert.ok(Array.isArray(artifact.files), artifact.id);
    const roles = artifact.files.map(({ role }) => role);
    assert.equal(new Set(roles).size, roles.length, `${artifact.id} file roles must be unique`);
    for (const role of ["raw-wasm", "javascript", "bound-wasm"]) {
      assert.ok(roles.includes(role), `${artifact.id} lacks ${role}`);
    }
    let artifactRoot;
    for (const file of artifact.files) {
      assert.match(file.path, /^[^\\]+(?:\/[^\\]+)*$/u, artifact.id);
      const resolved = path.resolve(repository, file.path);
      assert.ok(
        resolved.startsWith(`${path.resolve(repository)}${path.sep}`),
        `${artifact.id}:${file.role} escapes the repository`,
      );
      const bytes = readFile(resolved);
      assert.equal(bytes.length, file.bytes, `${artifact.id}:${file.role} byte length`);
      assert.equal(
        crypto.createHash("sha256").update(bytes).digest("hex"),
        file.sha256,
        `${artifact.id}:${file.role} digest`,
      );
      if (file.role === "javascript") artifactRoot = path.dirname(resolved);
    }
    assert.ok(artifactRoot, `${artifact.id} has no JavaScript binding`);
    roots[artifact.id] = artifactRoot;
  }
  return Object.freeze(roots);
}

export function loadExecutionArtifactManifest(repository, manifestPath) {
  const resolvedManifest = manifestPath
    ? path.resolve(repository, manifestPath)
    : path.join(repository, "results", "execution-tiers", "artifacts.json");
  const bytes = fs.readFileSync(resolvedManifest);
  const document = JSON.parse(bytes);
  const roots = validateExecutionArtifactManifest(document, { repository });
  return Object.freeze({
    document,
    manifestPath: resolvedManifest,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    roots,
  });
}
