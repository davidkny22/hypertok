import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unavailableReferences } from "./adapters/node.mjs";
import {
  buildBrowserBundle,
  referencePayloads,
} from "./browser/build.mjs";
import { loadAgreementReceipt } from "./common/agreement_gate.mjs";
import {
  buildArenaRunIdentity,
  nodeArenaArtifacts,
} from "./common/arena_identity.mjs";
import { loadCorpus } from "./common/corpus.mjs";
import { benchmarkMode, benchmarkProfile } from "./common/throughput.mjs";
import { summarize } from "./common/timing.mjs";
import { writeRunResult } from "./common/output.mjs";
import { vocabularyRegistry } from "./common/vocabularies.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const outputPath = path.join(repositoryDirectory, "results", "phase1", "node-load.json");
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

await buildBrowserBundle();
const runIdentity = buildArenaRunIdentity({
  environment: "node",
  commit: currentCommit(),
  workloads: loadCorpus(),
  artifacts: nodeArenaArtifacts(),
});
const agreementReceipt = loadAgreementReceipt("node", runIdentity);
const rows = [];
for (const { slug, vocabulary, reference } of referencePayloads) {
  const output = execFileSync(
    process.execPath,
    ["--expose-gc", "measure_node_load_worker.mjs", slug, vocabulary, String(n)],
    { cwd: benchesDirectory, encoding: "utf8", maxBuffer: 10_000_000 },
  );
  const row = JSON.parse(output);
  const memorySamples = [];
  const memoryTotals = [];
  const memoryDetails = [];
  for (let sample = 0; sample < memoryN; sample += 1) {
    const memoryOutput = execFileSync(
      process.execPath,
      ["--expose-gc", "measure_node_memory_worker.mjs", reference, vocabulary],
      { cwd: benchesDirectory, encoding: "utf8", maxBuffer: 1_000_000 },
    );
    const memory = JSON.parse(memoryOutput);
    if (memory.residentDelta < 0) {
      throw new Error(`${memory.reference}: negative resident-memory delta`);
    }
    memorySamples.push(memory.residentDelta);
    memoryTotals.push(memory.totalRss);
    memoryDetails.push(memory);
  }
  row.resident = {
    ...summarize(memorySamples),
    units: "bytes",
    total: { ...summarize(memoryTotals), units: "bytes" },
    samples: memoryDetails,
    method: "fresh process; direct fastest documented Node adapter; explicit garbage collection",
  };
  rows.push({
    ...row,
    vocabulary,
    environment: "node",
    tier: "single",
    simdLevel: "scalar",
    clockRegime: "performance.now; fresh Node process per reference; page-cold payload",
    status: "measured",
    profile,
    mode,
    agreementKey: agreementReceipt.agreementKey,
    probe: "x",
  });
  console.log(
    `${row.reference}: transfer=${row.transfer.median.toFixed(3)} ms; decompression=${row.decompression.median.toFixed(3)} ms; materialisation=${row.materialisation.median.toFixed(3)} ms; resident=${row.resident.median}`,
  );
}
for (const { id: vocabulary } of vocabularyRegistry) {
  for (const unavailable of unavailableReferences(vocabulary)) {
    rows.push({
      vocabulary,
      reference: unavailable.id,
      referenceVersion: unavailable.version,
      environment: "node",
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

const result = {
  schemaVersion: 2,
  environment: "node",
  nodeVersion: process.version,
  profile,
  mode,
  commit: runIdentity.commit,
  runIdentity,
  agreementKey: agreementReceipt.agreementKey,
  configuration: {
    n,
    memoryN,
    profile,
    mode,
    compression: "gzip level 9",
    transfer: "local filesystem read of compressed self-contained payload",
    materialisation: "module startup, instance construction, and fixed one-character probe",
    memory: "fresh-process RSS delta for the direct fastest documented Node adapter",
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
