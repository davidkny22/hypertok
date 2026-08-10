import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserBundle } from "./browser/build.mjs";
import { launchHarnessBrowser, observeRequests } from "./browser/control.mjs";
import { startHarnessServer } from "./browser/server.mjs";
import { loadCorpus } from "./common/corpus.mjs";
import { measureDecodeRoutes } from "./common/decode_route_pricing.mjs";
import { prepareVocabularyArtifact, vocabularyRegistry } from "./common/vocabularies.mjs";
import { fromBytes } from "../hypertok-js/src/index.mjs";
import { resolveShimRuntime } from "../hypertok-js/src/shim-runtime.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const candidateArgument = process.argv.find((argument) => argument.startsWith("--candidate="));
const candidateMode = candidateArgument?.slice("--candidate=".length) ?? "byte";
if (!new Set(["byte", "mixed", "fused", "lean", "memo", "run-cache", "latin1-native", "latin1-portable", "direct-scratch", "clean-unroll", "borrowed-output"]).has(candidateMode)) {
  throw new TypeError("candidate is not supported by decode route pricing");
}
const outputPath = path.join(
  repositoryDirectory,
  "results",
  "decode-dirty-campaign",
  candidateMode === "mixed"
    ? "mixed-route-pricing.json"
    : candidateMode === "fused"
      ? "validation-pricing.json"
      : candidateMode === "lean"
        ? "dispatch-pricing.json"
        : candidateMode === "memo"
          ? "memo-pricing.json"
          : candidateMode === "run-cache"
            ? "run-cache-pricing.json"
            : candidateMode === "latin1-native"
              ? "native-latin1-pricing.json"
            : candidateMode === "latin1-portable"
              ? "portable-latin1-pricing.json"
              : candidateMode === "direct-scratch"
                ? "direct-scratch-pricing.json"
                : candidateMode === "clean-unroll"
                  ? "clean-unroll-pricing.json"
                  : candidateMode === "borrowed-output"
                    ? "borrowed-output-pricing.json"
      : "route-pricing.json",
);
const artifacts = vocabularyRegistry.map(({ id }) => prepareVocabularyArtifact(id));
const decisionWorkloads = candidateMode === "direct-scratch" || candidateMode === "latin1-native" || candidateMode === "borrowed-output"
  ? new Set(["chinese", "emoji-heavy"])
  : candidateMode === "clean-unroll"
    ? new Set(["english-prose", "source-code", "long-document", "standard-text"])
    : null;
const workloads = loadCorpus().filter(({ id }) =>
  decisionWorkloads === null || decisionWorkloads.has(id)
);
const regimes = candidateMode === "memo"
  ? ["repeated", "fresh"]
  : candidateMode === "direct-scratch" || candidateMode === "clean-unroll" || candidateMode === "latin1-native" || candidateMode === "borrowed-output"
    ? ["fresh"]
    : ["repeated"];
const targetBytesPerSample = candidateMode === "latin1-native" || candidateMode === "borrowed-output"
  ? 16_777_216
  : 1_048_576;

async function measureNode(containerRegime, artifact) {
  const baseline = await fromBytes(artifact.bytes, {
    tier: "single",
    optimizations:
      candidateMode === "fused"
        ? { decodeFusedValidation: "off" }
        : candidateMode === "lean"
          ? { decodeLeanDispatch: "off" }
          : candidateMode === "memo"
            ? { decodeMemo: "off" }
            : candidateMode === "run-cache"
              ? { decodeMemo: "off", decodeRunCache: "off" }
              : candidateMode === "latin1-native"
                ? { decodeMemo: "off", decodeLatin1Native: "off" }
              : candidateMode === "latin1-portable"
                ? { decodeMemo: "off", decodeLatin1Portable: "off" }
                : candidateMode === "direct-scratch"
                  ? { decodeMemo: "off", decodeDirectScratch: "off" }
                  : candidateMode === "clean-unroll"
                    ? { decodeMemo: "off", decodeCleanUnroll: "off" }
                    : candidateMode === "borrowed-output"
                      ? { decodeMemo: "off", decodeBorrowedOutput: "off" }
            : { decodeMixedRuns: "off" },
  });
  const candidate = await fromBytes(artifact.bytes, {
    tier: "single",
    optimizations:
      candidateMode === "mixed"
        ? { decodeMixedRuns: "on" }
        : candidateMode === "fused"
          ? { decodeFusedValidation: "auto" }
          : candidateMode === "lean"
            ? { decodeLeanDispatch: "on" }
            : candidateMode === "memo"
              ? { decodeMemo: "auto" }
              : candidateMode === "run-cache"
                ? { decodeMemo: "off", decodeRunCache: "on" }
                : candidateMode === "latin1-native"
                  ? {
                      decodeMemo: "off",
                      decodeLatin1Native: artifact.vocabulary === "o200k_base" ? "on" : "off",
                    }
                : candidateMode === "latin1-portable"
                  ? { decodeMemo: "off", decodeLatin1Portable: "on" }
                  : candidateMode === "direct-scratch"
                    ? { decodeMemo: "off", decodeDirectScratch: "on" }
                    : candidateMode === "clean-unroll"
                      ? { decodeMemo: "off", decodeCleanUnroll: "on" }
                      : candidateMode === "borrowed-output"
                        ? { decodeMemo: "off", decodeBorrowedOutput: "on" }
              : { decodeByteTable: "on" },
  });
  try {
    return measureDecodeRoutes({
      baseline,
      candidate,
      workloads,
      candidateMode,
      containerRegime,
      targetBytesPerSample,
      baselineStats: () => resolveShimRuntime(baseline).decodeStats(),
      candidateStats: () => resolveShimRuntime(candidate).decodeStats(),
    });
  } finally {
    baseline.free();
    candidate.free();
  }
}

const nodeVocabularies = {};
for (const artifact of artifacts) {
  const nodeRegimes = {};
  for (const regime of regimes) nodeRegimes[regime] = await measureNode(regime, artifact);
  nodeVocabularies[artifact.vocabulary] = candidateMode === "memo"
    ? { regimes: nodeRegimes }
    : nodeRegimes[regimes[0]];
}

await buildBrowserBundle();
const server = await startHarnessServer();
const { browser, browserVersion, executablePath } = await launchHarnessBrowser();
const chromeRegimes = {};
let requestProof;
try {
  const page = await browser.newPage();
  const requests = observeRequests(page);
  await page.goto(server.origin, { waitUntil: "load" });
  await page.evaluate(() => globalThis.harnessReady);
  for (const artifact of artifacts) {
    const vocabularyRegimes = {};
    for (const regime of regimes) {
      vocabularyRegimes[regime] = await page.evaluate(
        ({ mode, containerRegime, vocabulary, workloadIds, sampleBytes }) =>
          globalThis.harness.runDecodeRoutePricing({
            candidateMode: mode,
            containerRegime,
            vocabulary,
            workloadIds,
            targetBytesPerSample: sampleBytes,
            n: 21,
            warmup: 2,
          }),
        {
          mode: candidateMode,
          containerRegime: regime,
          vocabulary: artifact.vocabulary,
          workloadIds: workloads.map(({ id }) => id),
          sampleBytes: targetBytesPerSample,
        },
      );
    }
    chromeRegimes[artifact.vocabulary] = candidateMode === "memo"
      ? { regimes: vocabularyRegimes }
      : vocabularyRegimes[regimes[0]];
  }
  requestProof = requests.assertLocal(server.origin);
  await page.close();
} finally {
  await browser.close();
  await server.close();
}

const nodeOutput = Object.freeze({
  environment: "node",
  runtime: process.version,
  vocabularies: nodeVocabularies,
});
const chromeOutput = Object.freeze({
  environment: "chrome",
  browserVersion,
  executablePath,
  crossOriginIsolated: true,
  requestProof,
  vocabularies: chromeRegimes,
});
const output = Object.freeze({
  schemaVersion: 3,
  candidateMode,
  artifacts: artifacts.map(({ vocabulary, sourceSha256, sha256 }) =>
    Object.freeze({ vocabulary, sourceSha256, htkSha256: sha256 })
  ),
  node: nodeOutput,
  chrome: chromeOutput,
});
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
