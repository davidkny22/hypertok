import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workloadIds } from "./common/corpus.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const sessionName =
  process.env.HYPERTOK_RUN_SESSION ?? new Date().toISOString().replaceAll(":", "-");
const outputDirectory = path.join(
  repositoryDirectory,
  "results",
  "harness",
  "stationarity",
  sessionName,
);
const identityPath = path.resolve(
  process.env.HYPERTOK_CONTAINER_IDENTITY ??
    path.join(repositoryDirectory, "results", "harness", "container-identity.json"),
);
const workerPath = path.join(benchesDirectory, "stationarity_session.mjs");
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryDirectory,
  encoding: "utf8",
}).trim();

if (!fs.existsSync(identityPath)) {
  throw new Error(`Container identity is absent: ${identityPath}`);
}
const identityBytes = fs.readFileSync(identityPath);
const identity = JSON.parse(identityBytes.toString("utf8"));
if (identity.commit !== commit || identity.crossOriginIsolated !== true) {
  throw new Error("Container identity does not match the active isolated product commit");
}
const containerIdentitySha256 = crypto.createHash("sha256").update(identityBytes).digest("hex");

fs.mkdirSync(outputDirectory, { recursive: true });
const sourcePaths = [];
for (const environment of ["node", "browser"]) {
  for (let session = 1; session <= 3; session += 1) {
    const outputPath = path.join(outputDirectory, `${environment}-session-${session}.json`);
    const result = spawnSync(
      process.execPath,
      [workerPath, environment, String(session), outputPath],
      { cwd: benchesDirectory, env: process.env, stdio: "inherit" },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${environment} stationarity session ${session} failed`);
    }
    sourcePaths.push(outputPath);
  }
}

const readSessions = () => sourcePaths.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function analyze(inputSessions, mutation) {
  const sessions = structuredClone(inputSessions);
  if (mutation === "output") sessions[3].rows[0].idDigest = "0".repeat(64);
  const environments = ["node", "browser"];
  for (const environment of environments) {
    const group = sessions.filter((entry) => entry.environment === environment);
    assert(group.length === 3, `${environment}: session count`);
    for (const [index, session] of group.entries()) {
      assert(session.session === index + 1, `${environment}: session order`);
      assert(session.reference === "hypertok", `${environment}: reference`);
      assert(session.configuration.n === 21, `${environment}: sample count`);
      assert(session.configuration.warmup === 2, `${environment}: warmup`);
      assert(session.configuration.targetBytesPerSample === 4_194_304, `${environment}: target bytes`);
      assert(session.rows.length === workloadIds.length, `${environment}: workload count`);
      assert(
        session.rows.every((row, rowIndex) => row.workload === workloadIds[rowIndex]),
        `${environment}: workload order`,
      );
      if (environment === "browser") {
        assert(session.crossOriginIsolated === true, `${environment}: isolation`);
        assert(session.localRequestCount > 0, `${environment}: local requests`);
      }
      for (const row of session.rows) {
        assert(row.bytesPerSample >= 4_194_304, `${environment}/${row.workload}: bytes`);
        assert(/^[0-9a-f]{64}$/.test(row.idDigest), `${environment}/${row.workload}: digest`);
        assert(row.statistics.n === 21, `${environment}/${row.workload}: n`);
        for (const field of ["median", "p95", "variance"]) {
          assert(Number.isFinite(row.statistics[field]) && row.statistics[field] >= 0, `${environment}/${row.workload}: ${field}`);
        }
      }
    }
  }

  for (let workloadIndex = 0; workloadIndex < workloadIds.length; workloadIndex += 1) {
    const rows = sessions.map((session) => session.rows[workloadIndex]);
    const first = rows[0];
    assert(
      rows.every(
        (row) =>
          row.workloadBytes === first.workloadBytes &&
          row.tokenCount === first.tokenCount &&
          row.idDigest === first.idDigest,
      ),
      `${first.workload}: cross-session output mismatch`,
    );
  }

  const measurements = [];
  for (const environment of environments) {
    const group = sessions.filter((entry) => entry.environment === environment);
    for (let workloadIndex = 0; workloadIndex < workloadIds.length; workloadIndex += 1) {
      const sessionRows = group.map((session) => session.rows[workloadIndex]);
      const medians = sessionRows.map((row) => row.statistics.median);
      const minimum = Math.min(...medians);
      const maximum = Math.max(...medians);
      const computedDriftFraction = maximum / minimum - 1;
      const reportedDriftFraction =
        mutation === "drift" && environment === "node" && workloadIndex === 0
          ? computedDriftFraction + 0.1
          : computedDriftFraction;
      assert(
        Math.abs(reportedDriftFraction - computedDriftFraction) <= Number.EPSILON * 8,
        `${environment}/${workloadIds[workloadIndex]}: drift arithmetic mismatch`,
      );
      const conservativeIndex = medians.indexOf(minimum);
      const conservative = sessionRows[conservativeIndex];
      const agreementKey = sha256(
        `${commit}\0${identity.containerId}\0${environment}\0${conservative.workload}\0${conservative.idDigest}`,
      );
      measurements.push({
        environment,
        workload: conservative.workload,
        workloadBytes: conservative.workloadBytes,
        reference: "hypertok",
        referenceVersion: conservative.referenceVersion ?? group[0].referenceVersion,
        tier: group[0].tier,
        simdLevel: group[0].simdLevel,
        clockRegime: group[0].clockRegime,
        n: conservative.statistics.n,
        median: conservative.statistics.median,
        p95: conservative.statistics.p95,
        variance: conservative.statistics.variance,
        units: "MB/s",
        sessionMedians: medians,
        driftFraction: reportedDriftFraction,
        driftPercent: reportedDriftFraction * 100,
        conservativeSession: conservativeIndex + 1,
        tokenCount: conservative.tokenCount,
        idDigest: conservative.idDigest,
        commit,
        containerId: identity.containerId,
        containerIdentitySha256,
        agreementKey,
        status: "verified",
      });
    }
  }
  return measurements;
}

const sessions = readSessions();
let mutationsRed = 0;
for (const mutation of ["output", "drift"]) {
  try {
    analyze(sessions, mutation);
  } catch {
    mutationsRed += 1;
  }
}
assert(mutationsRed === 2, "Stationarity mutations did not both turn RED");
const measurements = analyze(sessions);
const adoptedDrift = workloadIds.map((workload) => {
  const rows = measurements.filter((row) => row.workload === workload);
  const driftFraction = Math.max(...rows.map((row) => row.driftFraction));
  return { workload, driftFraction, driftPercent: driftFraction * 100 };
});
const report = {
  schemaVersion: 1,
  gate: "stationarity-baseline",
  status: "PASS",
  commit,
  containerIdentity: identity,
  containerIdentitySha256,
  sessionDefinition: "three fresh Node processes and three fresh isolated Chrome lifetimes; warm cache only within each session",
  sessionCountPerEnvironment: 3,
  nPerSession: 21,
  targetBytesPerSample: 4_194_304,
  measurements,
  adoptedDrift,
  mutationTeeth: { observedRed: mutationsRed, total: 2 },
  sourceRuns: sourcePaths.map((filePath) => ({
    path: path.relative(repositoryDirectory, filePath).replaceAll("\\", "/"),
    sha256: sha256(fs.readFileSync(filePath)),
  })),
  summary: {
    environments: 2,
    sessions: 6,
    exactSessionRows: 36,
    measuredRows: measurements.length,
    adoptedWorkloadBounds: adoptedDrift.length,
    maximumDriftFraction: Math.max(...adoptedDrift.map((row) => row.driftFraction)),
    localBrowserRequests: sessions
      .filter((session) => session.environment === "browser")
      .reduce((sum, session) => sum + session.localRequestCount, 0),
  },
};
const reportPath = path.join(outputDirectory, "report.json");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const registryPath = path.join(outputDirectory, "registry-records.jsonl");
const registryRecords = measurements.map((row) => ({
  id: `container-${row.containerId}-${row.environment}-${row.workload}`,
  kind: "bench",
  workload: row.workload,
  reference: row.reference,
  reference_version: row.referenceVersion,
  environment: row.environment,
  tier: row.tier,
  simd_level: row.simdLevel,
  clock_regime: row.clockRegime,
  n: row.n,
  median: row.median,
  p95: row.p95,
  variance: row.variance,
  units: row.units,
  commit: row.commit,
  container_identity: row.containerId,
  container_identity_sha256: row.containerIdentitySha256,
  agreement_key: row.agreementKey,
  status: "verified",
}));
fs.writeFileSync(registryPath, `${registryRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
console.log(
  `stationarity-baseline PASS: sessions=6 rows=${measurements.length} max_drift=${report.summary.maximumDriftFraction} mutations RED=2/2`,
);
console.log(path.relative(repositoryDirectory, reportPath).replaceAll("\\", "/"));
