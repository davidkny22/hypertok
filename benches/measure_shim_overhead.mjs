import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchHarnessBrowser, observeRequests } from "./browser/control.mjs";
import { startHarnessServer } from "./browser/server.mjs";
import { loadCorpus } from "./common/corpus.mjs";
import { identityDigest } from "./common/identity.mjs";
import { writeRunResult } from "./common/output.mjs";
import { buildShippingRunIdentity } from "./common/shipping_identity.mjs";
import { summarize } from "./common/timing.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultRoot = path.join(repository, "results", "shim-fidelity");
const wasmRoot = path.join(repository, "hypertok-js", "wasm", "single");
const vocabulary = path.join(repository, "hypertok-vocab", "o200k", "vocab.htk");
const runtimePath = path.join(repository, "hypertok-js", "src", "tier-runtime.mjs");
const optimizationPath = path.join(repository, "hypertok-js", "src", "optimization-config.mjs");
const tiktokenShimPath = path.join(repository, "hypertok-js", "src", "tiktoken-shim.mjs");
const huggingFaceShimPath = path.join(repository, "hypertok-js", "src", "huggingface-shim.mjs");
const mode = process.env.HYPERTOK_BENCH_MODE ?? "full";
const n = mode === "smoke" ? 1 : 31;
const warmupCount = mode === "smoke" ? 0 : 3;
const corpus = loadCorpus();

function gitHead() {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${repository.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repository, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const workloadIds = corpus.map(({ id }) => id);
const testPage = `<!doctype html>
<meta charset="utf-8">
<script type="module">
  const workloadIds = ${JSON.stringify(workloadIds)};
  const n = ${n};
  const warmupCount = ${warmupCount};
  globalThis.resultPromise = (async () => {
    if (!globalThis.crossOriginIsolated) throw new Error("measurement page is not isolated");
    const { createTierRuntime } = await import("/runtime.mjs");
    const { createTiktokenShim } = await import("/tiktoken-shim.mjs");
    const { createHuggingFaceShim } = await import("/huggingface-shim.mjs");
    const vocabulary = new Uint8Array(await (await fetch("/vocabulary")).arrayBuffer());
    const runtime = await createTierRuntime({
      tier: "single",
      format: "htk",
      unthreadedModuleUrl: new URL("/single/hypertok_wasm_core.js", location.href).href,
      vocabulary,
    });
    const tiktoken = createTiktokenShim(runtime, { name: "o200k_base" });
    const tokenStrings = Array.from({ length: 200019 }, (_, id) => String(id));
    const huggingFace = createHuggingFaceShim(runtime, {
      tokenString: (id) => tokenStrings[id],
      postProcess: (first, second) => ({
        ids: second === null ? first : [...first, ...second],
        token_type_ids: second === null
          ? first.map(() => 0)
          : [...first.map(() => 0), ...second.map(() => 1)],
      }),
      specialTokens: ["<|endoftext|>", "<|endofprompt|>"],
      unknownTokenId: 0,
      cleanUpTokenizationSpaces: false,
    });
    const rows = [];
    let checksum = 0;
    for (const workload of workloadIds) {
      const text = await (await fetch("/corpus/" + workload + ".txt")).text();
      const directTiktoken = () => runtime.encodeReservedSync(text, { match: "all" }).ids;
      const shimTiktoken = () => tiktoken.encode(text, "all");
      const directHuggingFace = () => runtime.encodeReservedSync(text).ids;
      const shimHuggingFace = () => huggingFace.encode(text, { add_special_tokens: false }).ids;
      for (const action of [directTiktoken, shimTiktoken, directHuggingFace, shimHuggingFace]) {
        for (let warmup = 0; warmup < warmupCount; warmup += 1) checksum += action().length;
      }
      for (const [shim, direct, adapted] of [
        ["tiktoken", directTiktoken, shimTiktoken],
        ["huggingface", directHuggingFace, shimHuggingFace],
      ]) {
        const directSamples = [];
        const shimSamples = [];
        for (let iteration = 0; iteration < n; iteration += 1) {
          const ordered = iteration % 2 === 0
            ? [[direct, directSamples], [adapted, shimSamples]]
            : [[adapted, shimSamples], [direct, directSamples]];
          for (const [action, samples] of ordered) {
            const started = performance.now();
            const ids = action();
            samples.push(performance.now() - started);
            checksum += ids.length;
          }
        }
        const directIds = direct();
        const shimIds = adapted();
        if (
          directIds.length !== shimIds.length ||
          !Array.from(directIds).every((id, index) => id === shimIds[index])
        ) {
          throw new Error(shim + " output mismatch on " + workload);
        }
        rows.push({ workload, shim, directSamples, shimSamples });
      }
    }
    await runtime.close();
    return {
      rows,
      checksum,
      tier: "single",
      simdLevel: "scalar",
      clockRegime: "cross-origin-isolated performance.now",
    };
  })();
</script>`;

const additionalRoutes = new Map([
  ["/runtime.mjs", [runtimePath, "text/javascript; charset=utf-8"]],
  ["/optimization-config.mjs", [optimizationPath, "text/javascript; charset=utf-8"]],
  ["/tiktoken-shim.mjs", [tiktokenShimPath, "text/javascript; charset=utf-8"]],
  ["/huggingface-shim.mjs", [huggingFaceShimPath, "text/javascript; charset=utf-8"]],
  ["/vocabulary", [vocabulary, "application/octet-stream"]],
  [
    "/single/hypertok_wasm_core.js",
    [path.join(wasmRoot, "hypertok_wasm_core.js"), "text/javascript; charset=utf-8"],
  ],
  [
    "/single/hypertok_wasm_core_bg.wasm",
    [path.join(wasmRoot, "hypertok_wasm_core_bg.wasm"), "application/wasm"],
  ],
]);
const server = await startHarnessServer({ pageContent: testPage, additionalRoutes });
let measured;
let requestProof;
let browserDetails;
try {
  browserDetails = await launchHarnessBrowser();
  const { browser } = browserDetails;
  const page = await browser.newPage();
  const requests = observeRequests(page);
  await page.goto(server.origin);
  measured = await page.evaluate(() => globalThis.resultPromise);
  requestProof = requests.assertLocal(server.origin);
  await page.close();
} finally {
  if (browserDetails !== undefined) await browserDetails.browser.close();
  await server.close();
}

assert.ok(measured.checksum > 0, "measurement output was not consumed");
assert.equal(measured.rows.length, workloadIds.length * 2);

const rows = measured.rows.map((row) => {
  const direct = summarize(row.directSamples);
  const adapted = summarize(row.shimSamples);
  return {
    profile: "shipping",
    mode,
    workload: row.workload,
    shim: row.shim,
    reference: `${row.shim}-shim`,
    referenceVersion: "0.1.0",
    environment: "browser",
    tier: measured.tier,
    simdLevel: measured.simdLevel,
    clockRegime: measured.clockRegime,
    units: "ms",
    n: adapted.n,
    median: adapted.median,
    p95: adapted.p95,
    variance: adapted.variance,
    ratio: direct.median / adapted.median,
    direct,
    adapted,
    latencyRatio: adapted.median / direct.median,
    overheadPercent: ((adapted.median - direct.median) / direct.median) * 100,
  };
});
for (const row of rows) {
  assert.equal(row.direct.n, n);
  assert.equal(row.adapted.n, n);
  for (const value of [row.ratio, row.latencyRatio, row.overheadPercent]) {
    assert.ok(Number.isFinite(value));
  }
}

const commit = gitHead();
const runIdentity = buildShippingRunIdentity({
  environment: "browser",
  commit,
  artifacts: [
    { label: "wasm-js", filePath: path.join(wasmRoot, "hypertok_wasm_core.js") },
    { label: "wasm", filePath: path.join(wasmRoot, "hypertok_wasm_core_bg.wasm") },
    { label: "htk", filePath: vocabulary },
    { label: "runtime", filePath: runtimePath },
    { label: "optimization-config", filePath: optimizationPath },
    { label: "tiktoken-shim", filePath: tiktokenShimPath },
    { label: "huggingface-shim", filePath: huggingFaceShimPath },
  ],
});
const agreementKey = identityDigest({
  runIdentityKey: runIdentity.runKey,
  workloads: workloadIds,
  shims: ["tiktoken", "huggingface"],
  result: "exact",
});
const identifiedRows = rows.map((row) => ({
  ...row,
  agreementKey,
  artifactSha256: runIdentity.artifactSha256,
  corpusSha256: runIdentity.corpusSha256,
  modelSha256: runIdentity.modelSha256,
}));
const report = {
  schemaVersion: 1,
  profile: "shipping",
  mode,
  environment: "browser",
  commit,
  browser: {
    version: browserDetails.browserVersion,
    executablePath: browserDetails.executablePath,
    executableSource: browserDetails.executableSource,
  },
  runIdentity,
  agreementKey,
  method: {
    n,
    warmup: warmupCount,
    order: "alternating paired direct and adapted calls",
    scope: "synchronous resident-single encode adapter seam",
    tokenStringLookup: "precomputed array lookup outside timing",
  },
  rows: identifiedRows,
  requests: { local: requestProof.requestCount, external: 0, failed: 0 },
};
const publicOutput = writeRunResult({
  runIdentity,
  mode,
  axis: "shim-overhead",
  result: report,
});
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(
  path.join(resultRoot, "overhead.json"),
  `${JSON.stringify(publicOutput.result, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    pass: true,
    rows: identifiedRows.length,
    resultPath: publicOutput.resultPath,
    runKey: publicOutput.runKey,
    session: publicOutput.session,
  })}\n`,
);
