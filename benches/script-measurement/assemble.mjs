import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scriptStressIds, workloadIds } from "./corpus.mjs";

const [hostScalarPath, hostSimdPath, referencePath, wasmPath, outputPath, mode = "gate"] =
  process.argv.slice(2);
if (!hostScalarPath || !hostSimdPath || !referencePath || !wasmPath || !outputPath) {
  throw new Error(
    "usage: assemble.mjs host-scalar host-simd gigatoken-reference wasm output [gate|mutation-probe]",
  );
}
if (mode !== "gate" && mode !== "mutation-probe") {
  throw new Error(`unknown assembly mode ${mode}`);
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "..", "..");
const parseRows = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const wasmMeasurement = parseRows(wasmPath);
if (
  !Array.isArray(wasmMeasurement.rows) ||
  !Array.isArray(wasmMeasurement.chunkSizeRefusals) ||
  wasmMeasurement.chunkSizeRefusals.length !== 2 ||
  wasmMeasurement.chunkSizeRefusals.some(
    ({ simdLevel, result }) =>
      !["scalar", "simd128"].includes(simdLevel) || result !== "refused",
  )
) {
  throw new Error("WebAssembly chunk-size assumption controls are incomplete");
}
const rows = [
  ...parseRows(hostScalarPath),
  ...parseRows(hostSimdPath),
  ...parseRows(referencePath),
  ...wasmMeasurement.rows,
];
if (mode === "mutation-probe") {
  const replacement = rows[0].idDigest.startsWith("0") ? "1" : "0";
  rows[0] = { ...rows[0], idDigest: `${replacement}${rows[0].idDigest.slice(1)}` };
}

const hostLevels = [
  ...new Set(
    rows
      .filter(
        ({ environment, simdLevel }) =>
          environment === "hypertok-host" && simdLevel !== "scalar",
      )
      .map(({ simdLevel }) => simdLevel),
  ),
];
if (hostLevels.length !== 1 || !["avx2", "avx512"].includes(hostLevels[0])) {
  throw new Error(`expected one hypertok host vector level, got ${hostLevels.join(",")}`);
}
const hostVector = hostLevels[0];
const referenceLevels = [
  ...new Set(
    rows
      .filter(({ environment }) => environment === "gigatoken-native")
      .map(({ simdLevel }) => simdLevel),
  ),
];
if (
  referenceLevels.length !== 1 ||
  !["scalar", "avx2", "avx512", "neon"].includes(referenceLevels[0])
) {
  throw new Error(`expected one gigatoken reference level, got ${referenceLevels.join(",")}`);
}
const referenceVector = referenceLevels[0];
const configurations = [
  ["hypertok-host", "scalar", false],
  ["hypertok-host", "scalar", true],
  ["hypertok-host", hostVector, false],
  ["hypertok-host", hostVector, true],
  ["gigatoken-native", referenceVector, false],
  ["wasm-node", "scalar", false],
  ["wasm-node", "scalar", true],
  ["wasm-node", "simd128", false],
  ["wasm-node", "simd128", true],
];

if (rows.length !== workloadIds.length * configurations.length) {
  throw new Error(`row count ${rows.length} != ${workloadIds.length * configurations.length}`);
}
const rowMap = new Map();
for (const row of rows) {
  const key = `${row.workload}|${row.environment}|${row.simdLevel}|${row.chunking}`;
  if (rowMap.has(key)) throw new Error(`duplicate row ${key}`);
  if (
    row.tier !== "single" ||
    row.units !== "MB/s" ||
    !Number.isInteger(row.statistics?.n) ||
    row.statistics.n < 1 ||
    !Number.isFinite(row.statistics.median) ||
    row.statistics.median <= 0 ||
    !Number.isFinite(row.statistics.p95) ||
    row.statistics.p95 <= 0 ||
    !Number.isFinite(row.statistics.variance) ||
    row.statistics.variance < 0 ||
    !Number.isSafeInteger(row.bytesPerSample) ||
    row.bytesPerSample < row.workloadBytes ||
    !Number.isInteger(row.tokenCount) ||
    row.tokenCount < 0 ||
    !/^[0-9a-f]{64}$/.test(row.idDigest)
  ) {
    throw new Error(`invalid measurement row ${key}`);
  }
  if (
    row.environment === "gigatoken-native" &&
    (row.reference !== "gigatoken" ||
      row.referenceVersion !== "0.10.0" ||
      row.referenceCommit !== "34a1599f0c0ae7d7cd0d1c530e6522320158b360" ||
      row.sourceDigest !== "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d")
  ) {
    throw new Error(`invalid gigatoken reference provenance ${key}`);
  }
  if (row.chunking) {
    const telemetry = row.chunkTelemetry;
    if (
      !telemetry ||
      !Number.isInteger(telemetry.pretokens) ||
      telemetry.pretokens < 1 ||
      !Number.isInteger(telemetry.engagedPretokens) ||
      telemetry.engagedPretokens < 0 ||
      !Number.isInteger(telemetry.initialChunks) ||
      telemetry.initialChunks < telemetry.pretokens ||
      !Number.isInteger(telemetry.enlargements) ||
      telemetry.enlargements < 0 ||
      !Number.isInteger(telemetry.chunkSize) ||
      telemetry.chunkSize < 1
    ) {
      throw new Error(`invalid chunk telemetry ${key}`);
    }
  } else if (row.chunkTelemetry !== null) {
    throw new Error(`unchunked row carries telemetry ${key}`);
  }
  rowMap.set(key, row);
}

for (const workload of workloadIds) {
  const expected = configurations.map(([environment, simdLevel, chunking]) =>
    rowMap.get(`${workload}|${environment}|${simdLevel}|${chunking}`),
  );
  if (expected.some((row) => !row)) throw new Error(`incomplete matrix for ${workload}`);
  const digests = new Set(expected.map(({ idDigest }) => idDigest));
  const lengths = new Set(expected.map(({ tokenCount }) => tokenCount));
  if (digests.size !== 1 || lengths.size !== 1) {
    throw new Error(`agreement mismatch for ${workload}`);
  }
}

for (const workload of scriptStressIds) {
  for (const [environment, simdLevel] of [
    ["hypertok-host", "scalar"],
    ["hypertok-host", hostVector],
    ["wasm-node", "scalar"],
    ["wasm-node", "simd128"],
  ]) {
    const row = rowMap.get(`${workload}|${environment}|${simdLevel}|true`);
    if (row.chunkTelemetry.engagedPretokens < 1) {
      throw new Error(`${workload}/${environment}/${simdLevel} did not engage chunking`);
    }
  }
}

for (const [environment, simdLevel] of [
  ["hypertok-host", "scalar"],
  ["hypertok-host", hostVector],
  ["wasm-node", "scalar"],
  ["wasm-node", "simd128"],
]) {
  const engaged = rows
    .filter(
      (row) =>
        row.environment === environment && row.simdLevel === simdLevel && row.chunking,
    )
    .reduce((sum, row) => sum + row.chunkTelemetry.engagedPretokens, 0);
  if (engaged < 1) throw new Error(`${environment}/${simdLevel} never engaged chunking`);
}

const median = (workload, environment, simdLevel, chunking) =>
  rowMap.get(`${workload}|${environment}|${simdLevel}|${chunking}`).statistics.median;
const ratios = workloadIds.map((workload) => ({
  workload,
  chunkingEngagedConfigurations: configurations
    .filter(([, , chunking]) => chunking)
    .filter(
      ([environment, simdLevel]) =>
        rowMap.get(`${workload}|${environment}|${simdLevel}|true`).chunkTelemetry
          .engagedPretokens > 0,
    ).length,
  hostVectorizationUnchunked:
    median(workload, "hypertok-host", hostVector, false) /
    median(workload, "hypertok-host", "scalar", false),
  hostVectorizationChunked:
    median(workload, "hypertok-host", hostVector, true) /
    median(workload, "hypertok-host", "scalar", true),
  wasmVectorizationUnchunked:
    median(workload, "wasm-node", "simd128", false) /
    median(workload, "wasm-node", "scalar", false),
  wasmVectorizationChunked:
    median(workload, "wasm-node", "simd128", true) /
    median(workload, "wasm-node", "scalar", true),
  hostScalarChunking:
    median(workload, "hypertok-host", "scalar", true) /
    median(workload, "hypertok-host", "scalar", false),
  hostVectorChunking:
    median(workload, "hypertok-host", hostVector, true) /
    median(workload, "hypertok-host", hostVector, false),
  wasmScalarChunking:
    median(workload, "wasm-node", "scalar", true) /
    median(workload, "wasm-node", "scalar", false),
  wasmSimdChunking:
    median(workload, "wasm-node", "simd128", true) /
    median(workload, "wasm-node", "simd128", false),
  scalarWasmToHostUnchunked:
    median(workload, "wasm-node", "scalar", false) /
    median(workload, "hypertok-host", "scalar", false),
  scalarWasmToHostChunked:
    median(workload, "wasm-node", "scalar", true) /
    median(workload, "hypertok-host", "scalar", true),
  simdWasmToHostUnchunked:
    median(workload, "wasm-node", "simd128", false) /
    median(workload, "hypertok-host", hostVector, false),
  simdWasmToHostChunked:
    median(workload, "wasm-node", "simd128", true) /
    median(workload, "hypertok-host", hostVector, true),
  hostVectorToGigatoken:
    median(workload, "hypertok-host", hostVector, false) /
    median(workload, "gigatoken-native", referenceVector, false),
  wasmSimdToGigatoken:
    median(workload, "wasm-node", "simd128", false) /
    median(workload, "gigatoken-native", referenceVector, false),
}));

const commit = execFileSync(
  "git",
  ["-c", `safe.directory=${repository.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
  { cwd: repository, encoding: "utf8" },
).trim();
const report = {
  schemaVersion: 1,
  commit,
  host: {
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    node: process.version,
    rustc: execFileSync("rustc", ["+stable-x86_64-pc-windows-msvc", "--version"], {
      encoding: "utf8",
    }).trim(),
  },
  matrix: {
    workloads: workloadIds,
    configurations: configurations.map(([environment, simdLevel, chunking]) => ({
      environment,
      simdLevel,
      chunking,
    })),
    hostVector,
    gigatokenReferenceVector: referenceVector,
  },
  agreement: workloadIds.map((workload) => ({
    workload,
    idDigest: rowMap.get(`${workload}|hypertok-host|scalar|false`).idDigest,
    tokenCount: rowMap.get(`${workload}|hypertok-host|scalar|false`).tokenCount,
    configurations: 9,
  })),
  controls: {
    chunkSizeRefusals: wasmMeasurement.chunkSizeRefusals,
  },
  interpretation: {
    chunking:
      "Only ratios with chunkingEngagedConfigurations greater than zero include overlap work. Other chunk-enabled rows measure the pre-scan and direct batch path.",
    vectorization:
      "SIMD accelerates pretoken boundary classification. Unicode classification and BPE lookup and merge work remain shared scalar costs, so workload-specific ratios below one are retained.",
    incumbent:
      "gigatoken-native is the external Git-pinned upstream incumbent in its runtime-selected fastest scanner configuration. hypertok-host rows are same-engine scalar and vector diagnostics.",
    statistics:
      "Every row retains its measured median, p95, and population variance. No outlier or losing row is removed.",
  },
  rows: rows.map(({ statistics, ...row }) => ({
    ...row,
    ...statistics,
    status: "verified",
    commit,
  })),
  ratios,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
for (const ratio of ratios) {
  console.log(
    `${ratio.workload}: host-vector=${ratio.hostVectorizationUnchunked.toFixed(3)}x wasm-vector=${ratio.wasmVectorizationUnchunked.toFixed(3)}x wasm/host-scalar=${ratio.scalarWasmToHostUnchunked.toFixed(3)}x wasm/gigatoken=${ratio.wasmSimdToGigatoken.toFixed(3)}x`,
  );
}
console.log(`script-measurement rows: ${report.rows.length}`);
