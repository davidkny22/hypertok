import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "../../benches/node_modules/playwright-core/index.mjs";
import { loadExecutionArtifactManifest } from "../../tests/suites/artifact_manifest.mjs";
import { selectTier } from "../src/tier-runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const executionArtifacts = loadExecutionArtifactManifest(
  repository,
  process.env.HYPERTOK_ARTIFACT_MANIFEST,
);
const resultRoot = path.dirname(executionArtifacts.manifestPath);
const singleRoot = executionArtifacts.roots["single-scalar"];
const sharedRoot = executionArtifacts.roots["shared-scalar"];
const singleSimdRoot = executionArtifacts.roots["single-simd128-shipping"];
const sharedSimdRoot = executionArtifacts.roots["shared-simd128-shipping"];
const vocabularyFormat = process.env.HYPERTOK_FORMAT ?? "htk";
const vocabulary =
  vocabularyFormat === "htk"
    ? path.join(repository, "hypertok-vocab", "o200k", "vocab.htk")
    : path.join(repository, "results", "sources", "o200k_base.tiktoken");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const bundlerRoots = Object.freeze({
  vite: path.join(resultRoot, "bundlers", "vite"),
  webpack: path.join(resultRoot, "bundlers", "webpack"),
});
const mutationRoots = Object.freeze({
  "mutation-reorder": path.join(resultRoot, "mutations", "reorder"),
  "mutation-corrupt": path.join(resultRoot, "mutations", "corrupt"),
});
const bundleRoots = Object.freeze({ ...bundlerRoots, ...mutationRoots });

const baseManifest = JSON.parse(
  fs.readFileSync(path.join(repository, "benches", "corpus", "manifest.json"), "utf8"),
);
const workloads = [
  ...baseManifest.workloads.map((entry) => ({
    id: entry.id,
    path: path.join(repository, "benches", "corpus", entry.path),
  })),
  { id: "boundary-empty", text: "" },
  { id: "boundary-one-pretoken", text: "alpha" },
  { id: "boundary-minimum-overlap-minus-one", text: "a".repeat(255) },
  { id: "boundary-minimum-overlap", text: "a".repeat(256) },
  { id: "boundary-minimum-overlap-plus-one", text: "a".repeat(257) },
  { id: "boundary-embedded-nul", text: "alpha\0beta" },
  { id: "boundary-multibyte", text: "中文🙂ç»".repeat(64) },
  { id: "boundary-single-long-pretoken", text: "a".repeat(10000) },
  {
    id: "concurrent-overlap",
    text: "alpha beta gamma delta epsilon ".repeat(4_000) + "a".repeat(100_000) + " 终",
  },
];
const workloadById = new Map(workloads.map((workload) => [workload.id, workload]));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repository,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function withTimeout(promise, label, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const oracle = JSON.parse(
  run("python", [path.join(repository, "hypertok-js", "tests", "oracle_o200k.py")], {
    input: JSON.stringify({
      workloads: workloads.map((workload) =>
        workload.path === undefined
          ? {
              id: workload.id,
              bytes_base64: Buffer.from(workload.text, "utf8").toString("base64"),
            }
          : workload,
      ),
    }),
  }),
);
const oracleById = new Map(oracle.rows.map((row) => [row.workload, row]));

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function inspectArtifactPair(singleDirectory, sharedDirectory, sharedTarget) {
  const singleWasm = path.join(singleDirectory, "hypertok_wasm_core_bg.wasm");
  const sharedWasm = path.join(sharedDirectory, "hypertok_wasm_core_bg.wasm");
  const sharedRawWasm = path.join(
    resultRoot,
    sharedTarget,
    "wasm32-unknown-unknown",
    "release",
    "hypertok.wasm",
  );
  const singleModule = new WebAssembly.Module(fs.readFileSync(singleWasm));
  const sharedModule = new WebAssembly.Module(fs.readFileSync(sharedWasm));
  const singleImports = WebAssembly.Module.imports(singleModule);
  const sharedImports = WebAssembly.Module.imports(sharedModule);
  const singleExports = WebAssembly.Module.exports(singleModule);
  const sharedExports = WebAssembly.Module.exports(sharedModule);
  assert.equal(singleImports.some((entry) => entry.kind === "memory"), false);
  assert.equal(singleExports.filter((entry) => entry.kind === "memory").length, 1);
  assert.equal(sharedImports.filter((entry) => entry.kind === "memory").length, 1);
  assert.equal(sharedExports.filter((entry) => entry.kind === "memory").length, 1);
  const sharedRawModule = new WebAssembly.Module(fs.readFileSync(sharedRawWasm));
  const sharedNames = new Set(WebAssembly.Module.exports(sharedRawModule).map((entry) => entry.name));
  for (const name of ["__wasm_init_tls", "__tls_size", "__tls_align", "__tls_base", "initThreadPool"]) {
    assert.equal(sharedNames.has(name), true, `threaded artifact is missing ${name}`);
  }
  const sharedGlue = fs.readFileSync(
    path.join(sharedDirectory, "hypertok_wasm_core.js"),
    "utf8",
  );
  assert.match(sharedGlue, /WebAssembly\.Memory\(\{[^}]*shared:true/);
  return {
    single: { bytes: fs.statSync(singleWasm).size, sha256: sha256(singleWasm) },
    shared: {
      bytes: fs.statSync(sharedWasm).size,
      sha256: sha256(sharedWasm),
      rawBytes: fs.statSync(sharedRawWasm).size,
      rawSha256: sha256(sharedRawWasm),
    },
  };
}

const artifacts = {
  scalar: inspectArtifactPair(singleRoot, sharedRoot, "shared-target"),
  simd128: inspectArtifactPair(singleSimdRoot, sharedSimdRoot, "shared-simd-target"),
};
assert.notEqual(artifacts.scalar.single.sha256, artifacts.simd128.single.sha256);
assert.notEqual(artifacts.scalar.shared.sha256, artifacts.simd128.shared.sha256);

const availabilityChecks = [
  ["auto-shared", "shared", () => selectTier("auto", { isolated: true, sharedArrayBuffer: true, worker: true })],
  ["auto-worker", "worker", () => selectTier("auto", { isolated: false, sharedArrayBuffer: true, worker: true })],
  ["auto-single", "single", () => selectTier("auto", { isolated: false, sharedArrayBuffer: false, worker: false })],
];
for (const [, expected, operation] of availabilityChecks) assert.equal(operation(), expected);
const unavailableChecks = [
  () => selectTier("shared", { isolated: false, sharedArrayBuffer: true, worker: true }),
  () => selectTier("shared", { isolated: true, sharedArrayBuffer: false, worker: true }),
  () => selectTier("shared", { isolated: true, sharedArrayBuffer: true, worker: false }),
  () => selectTier("shared", { isolated: true, sharedArrayBuffer: true, worker: true }, false),
  () => selectTier("worker", { isolated: true, sharedArrayBuffer: true, worker: true }),
  () => selectTier("worker", { isolated: false, sharedArrayBuffer: true, worker: false }),
];
for (const operation of unavailableChecks) assert.throws(operation, /unavailable/);

function contentType(filePath) {
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function under(root, relative) {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("refusing path outside served root");
  }
  return resolved;
}

function headers(type, isolatedDocument = true) {
  return {
    "Content-Type": type,
    ...(isolatedDocument
      ? {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        }
      : {}),
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
  };
}

const testPage = `<!doctype html>
<meta charset="utf-8">
<title>execution tier parity</title>
<script type="module">
  const parameters = new URL(location.href).searchParams;
  globalThis.resultPromise = (async () => {
    const bundler = parameters.get("bundler");
    const tier = parameters.get("tier");
    const format = parameters.get("format") ?? "tiktoken";
    const simdLevel = parameters.get("simd") ?? "scalar";
    const artifactSuffix = simdLevel === "simd128" ? "-simd" : "";
    await import(\`/bundle/\${bundler}/bundle.mjs\`);
    const vocabulary = new Uint8Array(await (await fetch("/vocabulary")).arrayBuffer());
    const runtime = await globalThis.hypertokTierHarness.createTierRuntime({
      tier,
      unthreadedModuleUrl: new URL(\`/single\${artifactSuffix}/hypertok_wasm_core.js\`, location.href).href,
      threadedModuleUrl: new URL(\`/shared\${artifactSuffix}/hypertok_wasm_core.js\`, location.href).href,
      vocabulary,
      scheme: "o200k",
      format,
      workerCount: 2,
    });
    const digestIds = async (ids) => {
      const bytes = new Uint8Array(ids.length * 4);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < ids.length; index += 1) {
        view.setUint32(index * 4, ids[index], true);
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    };
    const requestedWorkload = parameters.get("workload");
    const workloadIds = requestedWorkload === null
      ? ${JSON.stringify(workloads.map(({ id }) => id))}
      : [requestedWorkload];
    const rows = [];
    for (const workload of workloadIds) {
      const bytes = new Uint8Array(await (await fetch(\`/workload/\${workload}\`)).arrayBuffer());
      const ids = await runtime.encode(bytes);
      rows.push({ workload, bytes: bytes.length, ids: ids.length, digest: await digestIds(ids) });
    }
    let invalidUtf8Refused = false;
    try {
      await runtime.encode(new Uint8Array([0x61, 0xff]));
    } catch {
      invalidUtf8Refused = true;
    }
    const result = {
      bundler,
      requestedTier: tier,
      actualTier: runtime.tier,
      simdLevel,
      isolated: crossOriginIsolated,
      hasEncodeSync: "encodeSync" in runtime,
      invalidUtf8Refused,
      telemetry: runtime.telemetry(),
      rows,
    };
    await runtime.close();
    return result;
  })();
</script>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  let filePath;
  if (url.pathname === "/") {
    const isolated = url.searchParams.get("tier") !== "worker";
    response.writeHead(200, headers("text/html; charset=utf-8", isolated));
    response.end(testPage);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204, headers("image/x-icon"));
    response.end();
    return;
  }
  if (url.pathname === "/vocabulary") {
    filePath = vocabulary;
  } else if (url.pathname === "/shared/") {
    filePath = path.join(sharedRoot, "hypertok_wasm_core.js");
  } else if (url.pathname === "/shared-simd/") {
    filePath = path.join(sharedSimdRoot, "hypertok_wasm_core.js");
  } else if (url.pathname.startsWith("/single-simd/")) {
    filePath = under(singleSimdRoot, url.pathname.slice("/single-simd/".length));
  } else if (url.pathname.startsWith("/shared-simd/")) {
    filePath = under(sharedSimdRoot, url.pathname.slice("/shared-simd/".length));
  } else if (url.pathname.startsWith("/single/")) {
    filePath = under(singleRoot, url.pathname.slice("/single/".length));
  } else if (url.pathname.startsWith("/shared/")) {
    filePath = under(sharedRoot, url.pathname.slice("/shared/".length));
  } else if (url.pathname.startsWith("/bundle/")) {
    const [, , bundler, ...relative] = url.pathname.split("/");
    const root = bundleRoots[bundler];
    if (root !== undefined) filePath = under(root, relative.join("/"));
  } else if (url.pathname.startsWith("/workload/")) {
    const workload = workloadById.get(decodeURIComponent(url.pathname.slice("/workload/".length)));
    if (workload?.path !== undefined) {
      filePath = workload.path;
    } else if (workload?.text !== undefined) {
      response.writeHead(200, headers("text/plain; charset=utf-8"));
      response.end(workload.text);
      return;
    }
  }
  if (filePath === undefined || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, headers("text/plain; charset=utf-8"));
    response.end("not found\n");
    return;
  }
  response.writeHead(200, headers(contentType(filePath)));
  fs.createReadStream(filePath).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (typeof address === "string" || address === null) throw new Error("server did not bind");

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const results = [];
let bundleMutationsRed = 0;
const selectedBundlers = process.env.HYPERTOK_BUNDLER
  ? [process.env.HYPERTOK_BUNDLER]
  : Object.keys(bundlerRoots);
const selectedTiers = process.env.HYPERTOK_TIER
  ? [process.env.HYPERTOK_TIER]
  : ["single", "worker", "shared"];
try {
  const matrix = selectedBundlers.flatMap((bundler) =>
    selectedTiers.map((tier) => ({ bundler, tier, simdLevel: "scalar" })),
  );
  if (process.env.HYPERTOK_BUNDLER === undefined && process.env.HYPERTOK_TIER === undefined) {
    matrix.push(
      ...["single", "worker", "shared"].map((tier) => ({
        bundler: "vite",
        tier,
        simdLevel: "simd128",
        workload: "concurrent-overlap",
      })),
    );
  }
  for (const { bundler, tier, simdLevel, workload } of matrix) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("requestfailed", (request) =>
        process.stderr.write(`request-failed ${request.url()} ${request.failure()?.errorText}\n`),
      );
      page.on("response", (response) => {
        if (!response.ok()) {
          process.stderr.write(`response ${response.status()} ${response.url()}\n`);
        }
      });
      await page.goto(
        `http://127.0.0.1:${address.port}/?bundler=${encodeURIComponent(bundler)}&tier=${tier}&format=${vocabularyFormat}&simd=${simdLevel}${workload === undefined ? "" : `&workload=${workload}`}`,
      );
      const result = await withTimeout(
        page.evaluate(() => globalThis.resultPromise),
        `${bundler}/${tier}/${simdLevel}`,
        120_000,
      );
      assert.deepEqual(errors, [], `${bundler}/${tier} page errors`);
      assert.equal(result.actualTier, tier);
      assert.equal(result.simdLevel, simdLevel);
      assert.equal(result.invalidUtf8Refused, true);
      assert.equal(result.hasEncodeSync, tier === "single");
      assert.equal(result.isolated, tier !== "worker");
      assert.equal(result.rows.length, workload === undefined ? workloads.length : 1);
      for (let index = 0; index < result.rows.length; index += 1) {
        const row = result.rows[index];
        const expected = oracleById.get(row.workload);
        assert.equal(row.workload, expected.workload);
        assert.equal(row.bytes, expected.bytes, `${bundler}/${tier}/${row.workload} bytes`);
        assert.equal(row.ids, expected.ids, `${bundler}/${tier}/${row.workload} id count`);
        assert.equal(row.digest, expected.digest, `${bundler}/${tier}/${row.workload} digest`);
      }
      if (tier !== "single") {
        assert.equal(result.telemetry.fallback, false);
        assert.equal(
          result.telemetry.activeWorkers,
          2,
          `${bundler}/${tier}/${simdLevel}/${workload ?? "all"} active workers`,
        );
        assert.ok(result.telemetry.initialChunks > result.telemetry.pretokens);
      }
      results.push(result);
      await page.close();
  }
  if (process.env.HYPERTOK_BUNDLER === undefined && process.env.HYPERTOK_TIER === undefined) {
    for (const mutation of [
      { bundler: "mutation-reorder", tier: "worker", workload: "english-prose" },
      { bundler: "mutation-corrupt", tier: "shared", workload: "concurrent-overlap" },
    ]) {
      const page = await browser.newPage();
      await page.goto(
        `http://127.0.0.1:${address.port}/?bundler=${mutation.bundler}&tier=${mutation.tier}&format=${vocabularyFormat}&workload=${mutation.workload}`,
      );
      const result = await withTimeout(
        page.evaluate(() => globalThis.resultPromise),
        `${mutation.bundler}/${mutation.tier}`,
        120_000,
      );
      assert.equal(result.rows.length, 1);
      assert.notEqual(
        result.rows[0].digest,
        oracleById.get(mutation.workload).digest,
        `${mutation.bundler} did not go RED`,
      );
      bundleMutationsRed += 1;
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

let oracleMutationRed = false;
try {
  const replacement = oracle.rows[0].digest[0] === "0" ? "1" : "0";
  const mutated = { ...oracle.rows[0], digest: `${replacement}${oracle.rows[0].digest.slice(1)}` };
  assert.equal(results[0].rows[0].digest, mutated.digest);
} catch {
  oracleMutationRed = true;
}
assert.equal(oracleMutationRed, true, "oracle digest mutation did not go RED");

let availabilityMutationRed = false;
try {
  assert.equal(
    selectTier("auto", { isolated: false, sharedArrayBuffer: true, worker: true }),
    "shared",
  );
} catch {
  availabilityMutationRed = true;
}
assert.equal(availabilityMutationRed, true, "tier availability mutation did not go RED");

const commit = run("git", [
  "-c",
  `safe.directory=${repository.replaceAll("\\", "/")}`,
  "rev-parse",
  "HEAD",
]);
const report = {
  schemaVersion: 1,
  commit,
  oracle: { name: oracle.oracle, version: oracle.version },
  bundlers: { vite: "8.2.0", webpack: "5.109.2" },
  artifacts,
  coverage: {
    bundlers: Object.keys(bundlerRoots).length,
    tiers: 3,
    workloads: workloads.length,
    rows: results.reduce((sum, result) => sum + result.rows.length, 0),
    scalarRows: results
      .filter((result) => result.simdLevel === "scalar")
      .reduce((sum, result) => sum + result.rows.length, 0),
    simd128Rows: results
      .filter((result) => result.simdLevel === "simd128")
      .reduce((sum, result) => sum + result.rows.length, 0),
    invalidUtf8: results.length,
    availabilityPositive: availabilityChecks.length,
    availabilityNegative: unavailableChecks.length,
    mutationsRed: 2 + bundleMutationsRed,
  },
  results,
};
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(path.join(resultRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    pass: true,
    commit,
    rows: report.coverage.rows,
    bundlers: report.coverage.bundlers,
    tiers: report.coverage.tiers,
    workloads: report.coverage.workloads,
    invalidUtf8: report.coverage.invalidUtf8,
    mutationsRed: report.coverage.mutationsRed,
  })}\n`,
);
