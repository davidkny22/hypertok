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
import {
  addHypertokRatios,
  benchmarkConfiguration,
  iterationsForWorkload,
} from "./common/throughput.mjs";
import { benchmarkRow } from "./common/row.mjs";
import { writeRunResult } from "./common/output.mjs";
import { vocabularyRegistry } from "./common/vocabularies.mjs";
import {
  extendMeasuredRow,
  measuredRow,
  planEscalations,
  publicMeasuredRow,
  sampleCountForWorkload,
  samplingKey,
} from "./common/verdict_sampling.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const outputPath = path.join(repositoryDirectory, "results", "phase1", "browser-throughput.json");
const configuration = benchmarkConfiguration();
const workloads = loadCorpus();
const rows = [];

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
  workloads,
  artifacts: browserArenaArtifacts(browserOutputDirectory, referenceSlugs),
});
const agreementReceipt = loadAgreementReceipt("browser", runIdentity);
const server = await startHarnessServer();
const { browser, browserVersion, executablePath, executableSource } =
  await launchHarnessBrowser();
const requestLedgers = [];
let escalationPlan;

async function measurePage(page, workload, n, warmup) {
  const iterations = iterationsForWorkload(
    workload.bytes,
    configuration.targetBytesPerSample,
  );
  const result = await page.evaluate(
    async ({ corpusUrl, expectedBytes, iterationsPerSample, n, warmup }) => {
      const response = await fetch(corpusUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`${corpusUrl}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== expectedBytes) throw new Error("Workload byte count mismatch");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      let ids = new Uint32Array();
      for (let sample = 0; sample < warmup; sample += 1) {
        for (let iteration = 0; iteration < iterationsPerSample; iteration += 1) {
          ids = globalThis.activeReference.encode(text);
        }
      }
      const samples = [];
      for (let sample = 0; sample < n; sample += 1) {
        const started = performance.now();
        for (let iteration = 0; iteration < iterationsPerSample; iteration += 1) {
          ids = globalThis.activeReference.encode(text);
        }
        const elapsed = performance.now() - started;
        if (!Number.isFinite(elapsed) || elapsed <= 0) {
          throw new Error(`Invalid encode duration: ${elapsed}`);
        }
        samples.push((bytes.length * iterationsPerSample) / (elapsed * 1_000));
      }
      return { samples, tokenCount: ids.length };
    },
    {
      corpusUrl: `${server.origin}/corpus/${workload.path}`,
      expectedBytes: workload.bytes,
      iterationsPerSample: iterations,
      n,
      warmup,
    },
  );
  return Object.freeze({ ...result, iterations });
}

try {
  for (const { slug, vocabulary } of referencePayloads) {
    const page = await browser.newPage();
    const requests = observeRequests(page);
    requestLedgers.push(requests);
    try {
      await page.goto(`${server.origin}/blank`, { waitUntil: "load" });
      if (!(await page.evaluate(() => crossOriginIsolated))) {
        throw new Error("Browser benchmark page is not cross-origin isolated");
      }
      const load = await loadReferencePayload(page, server.origin, slug, vocabulary);
      for (const workload of workloads) {
        const initialN = sampleCountForWorkload(configuration, workload);
        const result = await measurePage(page, workload, initialN, configuration.warmup);
        rows.push(measuredRow({ row: {
          vocabulary,
          workload: workload.id,
          workloadBytes: workload.bytes,
          reference: load.reference,
          referenceVersion: load.version,
          environment: "browser",
          tier: "single",
          simdLevel: "scalar",
          clockRegime: "performance.now; cross-origin isolated Chrome; warm cache",
          status: "measured",
          units: "MB/s",
          iterationsPerSample: result.iterations,
          bytesPerSample: workload.bytes * result.iterations,
          tokenCount: result.tokenCount,
        }, samples: result.samples, initialN }));
        console.log(
          `${load.reference} ${workload.id}: ${rows.at(-1).median.toFixed(3)} MB/s`,
        );
      }
      await disposeReferencePayload(page);
    } finally {
      await page.close();
    }
  }

  for (const { id: vocabulary } of vocabularyRegistry) {
    for (const unavailable of unavailableReferences(vocabulary)) {
      for (const workload of workloads) {
        rows.push({
          vocabulary,
          workload: workload.id,
          workloadBytes: workload.bytes,
          reference: unavailable.id,
          referenceVersion: unavailable.version,
          environment: "browser",
          tier: null,
          simdLevel: null,
          clockRegime: null,
          status: "unavailable",
          reason: unavailable.reason,
          n: 0,
          median: null,
          p95: null,
          variance: null,
          units: "MB/s",
          ratio: null,
        });
      }
    }
  }

  escalationPlan = planEscalations(rows, agreementReceipt, configuration.maxN);
  for (const { slug, vocabulary, reference } of referencePayloads) {
    const matching = rows.filter((row) =>
      row.vocabulary === vocabulary &&
      row.reference === reference &&
      escalationPlan.targets.has(samplingKey(row))
    );
    if (matching.length === 0) continue;
    const page = await browser.newPage();
    const requests = observeRequests(page);
    requestLedgers.push(requests);
    try {
      await page.goto(`${server.origin}/blank`, { waitUntil: "load" });
      const load = await loadReferencePayload(page, server.origin, slug, vocabulary);
      if (load.reference !== reference) throw new Error("Escalation reference mismatch");
      for (const row of matching) {
        const workload = workloads.find(({ id }) => id === row.workload);
        const result = await measurePage(
          page,
          workload,
          configuration.maxN - row.n,
          configuration.warmup,
        );
        rows[rows.indexOf(row)] = extendMeasuredRow(row, result.samples);
      }
      await disposeReferencePayload(page);
    } finally {
      await page.close();
    }
  }

  const requestProofs = requestLedgers.map((requests) => requests.assertLocal(server.origin));
  const localRequestCount = requestProofs.reduce((sum, proof) => sum + proof.requestCount, 0);

  const output = {
    schemaVersion: 2,
    environment: "browser",
    browser: `Chrome ${browserVersion}`,
    chromeExecutable: executablePath,
    chromeExecutableSource: executableSource,
    crossOriginIsolated: true,
    localRequestCount,
    commit: runIdentity.commit,
    runIdentity,
    agreementKey: agreementReceipt.agreementKey,
    samplingDecisions: escalationPlan.decisions,
    configuration,
    rows: addHypertokRatios(rows, agreementReceipt).map((row) =>
      benchmarkRow({
        ...publicMeasuredRow(row),
        profile: configuration.profile,
        mode: configuration.mode,
        axis: "encode",
        commit: runIdentity.commit,
      }),
    ),
  };
  const publicOutput = writeRunResult({
    runIdentity,
    mode: configuration.mode,
    axis: "encode",
    result: output,
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(publicOutput.result, null, 2)}\n`);
  console.log(path.relative(repositoryDirectory, outputPath).replaceAll("\\", "/"));
  console.log(path.relative(repositoryDirectory, publicOutput.resultPath).replaceAll("\\", "/"));
} finally {
  await browser.close();
  await server.close();
}
