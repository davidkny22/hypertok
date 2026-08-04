import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unavailableReferences } from "./adapters/node.mjs";
import {
  buildBrowserBundle,
  referencePayloads,
  referenceSlugs,
} from "./browser/build.mjs";
import { launchHarnessBrowser, observeRequests } from "./browser/control.mjs";
import { measureBrowserMemory } from "./browser/memory_measurement.mjs";
import {
  disposeReferencePayload,
  loadReferencePayload,
} from "./browser/payload_measurement.mjs";
import { startHarnessServer } from "./browser/server.mjs";
import { loadAgreementReceipt } from "./common/agreement_gate.mjs";
import {
  browserArenaArtifacts,
  buildArenaRunIdentity,
} from "./common/arena_identity.mjs";
import { loadCorpus } from "./common/corpus.mjs";
import { benchmarkMode, benchmarkProfile } from "./common/throughput.mjs";
import { summarize } from "./common/timing.mjs";
import { writeRunResult } from "./common/output.mjs";
import { vocabularyRegistry } from "./common/vocabularies.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const outputPath = path.join(repositoryDirectory, "results", "phase1", "browser-load.json");
const profile = benchmarkProfile();
const mode = benchmarkMode();
const n = Number(process.env.HYPERTOK_LOAD_N ?? 7);
const memoryN = Number(process.env.HYPERTOK_MEMORY_N ?? 3);
if (!Number.isInteger(n) || n < 1 || !Number.isInteger(memoryN) || memoryN < 1) {
  throw new Error("Load and memory sample counts must be positive integers");
}

function currentCommit() {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${repositoryDirectory.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repositoryDirectory, encoding: "utf8" },
  ).trim();
}

const browserOutputDirectory = await buildBrowserBundle();
const runIdentity = buildArenaRunIdentity({
  environment: "browser",
  commit: currentCommit(),
  workloads: loadCorpus(),
  artifacts: browserArenaArtifacts(browserOutputDirectory, referenceSlugs),
});
const agreementReceipt = loadAgreementReceipt("browser", runIdentity);
const server = await startHarnessServer();
const { browser, browserVersion, executablePath, executableSource } =
  await launchHarnessBrowser({
    browserArgs: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
  });
const requestLedgers = [];
const rows = [];
let memoryMethod;

try {
  for (const { slug, vocabulary } of referencePayloads) {
    const transfer = [];
    const decompression = [];
    const materialisation = [];
    const residentDeltas = [];
    const residentTotals = [];
    let reference;
    let version;
    let compressedBytes;
    let decompressedBytes;

    for (let sample = 0; sample < n; sample += 1) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const requests = observeRequests(page);
      requestLedgers.push(requests);
      try {
        await page.goto(`${server.origin}/blank`, { waitUntil: "load" });
        if (!(await page.evaluate(() => crossOriginIsolated))) {
          throw new Error("Browser load page is not cross-origin isolated");
        }
        let baselineMemory;
        if (sample < memoryN) {
          baselineMemory = await measureBrowserMemory(page);
        }
        const measurement = await loadReferencePayload(
          page,
          server.origin,
          slug,
          vocabulary,
        );
        reference = measurement.reference;
        version = measurement.version;
        compressedBytes = measurement.compressedBytes;
        decompressedBytes = measurement.decompressedBytes;
        transfer.push(measurement.transferMilliseconds);
        decompression.push(measurement.decompressionMilliseconds);
        materialisation.push(measurement.materialisationMilliseconds);
        if (sample < memoryN) {
          const afterMemory = await measureBrowserMemory(page);
          if (baselineMemory.method !== afterMemory.method) {
            throw new Error("Browser memory method changed within one sample");
          }
          if (memoryMethod !== undefined && memoryMethod !== afterMemory.method) {
            throw new Error("Browser memory method changed within one run");
          }
          memoryMethod = afterMemory.method;
          residentDeltas.push(afterMemory.bytes - baselineMemory.bytes);
          residentTotals.push(afterMemory.bytes);
        }
        await disposeReferencePayload(page);
      } finally {
        await context.close();
      }
    }

    if (residentDeltas.some((value) => value < 0)) {
      throw new Error(`${reference}: negative resident-memory delta`);
    }
    const row = {
      vocabulary,
      reference,
      referenceVersion: version,
      environment: "browser",
      tier: "single",
      simdLevel: "scalar",
      clockRegime: "performance.now; cross-origin isolated Chrome; fresh context per sample",
      status: "measured",
      profile,
      mode,
      agreementKey: agreementReceipt.agreementKey,
      probe: "x",
      compressedBytes,
      decompressedBytes,
      transfer: { ...summarize(transfer), units: "ms" },
      decompression: { ...summarize(decompression), units: "ms" },
      materialisation: { ...summarize(materialisation), units: "ms" },
      resident: {
        ...summarize(residentDeltas),
        units: "bytes",
        total: { ...summarize(residentTotals), units: "bytes" },
        method: memoryMethod,
      },
    };
    rows.push(row);
    console.log(
      `${reference}: transfer=${row.transfer.median.toFixed(3)} ms; decompression=${row.decompression.median.toFixed(3)} ms; materialisation=${row.materialisation.median.toFixed(3)} ms; resident=${row.resident.median}`,
    );
  }

  for (const { id: vocabulary } of vocabularyRegistry) {
    for (const unavailable of unavailableReferences(vocabulary)) {
      rows.push({
        vocabulary,
        reference: unavailable.id,
        referenceVersion: unavailable.version,
        environment: "browser",
        tier: null,
        simdLevel: null,
        clockRegime: null,
        status: "unavailable",
        profile,
        mode,
        agreementKey: agreementReceipt.agreementKey,
        reason: unavailable.reason,
        transfer: null,
        decompression: null,
        materialisation: null,
        resident: null,
      });
    }
  }

  const requestProofs = requestLedgers.map((requests) => requests.assertLocal(server.origin));
  const localRequestCount = requestProofs.reduce((sum, proof) => sum + proof.requestCount, 0);

  const result = {
    schemaVersion: 2,
    environment: "browser",
    browser: `Chrome ${browserVersion}`,
    profile,
    mode,
    chromeExecutable: executablePath,
    chromeExecutableSource: executableSource,
    commit: runIdentity.commit,
    runIdentity,
    agreementKey: agreementReceipt.agreementKey,
    configuration: {
      n,
      memoryN,
      profile,
      mode,
      compression: "gzip level 9",
      transfer: "loopback fetch of compressed self-contained payload with cache disabled",
      materialisation: "blob module startup, instance construction, and fixed one-character probe",
      memory: `${memoryMethod} delta after explicit garbage collection`,
      crossOriginIsolated: true,
      localRequestCount,
    },
    rows,
  };
  const publicOutput = writeRunResult({
    runIdentity,
    mode,
    axis: "load",
    result,
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(publicOutput.result, null, 2)}\n`);
  console.log(path.relative(repositoryDirectory, outputPath).replaceAll("\\", "/"));
  console.log(path.relative(repositoryDirectory, publicOutput.resultPath).replaceAll("\\", "/"));
} finally {
  await browser.close();
  await server.close();
}
