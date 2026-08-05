import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readContainerIdentity } from "./container_identity.mjs";
import { buildRunIdentity, identityDigest } from "./identity.mjs";
import {
  benchmarkConfiguration,
  DECODE_CONTAINER_REGIMES,
  DECODE_FIELD_SEGMENT_BYTES,
  ORDINARY_ID_REFERENCES,
} from "./throughput.mjs";
import { VERDICT_SAMPLING_POLICY } from "./verdict_sampling.mjs";
import { referenceRegistry } from "./reference_registry.mjs";
import {
  prepareVocabularyArtifact,
  vocabularyIdentity,
  vocabularyRegistry,
} from "./vocabularies.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function artifactIdentity(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("Arena identity requires at least one artifact");
  }
  return identityDigest(
    artifacts
      .map(({ label, filePath }) => ({
        label,
        sha256: sha256File(filePath),
      }))
      .sort((left, right) => left.label.localeCompare(right.label)),
  );
}

export function arenaCorpusSha256(workloads) {
  return identityDigest(
    workloads.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })),
  );
}

export function nodeArenaArtifacts() {
  return [
    {
      label: "hypertok-wasm",
      filePath: path.join(
        repositoryDirectory,
        "hypertok-js",
        "wasm",
        "single",
        "hypertok_wasm_core_bg.wasm",
      ),
    },
    ...vocabularyRegistry.map(({ id }) => ({
      label: `hypertok-${id}-htk`,
      filePath: prepareVocabularyArtifact(id).path,
    })),
  ];
}

export function browserArenaArtifacts(browserOutputDirectory, referenceSlugs) {
  return [
    { label: "agreement-bundle", filePath: path.join(browserOutputDirectory, "bundle.mjs") },
    {
      label: "hypertok-wasm",
      filePath: path.join(
        browserOutputDirectory,
        "wasm",
        "single",
        "hypertok_wasm_core_bg.wasm",
      ),
    },
    ...vocabularyRegistry.map(({ id, browserAsset }) => ({
      label: `hypertok-${id}-htk`,
      filePath: path.join(browserOutputDirectory, browserAsset),
    })),
    ...referenceSlugs.map((slug) => ({
      label: `reference-${slug}`,
      filePath: path.join(browserOutputDirectory, "references", `${slug}.mjs`),
    })),
  ];
}

export function buildArenaRunIdentity({ environment, commit, workloads, artifacts }) {
  const containerIdentity = readContainerIdentity(commit);
  const configuration = benchmarkConfiguration();
  return buildRunIdentity({
    profile: "arena",
    environment,
    commit,
    packageLockSha256: sha256File(path.join(benchesDirectory, "package-lock.json")),
    corpusSha256: arenaCorpusSha256(workloads),
    modelSha256: identityDigest(vocabularyIdentity()),
    artifactSha256: artifactIdentity(artifacts),
    referenceRegistrySha256: identityDigest(referenceRegistry),
    benchmarkConfigurationSha256: identityDigest({
      mode: configuration.mode,
      n: configuration.n,
      maxN: configuration.maxN,
      openWebTextN: configuration.openWebTextN,
      warmup: configuration.warmup,
      targetBytesPerSample: configuration.targetBytesPerSample,
      carriedForwardAxes: configuration.carriedForwardAxes,
      verdictSampling: VERDICT_SAMPLING_POLICY,
      decodeContainerRegimes: DECODE_CONTAINER_REGIMES,
      decodeFieldSegmentBytes: DECODE_FIELD_SEGMENT_BYTES,
      decodeFreshContainerPreparation: "outside-timed-interval",
      decodeSampleRepetitions: "ceil(targetBytesPerSample/workloadBytes), capped at 512",
      decodeOrdinaryIdReferences: ORDINARY_ID_REFERENCES,
    }),
    ...(containerIdentity ?? {}),
  });
}
