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
  DECODE_FIELD_SEGMENT_BYTES,
  ORDINARY_ID_REFERENCES,
} from "./common/throughput.mjs";
import { summarize } from "./common/timing.mjs";
import { benchmarkRow } from "./common/row.mjs";
import { writeRunResult } from "./common/output.mjs";
import { vocabularyRegistry } from "./common/vocabularies.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const outputPath = path.join(
  repositoryDirectory,
  "results",
  "benchmark",
  "decode",
  "browser.json",
);
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

try {
  for (const containerRegime of configuration.decodeContainerRegimes) {
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
          const result = await page.evaluate(
          async ({ corpusUrl, expectedBytes, n, warmup, ordinary, segmentBytes, containerRegime }) => {
            if (containerRegime !== "repeated" && containerRegime !== "fresh") {
              throw new Error("Unknown decode container regime");
            }
            const response = await fetch(corpusUrl, { cache: "no-store" });
            if (!response.ok) throw new Error(`${corpusUrl}: HTTP ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length !== expectedBytes) throw new Error("Workload byte count mismatch");
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            const segmentTexts = [];
            let current = "";
            let currentBytes = 0;
            for (const scalar of text) {
              const codePoint = scalar.codePointAt(0);
              current += scalar;
              currentBytes +=
                codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
              if (currentBytes >= segmentBytes) {
                segmentTexts.push(current);
                current = "";
                currentBytes = 0;
              }
            }
            if (current.length !== 0) segmentTexts.push(current);
            const segments = segmentTexts.map((segmentText) => {
              const encoded = globalThis.activeReference.encode(segmentText);
              const ids = ordinary ? Array.from(encoded) : encoded;
              if (globalThis.activeReference.decode(ids) !== segmentText) {
                throw new Error("Decoded text mismatch");
              }
              return ids;
            });
            const tokenCount = segments.reduce((sum, ids) => sum + ids.length, 0);
            const freshInputs = containerRegime === "fresh"
              ? Array.from(
                  { length: warmup + n },
                  () => segments.map((ids) => ids.slice()),
                )
              : null;
            let decoded = "";
            for (let sample = 0; sample < warmup; sample += 1) {
              const inputs = freshInputs === null ? segments : freshInputs[sample];
              for (const ids of inputs) decoded = globalThis.activeReference.decode(ids);
            }
            const samples = [];
            for (let sample = 0; sample < n; sample += 1) {
              const inputs = freshInputs === null ? segments : freshInputs[warmup + sample];
              const started = performance.now();
              for (const ids of inputs) decoded = globalThis.activeReference.decode(ids);
              const elapsed = performance.now() - started;
              if (!Number.isFinite(elapsed) || elapsed <= 0) {
                throw new Error(`Invalid decode duration: ${elapsed}`);
              }
              samples.push(bytes.length / (elapsed * 1_000));
            }
            if (typeof decoded !== "string" || decoded.length === 0) {
              throw new Error("Timed decode produced no text");
            }
            return { samples, tokenCount, segmentCount: segments.length, exact: true };
          },
            {
              corpusUrl: `${server.origin}/corpus/${workload.path}`,
              expectedBytes: workload.bytes,
              n: configuration.n,
              warmup: configuration.warmup,
              ordinary: ORDINARY_ID_REFERENCES.includes(load.reference),
              segmentBytes: DECODE_FIELD_SEGMENT_BYTES,
              containerRegime,
            },
          );
          const statistics = summarize(result.samples);
          rows.push({
            vocabulary,
            workload: workload.id,
            workloadBytes: workload.bytes,
            reference: load.reference,
            referenceVersion: load.version,
            environment: "browser",
            axis: "decode",
            containerRegime,
            tier: "single",
            simdLevel: "scalar",
            clockRegime:
              `performance.now; cross-origin isolated Chrome; warm cache; 4096-byte field segments; natural id containers; ${containerRegime} container regime`,
            status: "measured",
            exact: result.exact,
            n: statistics.n,
            median: statistics.median,
            p95: statistics.p95,
            variance: statistics.variance,
            units: "MB/s",
            iterationsPerSample: result.segmentCount,
            bytesPerSample: workload.bytes,
            tokenCount: result.tokenCount,
          });
          console.log(
            `${containerRegime} ${load.reference} ${workload.id}: ${statistics.median.toFixed(3)} MB/s`,
          );
        }
        await disposeReferencePayload(page);
      } finally {
        await page.close();
      }
    }
  }

  for (const containerRegime of configuration.decodeContainerRegimes) {
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
            axis: "decode",
            containerRegime,
            tier: null,
            simdLevel: null,
            clockRegime: null,
            status: "unavailable",
            reason: unavailable.reason,
            exact: null,
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
  }

  const requestProofs = requestLedgers.map((requests) => requests.assertLocal(server.origin));
  const localRequestCount = requestProofs.reduce((sum, proof) => sum + proof.requestCount, 0);

  const output = {
    schemaVersion: 3,
    axis: "decode",
    environment: "browser",
    browser: `Chrome ${browserVersion}`,
    chromeExecutable: executablePath,
    chromeExecutableSource: executableSource,
    crossOriginIsolated: true,
    localRequestCount,
    commit: runIdentity.commit,
    runIdentity,
    agreementKey: agreementReceipt.agreementKey,
    configuration,
    rows: addHypertokRatios(rows, agreementReceipt).map((row) =>
      benchmarkRow({
        ...row,
        profile: configuration.profile,
        mode: configuration.mode,
        commit: runIdentity.commit,
      }),
    ),
  };
  const publicOutput = writeRunResult({
    runIdentity,
    mode: configuration.mode,
    axis: "decode",
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
