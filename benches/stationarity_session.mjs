import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeAdapter } from "./adapters/node.mjs";
import { buildBrowserBundle } from "./browser/build.mjs";
import { launchHarnessBrowser, observeRequests } from "./browser/control.mjs";
import {
  disposeReferencePayload,
  loadReferencePayload,
} from "./browser/payload_measurement.mjs";
import { startHarnessServer } from "./browser/server.mjs";
import { loadCorpus } from "./common/corpus.mjs";
import { summarize } from "./common/timing.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const [environment, sessionText, outputPath] = process.argv.slice(2);
const session = Number(sessionText);
const n = 21;
const warmup = 2;
const targetBytesPerSample = 4_194_304;

if (!["node", "browser"].includes(environment) || !Number.isInteger(session) || session < 1) {
  throw new Error("usage: stationarity_session.mjs node|browser session output");
}
if (!outputPath) throw new Error("stationarity output path is required");

const workloads = loadCorpus();
const configuration = Object.freeze({ n, warmup, targetBytesPerSample });
const digestIds = (ids) =>
  crypto
    .createHash("sha256")
    .update(Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength))
    .digest("hex");

function measureNodeWorkload(adapter, workload) {
  const iterations = Math.max(1, Math.ceil(targetBytesPerSample / workload.bytes));
  let ids = new Uint32Array();
  for (let sample = 0; sample < warmup; sample += 1) {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      ids = adapter.encode(workload.text);
    }
  }
  const samples = [];
  for (let sample = 0; sample < n; sample += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      ids = adapter.encode(workload.text);
    }
    const elapsed = performance.now() - started;
    if (!Number.isFinite(elapsed) || elapsed <= 0) {
      throw new Error(`Invalid encode duration: ${elapsed}`);
    }
    samples.push((workload.bytes * iterations) / (elapsed * 1_000));
  }
  return {
    iterationsPerSample: iterations,
    bytesPerSample: workload.bytes * iterations,
    ids,
    statistics: summarize(samples),
  };
}

async function measureNode() {
  const adapter = await createNodeAdapter("hypertok");
  try {
    const rows = [];
    for (const workload of workloads) {
      const result = measureNodeWorkload(adapter, workload);
      rows.push({
        workload: workload.id,
        workloadBytes: workload.bytes,
        bytesPerSample: result.bytesPerSample,
        iterationsPerSample: result.iterationsPerSample,
        tokenCount: result.ids.length,
        idDigest: digestIds(result.ids),
        statistics: result.statistics,
      });
      console.log(`node session ${session} ${workload.id}: ${result.statistics.median.toFixed(3)} MB/s`);
    }
    return {
      schemaVersion: 1,
      environment,
      session,
      runtimeVersion: process.version,
      reference: adapter.id,
      referenceVersion: adapter.version,
      tier: adapter.tier,
      simdLevel: adapter.simdLevel,
      clockRegime: "performance.now; fresh Node process; warm cache within session",
      configuration,
      rows,
    };
  } finally {
    adapter.dispose();
  }
}

async function measureBrowser() {
  await buildBrowserBundle();
  const server = await startHarnessServer();
  const { browser, browserVersion, executablePath, executableSource } =
    await launchHarnessBrowser();
  const page = await browser.newPage();
  const requests = observeRequests(page);
  try {
    await page.goto(`${server.origin}/blank`, { waitUntil: "load" });
    const isolated = await page.evaluate(() => crossOriginIsolated);
    if (!isolated) throw new Error("Stationarity page is not cross-origin isolated");
    const loaded = await loadReferencePayload(page, server.origin, "hypertok");
    const rows = [];
    for (const workload of workloads) {
      const result = await page.evaluate(
        async ({ corpusUrl, fullBytes, sampleBytes, targetBytes, sampleCount, warmupCount }) => {
          const response = await fetch(corpusUrl, { cache: "no-store" });
          if (!response.ok) throw new Error(`${corpusUrl}: HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length !== fullBytes) throw new Error("Workload byte count mismatch");
          const measuredBytes = sampleBytes < fullBytes ? bytes.subarray(0, sampleBytes) : bytes;
          const text = new TextDecoder("utf-8", { fatal: sampleBytes === fullBytes }).decode(
            measuredBytes,
          );
          const iterations = Math.max(1, Math.ceil(targetBytes / measuredBytes.length));
          let ids = new Uint32Array();
          for (let sample = 0; sample < warmupCount; sample += 1) {
            for (let iteration = 0; iteration < iterations; iteration += 1) {
              ids = globalThis.activeReference.encode(text);
            }
          }
          const samples = [];
          for (let sample = 0; sample < sampleCount; sample += 1) {
            const started = performance.now();
            for (let iteration = 0; iteration < iterations; iteration += 1) {
              ids = globalThis.activeReference.encode(text);
            }
            const elapsed = performance.now() - started;
            if (!Number.isFinite(elapsed) || elapsed <= 0) {
              throw new Error(`Invalid encode duration: ${elapsed}`);
            }
            samples.push((measuredBytes.length * iterations) / (elapsed * 1_000));
          }
          const idBytes = new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength);
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", idBytes));
          const idDigest = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
          return {
            samples,
            iterationsPerSample: iterations,
            bytesPerSample: measuredBytes.length * iterations,
            tokenCount: ids.length,
            idDigest,
          };
        },
        {
          corpusUrl: `${server.origin}/corpus/${workload.path}`,
          fullBytes: workload.fullBytes,
          sampleBytes: workload.bytes,
          targetBytes: targetBytesPerSample,
          sampleCount: n,
          warmupCount: warmup,
        },
      );
      const statistics = summarize(result.samples);
      rows.push({
        workload: workload.id,
        workloadBytes: workload.bytes,
        bytesPerSample: result.bytesPerSample,
        iterationsPerSample: result.iterationsPerSample,
        tokenCount: result.tokenCount,
        idDigest: result.idDigest,
        statistics,
      });
      console.log(`browser session ${session} ${workload.id}: ${statistics.median.toFixed(3)} MB/s`);
    }
    await disposeReferencePayload(page);
    const requestProof = requests.assertLocal(server.origin);
    return {
      schemaVersion: 1,
      environment,
      session,
      browser: `Chrome ${browserVersion}`,
      chromeExecutable: executablePath,
      chromeExecutableSource: executableSource,
      crossOriginIsolated: isolated,
      localRequestCount: requestProof.requestCount,
      reference: loaded.reference,
      referenceVersion: loaded.version,
      tier: "single",
      simdLevel: "scalar",
      clockRegime: "performance.now; fresh isolated Chrome; warm cache within session",
      configuration,
      rows,
    };
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
}

const result = environment === "node" ? await measureNode() : await measureBrowser();
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
