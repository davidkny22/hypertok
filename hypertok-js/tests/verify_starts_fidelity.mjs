import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "../../benches/node_modules/playwright-core/index.mjs";
import { loadExecutionArtifactManifest } from "../../tests/suites/artifact_manifest.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const resultRoot = path.join(repository, "results", "starts-fidelity");
const executionArtifacts = loadExecutionArtifactManifest(
  repository,
  process.env.HYPERTOK_ARTIFACT_MANIFEST,
);
const singleRoot = executionArtifacts.roots["single-simd128-shipping"];
const sharedRoot = executionArtifacts.roots["shared-simd128-shipping"];
const vocabulary = path.join(repository, "hypertok-vocab", "o200k", "vocab.htk");
const sourceRoot = path.join(repository, "hypertok-js", "src");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

fs.mkdirSync(resultRoot, { recursive: true });

function withTrimOffsets(source) {
  const bytes = Buffer.from(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionCount = view.getUint32(24, true);
  const tableOffset = view.getUint32(28, true);
  let pretokEntry;
  let pretokOffset;
  let pretokLength;
  const sectionOffsets = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = tableOffset + index * 16;
    const id = view.getUint32(entry, true);
    const offset = view.getUint32(entry + 4, true);
    const length = Number(view.getBigUint64(entry + 8, true));
    sectionOffsets.push(offset);
    if (id === 5) {
      pretokEntry = entry;
      pretokOffset = offset;
      pretokLength = length;
    }
  }
  assert.notEqual(pretokEntry, undefined, "fixture is missing PRETOK");
  assert.equal(view.getUint32(pretokOffset, true), 1, "fixture PRETOK step count changed");
  assert.equal(bytes[pretokOffset + 4], 0, "fixture does not start with a named pattern");
  const nextOffset = Math.min(...sectionOffsets.filter((offset) => offset > pretokOffset));
  assert.ok(pretokOffset + pretokLength + 2 <= nextOffset, "PRETOK has no extension padding");
  view.setUint32(pretokOffset, 2, true);
  bytes[pretokOffset + pretokLength] = 1;
  bytes[pretokOffset + pretokLength + 1] = 0b110;
  view.setBigUint64(pretokEntry + 8, BigInt(pretokLength + 2), true);
  bytes.fill(0, 32, 64);
  createHash("sha256").update(bytes).digest().copy(bytes, 32);
  return bytes;
}

const trimVocabulary = withTrimOffsets(fs.readFileSync(vocabulary));

function gitHead() {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${repository.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repository, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function contentType(filePath) {
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
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

function withTimeout(promise, label, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const testPage = `<!doctype html>
<meta charset="utf-8">
<title>starts fidelity</title>
<script type="module">
  const parameters = new URL(location.href).searchParams;
  globalThis.resultPromise = (async () => {
    const tier = parameters.get("tier");
    const mutation = parameters.has("mutation");
    const { createTierRuntime } = await import("/runtime.mjs");
    const vocabularyUrl = parameters.has("trim") ? "/vocabulary-trim" : "/vocabulary";
    const vocabulary = new Uint8Array(await (await fetch(vocabularyUrl)).arrayBuffer());
    const runtime = await createTierRuntime({
      tier,
      format: "htk",
      unthreadedModuleUrl: new URL("/single/hypertok_wasm_core.js", location.href).href,
      threadedModuleUrl: new URL("/shared/hypertok_wasm_core.js", location.href).href,
      vocabulary,
      workerCount: 2,
    });
    const encoder = new TextEncoder();
    let cases = 0;
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
      cases += 1;
    };
    const equal = (left, right) =>
      left.length === right.length && left.every((value, index) => value === right[index]);
    const tokenLengthCache = new Map();
    const expectedIdentityStarts = (ids) => {
      const starts = new Uint32Array(ids.length);
      let cursor = 0;
      for (let index = 0; index < ids.length; index += 1) {
        starts[index] = cursor;
        const id = ids[index];
        let length = tokenLengthCache.get(id);
        if (length === undefined) {
          length = runtime.tokenBytes(id).length;
          tokenLengthCache.set(id, length);
        }
        cursor += length;
      }
      return { starts, bytes: cursor };
    };
    const verifyIdentity = async (label, text, options) => {
      let detailed = await runtime.encodeDetailed(text, options);
      if (mutation && detailed.starts.length !== 0) {
        const starts = detailed.starts.slice();
        starts[0] += 1;
        detailed = { ...detailed, starts };
      }
      const ordinary = await runtime.encode(text, options);
      const expected = expectedIdentityStarts(detailed.ids);
      check(detailed.ids instanceof Uint32Array, label + " ids are not Uint32Array");
      check(detailed.starts instanceof Uint32Array, label + " starts are not Uint32Array");
      check(equal(detailed.ids, ordinary), label + " detailed ids differ from encode");
      check(equal(detailed.starts, expected.starts), label + " starts differ from original bytes");
      check(expected.bytes === encoder.encode(text).length, label + " token bytes do not cover input");
      return detailed;
    };

    if (parameters.has("trim")) {
      const text = "  a";
      const detailed = await runtime.encodeDetailed(text);
      const ordinary = await runtime.encode(text);
      const identity = expectedIdentityStarts(detailed.ids);
      const expected = new Uint32Array(detailed.ids.length);
      let cursor = 0;
      for (let index = 0; index < detailed.ids.length; index += 1) {
        const token = runtime.tokenBytes(detailed.ids[index]);
        const leadingSpaces = token.findIndex((byte) => byte !== 0x20);
        const trimmed = leadingSpaces === -1 ? token.length : leadingSpaces;
        expected[index] = cursor + trimmed;
        cursor += token.length;
      }
      check(equal(detailed.ids, ordinary), "trim detailed ids differ from encode");
      check(equal(detailed.starts, expected), "loaded trim_offsets was not applied");
      check(!equal(detailed.starts, identity.starts), "trim fixture did not change an offset");
      check(cursor === encoder.encode(text).length, "trim token bytes do not cover input");
      const result = {
        tier,
        actualTier: runtime.tier,
        cases,
        ids: detailed.ids.length,
        starts: Array.from(detailed.starts),
      };
      await runtime.close();
      return result;
    }

    const ordinary = await verifyIdentity("ordinary", "alpha élan 世界 emoji🙂 omega");
    console.log("starts-fidelity", tier, "ordinary");
    check(ordinary.reservedFound.length === 0, "ordinary input reported a reserved token");

    const long = await verifyIdentity("chunked", "a".repeat(4200));
    console.log("starts-fidelity", tier, "chunked");
    check(long.ids.length > 0, "chunked case emitted no ids");
    const chunkTelemetry = runtime.telemetry();
    if (tier !== "single") {
      check(chunkTelemetry.initialChunks > 1, tier + " did not engage overlap chunks");
      check(chunkTelemetry.fallback === false, tier + " fell back to resident single");
    }

    const reservedText = "alpha<|endoftext|>beta";
    const reserved = await verifyIdentity("reserved", reservedText);
    console.log("starts-fidelity", tier, "reserved");
    check(
      JSON.stringify(reserved.reservedFound) === JSON.stringify(["<|endoftext|>"]),
      "reserved reporting mismatch",
    );
    const literal = await verifyIdentity("literal", reservedText, { reserved: { match: [] } });
    console.log("starts-fidelity", tier, "literal");
    check(
      JSON.stringify(literal.reservedFound) === JSON.stringify(reserved.reservedFound),
      "literal policy changed reserved reporting",
    );
    check(!equal(literal.ids, reserved.ids), "literal policy did not change reserved ids");

    const result = {
      tier,
      actualTier: runtime.tier,
      cases,
      chunkTelemetry,
      ordinaryIds: ordinary.ids.length,
      chunkedIds: long.ids.length,
      reservedIds: reserved.ids.length,
      literalIds: literal.ids.length,
    };
    await runtime.close();
    return result;
  })();
</script>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const isolated = url.searchParams.get("tier") !== "worker";
  let filePath;
  if (url.pathname === "/") {
    response.writeHead(200, headers("text/html; charset=utf-8", isolated));
    response.end(testPage);
    return;
  }
  if (url.pathname === "/vocabulary") {
    filePath = vocabulary;
  } else if (url.pathname === "/vocabulary-trim") {
    response.writeHead(200, headers("application/octet-stream", isolated));
    response.end(trimVocabulary);
    return;
  } else if (url.pathname === "/shared/") {
    filePath = path.join(sharedRoot, "hypertok_wasm_core.js");
  } else if (url.pathname.startsWith("/single/")) {
    filePath = under(singleRoot, url.pathname.slice("/single/".length));
  } else if (url.pathname.startsWith("/shared/")) {
    filePath = under(sharedRoot, url.pathname.slice("/shared/".length));
  } else if (/^\/[a-z0-9-]+\.mjs$/.test(url.pathname)) {
    const moduleName = url.pathname === "/runtime.mjs"
      ? "tier-runtime.mjs"
      : url.pathname.slice(1);
    filePath = under(sourceRoot, moduleName);
  }
  if (filePath === undefined || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, headers("text/plain; charset=utf-8", isolated));
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
const rows = [];
const requests = [];
const selectedTiers = process.env.HYPERTOK_TIER
  ? [process.env.HYPERTOK_TIER]
  : ["single", "worker", "shared"];
try {
  for (const tier of selectedTiers) {
    console.log(`starts-fidelity: starting ${tier}`);
    const page = await browser.newPage();
    page.on("console", (message) => console.log(message.text()));
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`http://127.0.0.1:${address.port}/?tier=${tier}`);
    const row = await withTimeout(
      page.evaluate(() => globalThis.resultPromise),
      `starts-fidelity/${tier}`,
      120_000,
    );
    assert.equal(row.actualTier, tier);
    assert.ok(row.cases >= 20, `${tier} ran too few cases`);
    rows.push(row);
    await page.close();
    console.log(`starts-fidelity: completed ${tier}`);
  }
  if (selectedTiers.length > 1) {
    assert.deepEqual(
      rows.map((row) => [row.ordinaryIds, row.chunkedIds, row.reservedIds, row.literalIds]),
      Array(selectedTiers.length).fill([
        rows[0].ordinaryIds,
        rows[0].chunkedIds,
        rows[0].reservedIds,
        rows[0].literalIds,
      ]),
      "tier result lengths differ",
    );
  }

  let mutationRed = false;
  const page = await browser.newPage();
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`http://127.0.0.1:${address.port}/?tier=single&mutation=1`);
  try {
    await page.evaluate(() => globalThis.resultPromise);
  } catch {
    mutationRed = true;
  }
  await page.close();
  assert.equal(mutationRed, true, "starts mutation did not turn the verifier RED");

  const trimPage = await browser.newPage();
  trimPage.on("request", (request) => requests.push(request.url()));
  await trimPage.goto(`http://127.0.0.1:${address.port}/?tier=single&trim=1`);
  const trimOffsets = await withTimeout(
    trimPage.evaluate(() => globalThis.resultPromise),
    "starts-fidelity/trim-offsets",
    120_000,
  );
  await trimPage.close();
  assert.equal(trimOffsets.actualTier, "single");
  assert.equal(trimOffsets.cases, 4);

  assert.ok(
    requests.every((value) => new URL(value).hostname === "127.0.0.1"),
    "browser made a non-local request",
  );
  const report = {
    schemaVersion: 1,
    gate: "starts-fidelity",
    commit: gitHead(),
    rows,
    trimOffsets,
    mutationRed,
    browserRequests: requests.length,
    allRequestsLocal: true,
  };
  fs.writeFileSync(path.join(resultRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
