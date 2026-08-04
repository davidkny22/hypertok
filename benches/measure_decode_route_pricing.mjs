import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserBundle } from "./browser/build.mjs";
import { launchHarnessBrowser, observeRequests } from "./browser/control.mjs";
import { startHarnessServer } from "./browser/server.mjs";
import { loadCorpus } from "./common/corpus.mjs";
import { measureDecodeRoutes } from "./common/decode_route_pricing.mjs";
import { buildBenchmarkHtk } from "./common/gpt2_htk.mjs";
import { fromBytes } from "../hypertok-js/src/index.mjs";
import { resolveShimRuntime } from "../hypertok-js/src/shim-runtime.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const candidateArgument = process.argv.find((argument) => argument.startsWith("--candidate="));
const candidateMode = candidateArgument?.slice("--candidate=".length) ?? "byte";
if (!new Set(["byte", "mixed", "fused", "lean", "memo", "run-cache", "latin1-native", "latin1-portable"]).has(candidateMode)) {
  throw new TypeError("candidate must be byte, mixed, fused, lean, memo, run-cache, latin1-native, or latin1-portable");
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
      : "route-pricing.json",
);
const htk = buildBenchmarkHtk();
const workloads = loadCorpus();
const regimes = candidateMode === "memo" ? ["repeated", "fresh"] : ["repeated"];

async function measureNode(containerRegime) {
  const baseline = await fromBytes(htk.bytes, {
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
            : { decodeMixedRuns: "off" },
  });
  const candidate = await fromBytes(htk.bytes, {
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
                  ? { decodeMemo: "off", decodeLatin1Native: "on" }
                  : candidateMode === "latin1-portable"
                    ? { decodeMemo: "off", decodeLatin1Portable: "on" }
              : { decodeByteTable: "on" },
  });
  try {
    return measureDecodeRoutes({
      baseline,
      candidate,
      workloads,
      candidateMode,
      containerRegime,
      baselineStats: () => resolveShimRuntime(baseline).decodeStats(),
      candidateStats: () => resolveShimRuntime(candidate).decodeStats(),
    });
  } finally {
    baseline.free();
    candidate.free();
  }
}

const nodeRegimes = {};
for (const regime of regimes) nodeRegimes[regime] = await measureNode(regime);

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
  for (const regime of regimes) {
    chromeRegimes[regime] = await page.evaluate(
      ({ mode, containerRegime }) => globalThis.harness.runDecodeRoutePricing({
        candidateMode: mode,
        containerRegime,
        n: 21,
        warmup: 2,
      }),
      { mode: candidateMode, containerRegime: regime },
    );
  }
  requestProof = requests.assertLocal(server.origin);
  await page.close();
} finally {
  await browser.close();
  await server.close();
}

const nodeOutput = candidateMode === "memo"
  ? Object.freeze({ environment: "node", runtime: process.version, regimes: nodeRegimes })
  : Object.freeze({ environment: "node", runtime: process.version, ...nodeRegimes.repeated });
const chromeOutput = candidateMode === "memo"
  ? Object.freeze({
      environment: "chrome",
      browserVersion,
      executablePath,
      crossOriginIsolated: true,
      requestProof,
      regimes: chromeRegimes,
    })
  : Object.freeze({
      environment: "chrome",
      browserVersion,
      executablePath,
      crossOriginIsolated: true,
      requestProof,
      ...chromeRegimes.repeated,
    });
const output = Object.freeze({
  schemaVersion: candidateMode === "memo" ? 2 : 1,
  candidateMode,
  sourceSha256: htk.sourceSha256,
  htkSha256: htk.sha256,
  node: nodeOutput,
  chrome: chromeOutput,
});
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
