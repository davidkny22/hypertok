import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "../../benches/node_modules/playwright-core/index.mjs";
import { loadExecutionArtifactManifest } from "../../tests/suites/artifact_manifest.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const executionArtifacts = loadExecutionArtifactManifest(
  repository,
  process.env.HYPERTOK_ARTIFACT_MANIFEST,
);
const resultRoot = path.dirname(executionArtifacts.manifestPath);
const singleRoot = executionArtifacts.roots["single-scalar"];
const sharedRoot = executionArtifacts.roots["shared-scalar"];
const vocabulary = path.join(repository, "hypertok-vocab", "o200k", "vocab.htk");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const bundleRoots = Object.freeze({
  vite: path.join(resultRoot, "bundlers", "vite"),
  webpack: path.join(resultRoot, "bundlers", "webpack"),
  "transfer-corrupt": path.join(resultRoot, "mutations", "transfer-corrupt"),
  "source-digest": path.join(resultRoot, "mutations", "source-digest"),
  "source-rebuild": path.join(resultRoot, "mutations", "source-rebuild"),
  "pool-reload": path.join(resultRoot, "mutations", "pool-reload"),
  "resident-replace": path.join(resultRoot, "mutations", "resident-replace"),
});

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
    text: "alpha beta gamma delta epsilon ".repeat(400) + "a".repeat(10000) + " ç»",
  },
];
const workloadById = new Map(workloads.map((workload) => [workload.id, workload]));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repository,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const hashTestOutput = run("cargo", [
  "+stable-x86_64-pc-windows-msvc",
  "test",
  "--manifest-path",
  path.join(repository, "hypertok-hash", "Cargo.toml"),
  "--lib",
]);
assert.match(hashTestOutput, /4 passed/);

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
          ? { id: workload.id, bytes_base64: Buffer.from(workload.text).toString("base64") }
          : workload,
      ),
    }),
  }),
);
const oracleById = new Map(oracle.rows.map((row) => [row.workload, row]));

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
    const target = parameters.get("target");
    await import(\`/bundle/\${bundler}/bundle.mjs\`);
    const vocabulary = new Uint8Array(await (await fetch("/vocabulary")).arrayBuffer());
    const wasm = await import("/single/hypertok_wasm_core.js");
    await wasm.default();
    const imageSource = wasm.WasmTokenizer.fromHtk(vocabulary);
    const workerImage = imageSource.exportWorkerImage();
    const sourceDigest = imageSource.vocabularyDigest();
    const redigest = async (image) => {
      image.fill(0, 32, 64);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", image));
      image.set(digest, 32);
      return image;
    };
    const mutations = [];
    mutations.push({ image: workerImage.slice(0, 100), digest: sourceDigest });
    const trailing = new Uint8Array(workerImage.length + 1);
    trailing.set(workerImage);
    mutations.push({ image: await redigest(trailing), digest: sourceDigest });
    for (const [offset, value] of [[4, 2], [6, 9], [7, 9], [9, 1]]) {
      const image = workerImage.slice();
      image[offset] = value;
      mutations.push({ image: await redigest(image), digest: sourceDigest });
    }
    const payloadCorrupt = workerImage.slice();
    payloadCorrupt[payloadCorrupt.length - 1] ^= 1;
    mutations.push({ image: payloadCorrupt, digest: sourceDigest });
    const wrongDigest = sourceDigest.slice();
    wrongDigest[0] ^= 1;
    mutations.push({ image: workerImage, digest: wrongDigest });
    const badBaseCount = workerImage.slice();
    new DataView(badBaseCount.buffer).setUint32(28, 2, true);
    mutations.push({ image: await redigest(badBaseCount), digest: sourceDigest });
    const badIntraCount = workerImage.slice();
    new DataView(badIntraCount.buffer).setUint32(96, 1, true);
    mutations.push({ image: await redigest(badIntraCount), digest: sourceDigest });
    const badOffset = workerImage.slice();
    const badOffsetView = new DataView(badOffset.buffer);
    const intraStart = 112 + badOffsetView.getUint32(24, true)
      + badOffsetView.getUint32(28, true) * 4;
    badOffsetView.setUint16(intraStart + 2, 0xffff, true);
    mutations.push({ image: await redigest(badOffset), digest: sourceDigest });
    const badByteId = workerImage.slice();
    new DataView(badByteId.buffer).setUint32(badByteId.length - 1024, 0xffffffff, true);
    mutations.push({ image: await redigest(badByteId), digest: sourceDigest });
    let typedImageChecks = 0;
    for (const mutation of mutations) {
      try {
        wasm.WasmTransferredTokenizer.fromWorkerImage(mutation.image, mutation.digest);
      } catch {
        typedImageChecks += 1;
      }
    }
    if (typedImageChecks !== mutations.length || mutations.length !== 12) {
      throw new Error(\`typed image refusals \${typedImageChecks}/\${mutations.length}\`);
    }
    imageSource.free();
    const inputs = new Map();
    for (const workload of ${JSON.stringify(workloads.map(({ id }) => id))}) {
      inputs.set(workload, new Uint8Array(await (await fetch(\`/workload/\${workload}\`)).arrayBuffer()));
    }
    const digestIds = async (ids) => {
      const bytes = new Uint8Array(ids.length * 4);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < ids.length; index += 1) view.setUint32(index * 4, ids[index], true);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    };
    const makeRuntime = (tier) => globalThis.hypertokTierHarness.createTierRuntime({
      tier,
      format: "htk",
      unthreadedModuleUrl: new URL("/single/hypertok_wasm_core.js", location.href).href,
      threadedModuleUrl: new URL("/shared/hypertok_wasm_core.js", location.href).href,
      vocabulary,
      workerCount: 2,
    });
    const runSession = async (startTier, sequence) => {
      let handle;
      try {
        handle = await makeRuntime(startTier);
      } catch (error) {
        throw new Error(\`create \${startTier}: \${error.message}\`);
      }
      const handles = [handle];
      const rows = [];
      for (let step = 0; step < sequence.length; step += 1) {
        const tier = sequence[step];
        if (step !== 0) {
          try {
            handle = await handle.switchTier(tier);
          } catch (error) {
            throw new Error(\`switch \${startTier} step \${step} to \${tier}: \${error.message}\`);
          }
          handles.push(handle);
        }
        if (("encodeSync" in handle) !== (tier === "single")) {
          throw new Error(\`encodeSync shape mismatch for \${tier}\`);
        }
        for (const [workload, bytes] of inputs) {
          let ids;
          try {
            ids = await handle.encode(bytes);
          } catch (error) {
            throw new Error(\`encode \${startTier} step \${step} \${tier} \${workload}: \${error.message}\`);
          }
          rows.push({
            step,
            tier,
            workload,
            bytes: bytes.length,
            ids: ids.length,
            digest: await digestIds(ids),
          });
        }
      }
      const lifecycle = handle.lifecycle();
      const unavailable = target === "worker" ? "shared" : "worker";
      let unavailableRejected = false;
      try {
        await handle.switchTier(unavailable);
      } catch {
        unavailableRejected = true;
      }
      const proof = await handle.encode(inputs.get("boundary-one-pretoken"));
      const singleHandle = handles.find((candidate) => candidate.tier === "single");
      const special = new TextEncoder().encode("<|endoftext|>");
      const specialSingle = await singleHandle.encode(special);
      const specialTarget = await handle.encode(special);
      const specialExact = specialSingle.length === specialTarget.length
        && specialSingle.every((id, index) => id === specialTarget[index]);
      const specialTelemetry = handle.telemetry();
      await handle.close();
      await handle.close();
      let encodeAfterCloseRejected = false;
      let switchAfterCloseRejected = false;
      try { await handle.encode("closed"); } catch { encodeAfterCloseRejected = true; }
      try { await handle.switchTier("single"); } catch { switchAfterCloseRejected = true; }
      return {
        rows,
        lifecycle,
        lifecycleAfterClose: handle.lifecycle(),
        unavailableRejected,
        usableAfterUnavailable: proof.length !== 0,
        specialExact,
        specialFallback: specialTelemetry.fallback === true
          && specialTelemetry.cause === "resident-single-policy",
        encodeAfterCloseRejected,
        switchAfterCloseRejected,
      };
    };
    const fromSingle = await runSession("single", ["single", target, "single", target]);
    const fromTarget = await runSession(target, [target, "single", target]);
    return { bundler, target, isolated: crossOriginIsolated, typedImageChecks, fromSingle, fromTarget };
  })();
</script>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const isolated = url.pathname !== "/" || url.searchParams.get("target") === "shared";
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
    if (workload?.path !== undefined) filePath = workload.path;
    else if (workload?.text !== undefined) {
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

function assertSession(session, target) {
  assert.equal(session.rows.length, (target === session.rows[0].tier ? 3 : 4) * workloads.length);
  for (const row of session.rows) {
    const expected = oracleById.get(row.workload);
    assert.equal(row.bytes, expected.bytes);
    assert.equal(row.ids, expected.ids, `${target}/${row.step}/${row.workload} ids`);
    assert.equal(row.digest, expected.digest, `${target}/${row.step}/${row.workload} digest`);
  }
  const lifecycle = session.lifecycle;
  assert.equal(lifecycle.singleLoads, 1);
  assert.equal(lifecycle.workerImageExports, 1);
  assert.equal(lifecycle.residentSingleIdentity, 1);
  assert.equal(lifecycle.workerImageRetained, true);
  assert.ok(lifecycle.workerImageBytes > 0);
  assert.equal(lifecycle.sourceDigest.length, 32);
  if (target === "worker") {
    assert.equal(lifecycle.workerPoolInitializations, 1);
    assert.equal(lifecycle.workerImports, 2);
    assert.equal(lifecycle.workerSourceRebuilds, 0);
    assert.equal(lifecycle.detachedTransfers, 2);
  } else {
    assert.equal(lifecycle.sharedInitializations, 1);
    assert.equal(lifecycle.sharedImports, 1);
    assert.equal(lifecycle.sharedSourceRebuilds, 0);
    assert.equal(lifecycle.detachedTransfers, 1);
  }
  assert.ok(lifecycle.targetReuses >= 1);
  assert.equal(session.lifecycleAfterClose.closed, true);
  assert.equal(session.unavailableRejected, true);
  assert.equal(session.usableAfterUnavailable, true);
  assert.equal(session.specialExact, true);
  assert.equal(session.specialFallback, true);
  assert.equal(session.encodeAfterCloseRejected, true);
  assert.equal(session.switchAfterCloseRejected, true);
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const results = [];
let bundleMutationsRed = 0;
try {
  for (const bundler of ["vite", "webpack"]) {
    for (const target of ["worker", "shared"]) {
      const page = await browser.newPage();
      page.on("requestfailed", (request) =>
        process.stderr.write(`request-failed ${request.url()} ${request.failure()?.errorText}\n`),
      );
      page.on("response", (response) => {
        if (!response.ok()) process.stderr.write(`response ${response.status()} ${response.url()}\n`);
      });
      await page.goto(
        `http://127.0.0.1:${address.port}/?bundler=${bundler}&target=${target}`,
      );
      const result = await withTimeout(
        page.evaluate(() => globalThis.resultPromise),
        `${bundler}/${target}`,
        120_000,
      );
      assert.equal(result.target, target);
      assert.equal(result.isolated, target === "shared");
      assert.equal(result.typedImageChecks, 12);
      assertSession(result.fromSingle, target);
      assertSession(result.fromTarget, target);
      results.push(result);
      await page.close();
    }
  }

  for (const bundler of ["transfer-corrupt", "source-digest", "source-rebuild"]) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/?bundler=${bundler}&target=worker`);
    let red = false;
    try {
      await withTimeout(page.evaluate(() => globalThis.resultPromise), bundler, 120_000);
    } catch {
      red = true;
    }
    assert.equal(red, true, `${bundler} did not go RED`);
    bundleMutationsRed += 1;
    await page.close();
  }

  for (const mutation of [
    { bundler: "pool-reload", target: "worker", field: "workerPoolInitializations" },
    { bundler: "resident-replace", target: "shared", field: "residentSingleIdentity" },
  ]) {
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${address.port}/?bundler=${mutation.bundler}&target=${mutation.target}`,
    );
    const result = await withTimeout(
      page.evaluate(() => globalThis.resultPromise),
      mutation.bundler,
      120_000,
    );
    assert.notEqual(result.fromSingle.lifecycle[mutation.field], 1);
    bundleMutationsRed += 1;
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

let orderMutationRed = false;
try {
  const mutated = results[0].fromSingle.rows.slice();
  [mutated[0], mutated[1]] = [mutated[1], mutated[0]];
  for (let index = 0; index < mutated.length; index += 1) {
    assert.deepEqual(mutated[index], results[0].fromSingle.rows[index]);
  }
} catch {
  orderMutationRed = true;
}
assert.equal(orderMutationRed, true, "transition row ordering mutation did not go RED");

const commit = run("git", [
  "-c",
  `safe.directory=${repository.replaceAll("\\", "/")}`,
  "rev-parse",
  "HEAD",
]);
const transitionRows = results.reduce(
  (sum, result) => sum + result.fromSingle.rows.length + result.fromTarget.rows.length,
  0,
);
const report = {
  schemaVersion: 1,
  commit,
  oracle: { name: oracle.oracle, version: oracle.version },
  bundlers: { vite: "8.2.0", webpack: "5.109.2" },
  coverage: {
    bundlers: 2,
    targetTiers: 2,
    workloads: workloads.length,
    sessions: results.length * 2,
    transitionRows,
    typedImageChecks: 12,
    hashImageTests: 4,
    mutationsRed: bundleMutationsRed + 1,
  },
  results,
};
fs.writeFileSync(
  path.join(resultRoot, "tier-switch-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ pass: true, commit, ...report.coverage })}\n`,
);
