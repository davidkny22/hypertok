import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createNodeAdapter,
  nodeReferenceIds,
  unavailableReferences,
} from "./adapters/node.mjs";
import { loadCorpus } from "./common/corpus.mjs";
import { loadAgreementReceipt } from "./common/agreement_gate.mjs";
import {
  buildArenaRunIdentity,
  nodeArenaArtifacts,
} from "./common/arena_identity.mjs";
import {
  addHypertokRatios,
  benchmarkConfiguration,
  measureEncodeThroughput,
} from "./common/throughput.mjs";
import { benchmarkRow } from "./common/row.mjs";
import { writeRunResult } from "./common/output.mjs";
import { vocabularyRegistry } from "./common/vocabularies.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const outputPath = path.join(repositoryDirectory, "results", "phase1", "node-throughput.json");
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

const runIdentity = buildArenaRunIdentity({
  environment: "node",
  commit: currentCommit(),
  workloads,
  artifacts: nodeArenaArtifacts(),
});
const agreementReceipt = loadAgreementReceipt("node", runIdentity);

for (const { id: vocabulary } of vocabularyRegistry) {
  for (const reference of nodeReferenceIds(vocabulary)) {
    const adapter = await createNodeAdapter(reference, vocabulary);
    try {
      for (const workload of workloads) {
        const result = await measureEncodeThroughput(adapter, workload, configuration);
        rows.push({
          vocabulary,
          workload: workload.id,
          workloadBytes: workload.bytes,
          reference: adapter.id,
          referenceVersion: adapter.version,
          environment: "node",
          tier: adapter.tier,
          simdLevel: adapter.simdLevel,
          clockRegime: "performance.now; Node single process; warm cache",
          status: "measured",
          n: result.statistics.n,
          median: result.statistics.median,
          p95: result.statistics.p95,
          variance: result.statistics.variance,
          units: "MB/s",
          iterationsPerSample: result.iterationsPerSample,
          bytesPerSample: result.bytesPerSample,
          tokenCount: result.tokenCount,
        });
        console.log(
          `${adapter.id} ${workload.id}: ${result.statistics.median.toFixed(3)} MB/s`,
        );
      }
    } finally {
      adapter.dispose();
    }
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
        environment: "node",
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

const output = {
  schemaVersion: 2,
  environment: "node",
  nodeVersion: process.version,
  commit: runIdentity.commit,
  runIdentity,
  agreementKey: agreementReceipt.agreementKey,
  configuration,
  rows: addHypertokRatios(rows, agreementReceipt).map((row) =>
    benchmarkRow({
      ...row,
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
