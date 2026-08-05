import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildBrowserBundle,
  browserOutputDirectory,
  referencePayloads,
  referenceSlugs,
} from "./browser/build.mjs";
import { launchHarnessBrowser, observeRequests } from "./browser/control.mjs";
import { startHarnessServer } from "./browser/server.mjs";
import {
  browserArenaArtifacts,
  buildArenaRunIdentity,
} from "./common/arena_identity.mjs";
import { loadCorpus } from "./common/corpus.mjs";
import { writeRunResult } from "./common/output.mjs";
import {
  availableReferences,
  referenceRecord,
  unavailableReferences,
} from "./common/reference_registry.mjs";
import { vocabularyRegistry } from "./common/vocabularies.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const referenceDirectory = path.join(browserOutputDirectory, "references");
const outputPath = path.join(
  repositoryDirectory,
  "results",
  "harness",
  "browser-transfer-sizes.json",
);
const hypertokPackageVersion = JSON.parse(
  fs.readFileSync(path.join(repositoryDirectory, "hypertok-js", "package.json"), "utf8"),
).version;
const esbuildVersion = JSON.parse(
  fs.readFileSync(path.join(benchesDirectory, "node_modules", "esbuild", "package.json"), "utf8"),
).version;

function currentCommit() {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${repositoryDirectory.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repositoryDirectory, encoding: "utf8" },
  ).trim();
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

await buildBrowserBundle();
const servedRoutes = new Map(
  referenceSlugs.map((slug) => [
    `/transfer/${slug}.mjs`,
    [
      path.join(referenceDirectory, `${slug}.mjs.gz`),
      "text/javascript; charset=utf-8",
      "gzip",
    ],
  ]),
);
const server = await startHarnessServer({ additionalRoutes: servedRoutes });
const { browser, browserVersion, executablePath, executableSource } =
  await launchHarnessBrowser();
const rows = [];
let localRequestCount = 0;

try {
  for (const payload of referencePayloads) {
    const page = await browser.newPage();
    const requests = observeRequests(page);
    try {
      await page.goto(`${server.origin}/blank`, { waitUntil: "load" });
      if (!(await page.evaluate(() => crossOriginIsolated))) {
        throw new Error("Transfer-size page is not cross-origin isolated");
      }
      const moduleUrl = `${server.origin}/transfer/${payload.slug}.mjs?measure=${Date.now()}`;
      const measured = await page.evaluate(
        async ({ url, vocabulary }) => {
          performance.clearResourceTimings();
          const module = await import(url);
          const adapter = await module.createAdapter(vocabulary);
          const probeIds = Array.from(adapter.encode("x"));
          adapter.dispose();
          if (probeIds.length === 0) throw new Error("First tokenize produced no ids");
          const timing = performance.getEntriesByName(url, "resource").at(-1);
          if (timing === undefined) throw new Error("Module transfer timing is missing");
          return {
            reference: adapter.id,
            referenceVersion: adapter.version,
            vocabulary: adapter.vocabulary,
            encodedBodySize: timing.encodedBodySize,
            decodedBodySize: timing.decodedBodySize,
            transferSize: timing.transferSize,
            probeTokenCount: probeIds.length,
          };
        },
        { url: moduleUrl, vocabulary: payload.vocabulary },
      );
      const gzipPath = path.join(referenceDirectory, `${payload.slug}.mjs.gz`);
      const modulePath = path.join(referenceDirectory, `${payload.slug}.mjs`);
      const gzipBytes = fs.statSync(gzipPath).size;
      const moduleBytes = fs.statSync(modulePath).size;
      if (
        measured.reference !== payload.reference ||
        measured.vocabulary !== payload.vocabulary ||
        measured.encodedBodySize !== gzipBytes ||
        measured.decodedBodySize !== moduleBytes
      ) {
        throw new Error(`${payload.slug}: served transfer identity mismatch`);
      }
      const registry = referenceRecord(payload.reference);
      if (measured.referenceVersion !== registry.version) {
        throw new Error(`${payload.slug}: package version mismatch`);
      }
      rows.push({
        reference: payload.reference,
        referenceVersion: registry.version,
        packageVersion:
          payload.reference === "hypertok" ? hypertokPackageVersion : registry.version,
        vocabulary: payload.vocabulary,
        status: "measured",
        compressedBytes: measured.encodedBodySize,
        decompressedBytes: measured.decodedBodySize,
        transferSize: measured.transferSize,
        gzipSha256: sha256File(gzipPath),
        probeTokenCount: measured.probeTokenCount,
      });
      const proof = requests.assertLocal(server.origin);
      localRequestCount += proof.requestCount;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

for (const record of unavailableReferences) {
  for (const { id: vocabulary } of vocabularyRegistry) {
    rows.push({
      reference: record.id,
      referenceVersion: record.version,
      packageVersion: null,
      vocabulary,
      status: "unavailable",
      reason: record.reason,
      compressedBytes: null,
      decompressedBytes: null,
      transferSize: null,
      gzipSha256: null,
      probeTokenCount: null,
    });
  }
}

const measuredFamilies = new Set(
  rows.filter(({ status }) => status === "measured").map(({ reference }) => reference),
);
if (
  rows.filter(({ status }) => status === "measured").length !== referencePayloads.length ||
  availableReferences.some(({ id }) => !measuredFamilies.has(id))
) {
  throw new Error("Transfer-size ledger does not cover every available reference family");
}

const workloads = loadCorpus();
const runIdentity = buildArenaRunIdentity({
  environment: "browser",
  commit: currentCommit(),
  workloads,
  artifacts: browserArenaArtifacts(browserOutputDirectory, referenceSlugs),
});
const result = {
  schemaVersion: 1,
  axis: "transfer-size",
  environment: "browser",
  browser: `Chrome ${browserVersion}`,
  chromeExecutable: executablePath,
  chromeExecutableSource: executableSource,
  crossOriginIsolated: true,
  commit: runIdentity.commit,
  runIdentity,
  method: {
    bundle: `esbuild ${esbuildVersion}; browser ESM; target chrome150; package code, vocabulary data, and required wasm embedded in one entry per reference and vocabulary`,
    compression: "Node gzip level 9 with the default zlib strategy",
    serving: "same-origin HTTP module response with Content-Encoding: gzip and Cache-Control: no-store",
    sizeMetric: "Chrome PerformanceResourceTiming.encodedBodySize, checked against the served gzip file byte count",
    firstTokenize: "fresh isolated page; import module; construct adapter; encode one-character probe x",
  },
  localRequestCount,
  availableFamilyCount: measuredFamilies.size,
  measuredRowCount: rows.filter(({ status }) => status === "measured").length,
  unavailableRowCount: rows.filter(({ status }) => status === "unavailable").length,
  rows,
};
const publicOutput = writeRunResult({
  runIdentity,
  mode: process.env.HYPERTOK_BENCH_MODE ?? "full",
  axis: "transfer-size",
  result,
});
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(publicOutput.result, null, 2)}\n`);

console.log(
  `browser transfer-size ledger PASS (${measuredFamilies.size}/${availableReferences.length} families; ${result.measuredRowCount}/${referencePayloads.length} measured rows; ${result.unavailableRowCount} unavailable rows)`,
);
for (const row of rows.filter(({ status }) => status === "measured")) {
  console.log(
    `${row.vocabulary}/${row.reference}@${row.packageVersion}: gzip=${row.compressedBytes}; module=${row.decompressedBytes}`,
  );
}
console.log(`cross-origin isolation PASS; local-only requests ${localRequestCount}/${localRequestCount}`);
console.log(path.relative(repositoryDirectory, outputPath).replaceAll("\\", "/"));
console.log(path.relative(repositoryDirectory, publicOutput.resultPath).replaceAll("\\", "/"));
