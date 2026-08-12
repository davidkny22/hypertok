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
const sampleArgument = process.argv.find((argument) => argument.startsWith("--n="));
const sampleCount = sampleArgument === undefined ? 21 : Number(sampleArgument.slice("--n=".length));
const vocabularyArgument = process.argv.find((argument) => argument.startsWith("--vocabulary="));
const selectedVocabulary = vocabularyArgument?.slice("--vocabulary=".length) ?? null;
const workloadArgument = process.argv.find((argument) => argument.startsWith("--workload="));
const selectedWorkload = workloadArgument?.slice("--workload=".length) ?? null;
const excludedWorkloadArgument = process.argv.find((argument) =>
  argument.startsWith("--exclude-workload=")
);
const excludedWorkload = excludedWorkloadArgument?.slice("--exclude-workload=".length) ?? null;
const regimeArgument = process.argv.find((argument) => argument.startsWith("--regime="));
const selectedRegime = regimeArgument?.slice("--regime=".length) ?? null;
const evidenceLabelArgument = process.argv.find((argument) => argument.startsWith("--evidence-label="));
const evidenceLabel = evidenceLabelArgument?.slice("--evidence-label=".length) ?? null;
const quiet = process.argv.includes("--quiet");
const skipBrowserTiming = process.argv.includes("--skip-browser-timing");
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 128) {
  throw new TypeError("n must be an integer from 1 through 128");
}
if (!new Set(["byte", "mixed", "fused", "lean", "memo", "run-cache", "latin1-native", "latin1-portable", "direct-scratch", "clean-unroll", "borrowed-output", "utf16-output", "direct-borrowed", "cut-direct", "cut-borrowed", "dirty-batch", "dirty-batch-composed", "run-stitcher", "string-builtins"]).has(candidateMode)) {
  throw new TypeError("candidate is not supported by decode route pricing");
}
if (evidenceLabel !== null && !/^[a-z0-9-]+$/.test(evidenceLabel)) {
  throw new TypeError("evidence label must contain only lowercase letters, digits, and hyphens");
}
if (selectedRegime !== null && !new Set(["fresh", "repeated"]).has(selectedRegime)) {
  throw new TypeError("regime must be fresh or repeated");
}
const baseOutputPath = path.join(
  repositoryDirectory,
  "results",
  "decode-dirty-campaign",
  candidateMode === "dirty-batch"
    ? `dirty-batch${selectedVocabulary === null ? "" : `-${selectedVocabulary}`}-pricing-n${sampleCount}.json`
    : candidateMode === "dirty-batch-composed"
      ? `dirty-batch-composed${selectedVocabulary === null ? "" : `-${selectedVocabulary}`}-pricing-n${sampleCount}.json`
    : candidateMode === "run-stitcher"
      ? `run-stitcher${selectedVocabulary === null ? "" : `-${selectedVocabulary}`}${selectedWorkload === null ? "" : `-${selectedWorkload}`}${selectedRegime === null ? "" : `-${selectedRegime}`}-pricing-n${sampleCount}.json`
    : candidateMode === "string-builtins"
      ? `string-builtins${selectedVocabulary === null ? "" : `-${selectedVocabulary}`}${selectedWorkload === null ? "" : `-${selectedWorkload}`}-pricing-n${sampleCount}.json`
    : candidateMode === "mixed"
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
                    : candidateMode === "utf16-output"
                      ? `node-utf16-output-pricing-n${sampleCount}.json`
                      : candidateMode === "direct-borrowed"
                        ? "direct-borrowed-pricing.json"
                        : candidateMode === "cut-direct"
                          ? "cut-direct-pricing.json"
                          : candidateMode === "cut-borrowed"
                            ? "cut-borrowed-pricing.json"
      : "route-pricing.json",
);
const outputPath = evidenceLabel === null
  ? baseOutputPath
  : baseOutputPath.replace(/\.json$/, `-${evidenceLabel}.json`);
const artifacts = vocabularyRegistry
  .filter(({ id }) => selectedVocabulary === null || id === selectedVocabulary)
  .map(({ id }) => prepareVocabularyArtifact(id));
if (artifacts.length === 0) throw new TypeError(`unknown vocabulary ${selectedVocabulary}`);
const compositionModes = new Set(["direct-borrowed", "cut-direct", "cut-borrowed"]);
const decisionWorkloads = candidateMode === "dirty-batch" || candidateMode === "dirty-batch-composed"
  ? new Set(["chinese", "long-document"])
  : candidateMode === "utf16-output" || candidateMode === "string-builtins"
    ? new Set(["chinese", "long-document"])
    : candidateMode === "direct-scratch" || candidateMode === "latin1-native" || candidateMode === "borrowed-output" || compositionModes.has(candidateMode)
  ? new Set(["chinese", "emoji-heavy"])
  : candidateMode === "clean-unroll"
    ? new Set(["english-prose", "source-code", "long-document", "standard-text"])
    : null;
const workloads = loadCorpus().filter(({ id }) =>
  (decisionWorkloads === null || decisionWorkloads.has(id)) &&
  (selectedWorkload === null || id === selectedWorkload) &&
  (excludedWorkload === null || id !== excludedWorkload)
);
if (workloads.length === 0) throw new TypeError(`unknown workload ${selectedWorkload}`);
const workloadsFor = (artifact) => candidateMode !== "dirty-batch" && candidateMode !== "dirty-batch-composed"
  ? workloads
  : workloads.filter(({ id }) =>
      artifact.vocabulary === "gpt2" ? id === "long-document" : id === "chinese"
    );
const availableRegimes = candidateMode === "memo" || candidateMode === "run-stitcher"
  ? ["repeated", "fresh"]
  : candidateMode === "dirty-batch" || candidateMode === "dirty-batch-composed" || candidateMode === "string-builtins" || candidateMode === "direct-scratch" || candidateMode === "clean-unroll" || candidateMode === "latin1-native" || candidateMode === "borrowed-output" || candidateMode === "utf16-output" || compositionModes.has(candidateMode)
    ? ["fresh"]
    : ["repeated"];
const regimes = selectedRegime === null
  ? availableRegimes
  : availableRegimes.filter((regime) => regime === selectedRegime);
if (regimes.length === 0) {
  throw new TypeError(`${candidateMode} does not support the ${selectedRegime} regime`);
}
const targetBytesPerSample = candidateMode === "dirty-batch" || candidateMode === "dirty-batch-composed" || candidateMode === "run-stitcher" || candidateMode === "string-builtins" || candidateMode === "latin1-native" || candidateMode === "borrowed-output" || candidateMode === "utf16-output" || compositionModes.has(candidateMode)
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
                      : candidateMode === "utf16-output"
                        ? { decodeMemo: "off", decodeUtf16Output: "off" }
                        : candidateMode === "direct-borrowed"
                          ? { decodeMemo: "off", decodeDirectScratch: "off", decodeBorrowedOutput: "off" }
                          : candidateMode === "cut-direct" || candidateMode === "cut-borrowed"
                            ? { decodeMemo: "off", decodeDirectScratch: "on", decodeBorrowedOutput: "on" }
            : candidateMode === "dirty-batch" || candidateMode === "dirty-batch-composed"
              ? { decodeMemo: "off", decodeDirtyRunBatch: "off" }
              : candidateMode === "run-stitcher"
                ? { decodeRunStitcher: "off" }
              : candidateMode === "string-builtins"
                ? { decodeMemo: "off", decodeStringBuiltins: "off" }
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
                        : candidateMode === "utf16-output"
                          ? {
                              decodeMemo: "off",
                              decodeBorrowedOutput: "off",
                              decodeUtf16Output: "on",
                            }
                          : candidateMode === "direct-borrowed"
                            ? { decodeMemo: "off", decodeDirectScratch: "on", decodeBorrowedOutput: "on" }
                            : candidateMode === "cut-direct"
                              ? { decodeMemo: "off", decodeDirectScratch: "off", decodeBorrowedOutput: "on" }
                              : candidateMode === "cut-borrowed"
                                ? { decodeMemo: "off", decodeDirectScratch: "on", decodeBorrowedOutput: "off" }
              : candidateMode === "dirty-batch" || candidateMode === "dirty-batch-composed"
                ? { decodeMemo: "off", decodeDirtyRunBatch: "on" }
                : candidateMode === "run-stitcher"
                  ? { decodeRunStitcher: "on" }
                : candidateMode === "string-builtins"
                  ? {
                      decodeMemo: "off",
                      decodeBorrowedOutput: "off",
                      decodeStringBuiltins: "on",
                    }
                : { decodeByteTable: "on" },
  });
  try {
    return measureDecodeRoutes({
      baseline,
      candidate,
      workloads: workloadsFor(artifact),
      candidateMode,
      containerRegime,
      targetBytesPerSample,
      n: sampleCount,
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
  nodeVocabularies[artifact.vocabulary] = candidateMode === "memo" || candidateMode === "run-stitcher"
    ? { regimes: nodeRegimes }
    : nodeRegimes[regimes[0]];
}

await buildBrowserBundle();
const server = await startHarnessServer();
const { browser, browserVersion, executablePath } = await launchHarnessBrowser();
const chromeRegimes = {};
let requestProof;
let chromeUntouched = null;
try {
  const page = await browser.newPage();
  const requests = observeRequests(page);
  await page.goto(server.origin, { waitUntil: "load" });
  await page.evaluate(() => globalThis.harnessReady);
  for (const artifact of artifacts) {
    if (skipBrowserTiming) {
      chromeUntouched = await page.evaluate(
        async ({ vocabulary }) => {
          return globalThis.harness.probeDecodeConfig({
            vocabulary,
            optimizations: {
              decodeMemo: "off",
              decodeBorrowedOutput: "off",
              decodeUtf16Output: "on",
            },
          });
        },
        { vocabulary: artifact.vocabulary },
      );
      break;
    }
    const vocabularyRegimes = {};
    for (const regime of regimes) {
      vocabularyRegimes[regime] = await page.evaluate(
        ({ mode, containerRegime, vocabulary, workloadIds, sampleBytes, samples }) =>
          globalThis.harness.runDecodeRoutePricing({
            candidateMode: mode,
            containerRegime,
            vocabulary,
            workloadIds,
            targetBytesPerSample: sampleBytes,
            n: samples,
            warmup: 2,
          }),
        {
          mode: candidateMode,
          containerRegime: regime,
          vocabulary: artifact.vocabulary,
          workloadIds: workloadsFor(artifact).map(({ id }) => id),
          sampleBytes: targetBytesPerSample,
          samples: sampleCount,
        },
      );
    }
    chromeRegimes[artifact.vocabulary] = candidateMode === "memo" || candidateMode === "run-stitcher"
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
  untouched: chromeUntouched,
});
const output = Object.freeze({
  schemaVersion: 3,
  candidateMode,
  sampleCount,
  artifacts: artifacts.map(({ vocabulary, sourceSha256, sha256 }) =>
    Object.freeze({ vocabulary, sourceSha256, htkSha256: sha256 })
  ),
  node: nodeOutput,
  chrome: chromeOutput,
});
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(quiet ? JSON.stringify({ outputPath, sampleCount }) : JSON.stringify(output, null, 2));
