import crypto from "node:crypto";

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  return value;
}

export function identityDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex");
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function buildRunIdentity({
  profile,
  environment,
  commit,
  packageLockSha256,
  corpusSha256,
  modelSha256,
  artifactSha256,
  referenceRegistrySha256,
  benchmarkConfigurationSha256,
  containerId,
  containerIdentitySha256,
}) {
  if ((containerId === undefined) !== (containerIdentitySha256 === undefined)) {
    throw new Error("Container identity fields must be supplied together");
  }
  const identity = Object.freeze({
    schemaVersion: 1,
    profile: requiredString(profile, "profile"),
    environment: requiredString(environment, "environment"),
    commit: requiredString(commit, "commit"),
    packageLockSha256: requiredString(packageLockSha256, "packageLockSha256"),
    corpusSha256: requiredString(corpusSha256, "corpusSha256"),
    modelSha256: requiredString(modelSha256, "modelSha256"),
    artifactSha256: requiredString(artifactSha256, "artifactSha256"),
    referenceRegistrySha256: requiredString(
      referenceRegistrySha256,
      "referenceRegistrySha256",
    ),
    ...(benchmarkConfigurationSha256 === undefined
      ? {}
      : {
          benchmarkConfigurationSha256: requiredString(
            benchmarkConfigurationSha256,
            "benchmarkConfigurationSha256",
          ),
        }),
    ...(containerId === undefined
      ? {}
      : {
          containerId: requiredString(containerId, "containerId"),
          containerIdentitySha256: requiredString(
            containerIdentitySha256,
            "containerIdentitySha256",
          ),
        }),
  });
  return Object.freeze({ ...identity, runKey: identityDigest(identity) });
}

export function assertRunIdentity(identity) {
  const { runKey, ...body } = identity;
  if (runKey !== identityDigest(body)) {
    throw new Error("Benchmark run identity content does not match its key");
  }
  return identity;
}

export function assertSameRunIdentity(expected, actual) {
  assertRunIdentity(expected);
  assertRunIdentity(actual);
  if (expected.runKey !== actual.runKey) {
    const expectedFields = Object.keys(expected).filter((key) => key !== "runKey");
    const mismatches = expectedFields.filter((key) => expected[key] !== actual[key]);
    throw new Error(`Benchmark run identity mismatch: ${mismatches.join(", ") || "runKey"}`);
  }
}
