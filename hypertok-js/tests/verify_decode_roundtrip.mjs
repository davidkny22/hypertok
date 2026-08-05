import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { chromium } from "../../benches/node_modules/playwright-core/index.mjs";
import { loadExecutionArtifactManifest } from "../../tests/suites/artifact_manifest.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const executionArtifacts = loadExecutionArtifactManifest(
  repository,
  process.env.HYPERTOK_ARTIFACT_MANIFEST,
);
const executionRoot = path.dirname(executionArtifacts.manifestPath);
const resultRoot = path.join(repository, "results", "decode-round-trip");
const singleRoot = executionArtifacts.roots["single-simd128-shipping"];
const sharedRoot = executionArtifacts.roots["shared-simd128-shipping"];
const vocabulary = path.join(repository, "hypertok-vocab", "o200k", "vocab.htk");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const bundleRoots = Object.freeze({
  vite: path.join(executionRoot, "bundlers", "vite"),
  webpack: path.join(executionRoot, "bundlers", "webpack"),
  mutation: path.join(resultRoot, "mutation"),
});

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

const nativeOutput = run("powershell", [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  path.join(repository, "tests", "decode-roundtrip", "verify.ps1"),
]);
const nativeMatch = nativeOutput.match(
  /decode-native PASS: classes=2\/2 cases=(\d+) bytes=(\d+) ids=(\d+) negatives=4\/4/,
);
assert.ok(nativeMatch, "native decode result shape changed");
const native = Object.freeze({
  classes: 2,
  cases: Number(nativeMatch[1]),
  bytes: Number(nativeMatch[2]),
  ids: Number(nativeMatch[3]),
  negatives: 4,
});
assert.equal(native.cases, 38);

const baseManifest = JSON.parse(
  fs.readFileSync(path.join(repository, "benches", "corpus", "manifest.json"), "utf8"),
);
const workloads = [
  ...baseManifest.workloads.filter((entry) => entry.role !== "arena-large").map((entry) => ({
    id: entry.id,
    path: path.join(repository, "benches", "corpus", entry.path),
    compression: entry.compression,
  })),
  { id: "boundary-empty", text: "" },
  { id: "boundary-one-pretoken", text: "alpha" },
  { id: "boundary-minimum-overlap-minus-one", text: "a".repeat(255) },
  { id: "boundary-minimum-overlap", text: "a".repeat(256) },
  { id: "boundary-minimum-overlap-plus-one", text: "a".repeat(257) },
  { id: "boundary-embedded-nul", text: "alpha\0beta" },
  { id: "boundary-multibyte", text: "\u4e2d\u6587\ud83d\ude42\u7ec8".repeat(64) },
  { id: "boundary-single-long-pretoken", text: "a".repeat(10000) },
  {
    id: "concurrent-overlap",
    text: "alpha beta gamma delta epsilon ".repeat(400) + "a".repeat(10000) + " \u7ec8",
  },
];
const uniqueWorkloads = [];
const workloadById = new Map();
for (const workload of workloads) {
  if (workloadById.has(workload.id)) continue;
  workloadById.set(workload.id, workload);
  uniqueWorkloads.push(workload);
}
assert.ok(uniqueWorkloads.length > 0);

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

function contentType(filePath) {
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript";
  return "application/octet-stream";
}

function under(root, relative) {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("refusing path outside served root");
  }
  return resolved;
}

function headers(type, isolated) {
  return {
    "Content-Type": type,
    ...(isolated
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
<script type="module">
  const parameters = new URL(location.href).searchParams;
  globalThis.resultPromise = (async () => {
    const bundler = parameters.get("bundler");
    const tier = parameters.get("tier");
    const selected = parameters.get("workload");
    await import(\`/bundle/\${bundler}/bundle.mjs\`);
    const vocabulary = new Uint8Array(await (await fetch("/vocabulary")).arrayBuffer());
    const runtimeOptions = {
      tier,
      format: "htk",
      unthreadedModuleUrl: new URL("/single/hypertok_wasm_core.js", location.href).href,
      threadedModuleUrl: new URL("/shared/hypertok_wasm_core.js", location.href).href,
      vocabulary,
      workerCount: 2,
    };
    const runtime = await globalThis.hypertokTierHarness.createTierRuntime(runtimeOptions);
    const refuge = await globalThis.hypertokTierHarness.createTierRuntime({
      ...runtimeOptions,
      tier: "single",
      optimizations: { decodeAssembly: "off", decodeTable: "off" },
    });
    const ids = ${JSON.stringify(uniqueWorkloads.map(({ id }) => id))};
    const rows = [];
    for (const workload of ids) {
      if (selected !== null && selected !== workload) continue;
      const bytes = new Uint8Array(await (await fetch(\`/workload/\${workload}\`)).arrayBuffer());
      const expected = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const encoded = await runtime.encode(bytes);
      const decoded = runtime.decode(encoded);
      const arrayDecoded = runtime.decode(Array.from(encoded));
      const refugeDecoded = refuge.decode(encoded);
      if (decoded !== expected || arrayDecoded !== expected || refugeDecoded !== expected) {
        throw new Error(\`decode mismatch for \${workload}\`);
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      rows.push({
        workload,
        bytes: bytes.length,
        ids: encoded.length,
        digest: Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(""),
      });
    }
    const targets = new Set([0x28, 0x80, 0x82, 0xac, 0xc3, 0xe2, 0xf0, 0xff]);
    const byteIds = new Map();
    for (let id = 0; id < Math.min(runtime.vocabSize(), 512); id += 1) {
      const bytes = runtime.tokenBytes(id);
      if (bytes.length === 1 && targets.has(bytes[0])) byteIds.set(bytes[0], id);
    }
    if (byteIds.size !== targets.size) throw new Error("single-byte decode fixtures are incomplete");
    const invalidFixtures = [
      [0xc3],
      [0xe2, 0x82],
      [0xf0, 0x80],
      [0xff],
      [0xc3, 0x28],
      [0xe2, 0x82, 0xac],
    ];
    for (const bytes of invalidFixtures) {
      const fixtureIds = Uint32Array.from(bytes, (value) => byteIds.get(value));
      const expected = new TextDecoder().decode(Uint8Array.from(bytes));
      if (runtime.decode(fixtureIds) !== expected || refuge.decode(fixtureIds) !== expected) {
        throw new Error(\`invalid replacement mismatch for \${bytes.join(",")}\`);
      }
    }
    const negatives = {};
    for (const [name, value] of [
      ["outOfRange", new Uint32Array([0xffffffff])],
      ["sparseGap", new Uint32Array([200000])],
      ["wrongType", "bad"],
      ["nonU32", [1.5]],
    ]) {
      try { runtime.decode(value); } catch { negatives[name] = true; }
    }
    const decodePaths = {
      auto: runtime.decodeStats(),
      refuge: refuge.decodeStats(),
      invalidFixtures: invalidFixtures.length,
    };
    await refuge.close();
    await runtime.close();
    try { runtime.decode(new Uint32Array()); } catch { negatives.afterClose = true; }
    return { bundler, tier, isolated: crossOriginIsolated, rows, negatives, decodePaths };
  })();
</script>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const isolated = url.pathname !== "/" || url.searchParams.get("tier") === "shared";
  let filePath;
  if (url.pathname === "/") {
    response.writeHead(200, headers("text/html; charset=utf-8", isolated));
    response.end(testPage);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204, headers("image/x-icon", isolated));
    response.end();
    return;
  }
  if (url.pathname === "/vocabulary") {
    filePath = vocabulary;
  } else if (url.pathname === "/shared/") {
    filePath = path.join(sharedRoot, "hypertok_wasm_core.js");
  } else if (url.pathname.startsWith("/single/")) {
    filePath = under(singleRoot, url.pathname.slice("/single/".length));
  } else if (url.pathname.startsWith("/shared/")) {
    filePath = under(sharedRoot, url.pathname.slice("/shared/".length));
  } else if (url.pathname.startsWith("/bundle/")) {
    const [, , bundler, ...relative] = url.pathname.split("/");
    const root = bundleRoots[bundler];
    if (root !== undefined) filePath = under(root, relative.join("/"));
  } else if (url.pathname.startsWith("/workload/")) {
    const workload = workloadById.get(decodeURIComponent(url.pathname.slice(10)));
    if (workload?.path !== undefined) {
      if (workload.compression === "gzip") {
        response.writeHead(200, headers("application/octet-stream", isolated));
        response.end(gunzipSync(fs.readFileSync(workload.path)));
        return;
      }
      filePath = workload.path;
    } else if (workload?.text !== undefined) {
      response.writeHead(200, headers("application/octet-stream", isolated));
      response.end(workload.text);
      return;
    }
  }
  if (filePath === undefined || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, headers("text/plain", isolated));
    response.end("not found\n");
    return;
  }
  response.writeHead(200, headers(contentType(filePath), isolated));
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
let mutationRed = false;
try {
  for (const bundler of ["vite", "webpack"]) {
    for (const tier of ["single", "worker", "shared"]) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/?bundler=${bundler}&tier=${tier}`);
      const result = await withTimeout(
        page.evaluate(() => globalThis.resultPromise),
        `${bundler}/${tier}`,
        120_000,
      );
      assert.equal(result.rows.length, uniqueWorkloads.length);
      assert.equal(result.isolated, tier === "shared");
      assert.deepEqual(result.negatives, {
        outOfRange: true,
        sparseGap: true,
        wrongType: true,
        nonU32: true,
        afterClose: true,
      });
      assert.equal(result.decodePaths.auto.assemblyEnabled, true);
      assert.equal(result.decodePaths.auto.table, true);
      assert.equal(result.decodePaths.refuge.assemblyEnabled, false);
      assert.equal(result.decodePaths.refuge.table, false);
      assert.equal(result.decodePaths.invalidFixtures, 6);
      results.push(result);
      await page.close();
    }
  }

  const page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${address.port}/?bundler=mutation&tier=single&workload=english-prose`,
  );
  try {
    await withTimeout(page.evaluate(() => globalThis.resultPromise), "decode mutation", 120_000);
  } catch {
    mutationRed = true;
  }
  await page.close();
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
assert.equal(mutationRed, true, "decode mutation did not go RED");

const commit = run("git", [
  "-c",
  `safe.directory=${repository.replaceAll("\\", "/")}`,
  "rev-parse",
  "HEAD",
]).trim();
const browserRows = results.reduce((sum, result) => sum + result.rows.length, 0);
const browserBytes = results.reduce(
  (sum, result) => sum + result.rows.reduce((rowSum, row) => rowSum + row.bytes, 0),
  0,
);
const browserIds = results.reduce(
  (sum, result) => sum + result.rows.reduce((rowSum, row) => rowSum + row.ids, 0),
  0,
);
const report = {
  schemaVersion: 1,
  commit,
  native,
  browser: {
    bundlers: 2,
    tiers: 3,
    workloads: uniqueWorkloads.length,
    rows: browserRows,
    bytes: browserBytes,
    ids: browserIds,
    negatives: results.length * 5,
    invalidFixtures: results.length * 6,
  },
  mutationRed,
  results,
};
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(path.join(resultRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ pass: true, commit, native: native.cases, browser: browserRows, negatives: native.negatives + report.browser.negatives, mutationRed })}\n`,
);
