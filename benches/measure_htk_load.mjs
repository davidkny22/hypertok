import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { summarize } from "./common/timing.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const crateDirectory = path.join(benchesDirectory, "load-measurement");
const workerPath = path.join(
  crateDirectory,
  "target",
  "release",
  process.platform === "win32" ? "hypertok-load-worker.exe" : "hypertok-load-worker",
);
const outputDirectory = path.resolve(
  repositoryDirectory,
  process.env.HYPERTOK_LOAD_OUTPUT_DIRECTORY ?? "results/load-measurement",
);
if (
  outputDirectory !== repositoryDirectory &&
  !outputDirectory.startsWith(`${repositoryDirectory}${path.sep}`)
) {
  throw new Error("load-measurement output must stay inside the repository");
}
const outputPath = path.join(outputDirectory, "load-measurement.json");
const fixtureDirectory = path.join(outputDirectory, "fixtures");
const inputs = process.argv.slice(2);
const n = Number(process.env.HYPERTOK_LOAD_N ?? 31);
const warmupN = Number(process.env.HYPERTOK_LOAD_WARMUP_N ?? 3);
const probeCount = Number(process.env.HYPERTOK_MISS_PROBES ?? 500_000);
const candidates = Object.freeze([
  "mph-u32",
  "mph-packed18",
  "table-850",
  "table-875",
  "table-900",
]);
const tableEquivalenceBound = 0.03;

const decisionSelfCheckMode =
  inputs[0] === "--decision-self-check" ? (inputs[1] ?? "gate") : null;
if (inputs.length === 0) {
  throw new Error("usage: node benches/measure_htk_load.mjs <input.htk> [...]");
}
for (const [name, value] of Object.entries({ n, warmupN, probeCount })) {
  if (!Number.isInteger(value) || value < (name === "warmupN" ? 0 : 1)) {
    throw new Error(`${name} must be a valid integer`);
  }
}

function runWorker(args) {
  return JSON.parse(
    execFileSync(workerPath, args, {
      cwd: repositoryDirectory,
      encoding: "utf8",
      maxBuffer: 10_000_000,
    }),
  );
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function currentCommit() {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${repositoryDirectory.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repositoryDirectory, encoding: "utf8" },
  ).trim();
}

function geometricMean(values) {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

function chooseTableCandidate(score, equivalenceBound = tableEquivalenceBound) {
  const tableCandidates = ["table-850", "table-875", "table-900"];
  const bestScore = Math.min(...tableCandidates.map(score));
  return tableCandidates.find((candidate) => score(candidate) <= bestScore * (1 + equivalenceBound));
}

if (decisionSelfCheckMode !== null) {
  const cases = [
    { scores: [100, 99, 110], expected: "table-850" },
    { scores: [104, 99, 110], expected: "table-875" },
    { scores: [100, 100, 100], expected: "table-850" },
  ];
  const bound = decisionSelfCheckMode === "mutation-probe" ? 0 : tableEquivalenceBound;
  for (const testCase of cases) {
    const scores = new Map(
      ["table-850", "table-875", "table-900"].map((candidate, index) => [
        candidate,
        testCase.scores[index],
      ]),
    );
    const actual = chooseTableCandidate((candidate) => scores.get(candidate), bound);
    if (actual !== testCase.expected) {
      throw new Error(`decision self-check expected ${testCase.expected}, got ${actual}`);
    }
  }
  console.log(`load decision self-check PASS: cases=${cases.length}/${cases.length}`);
  process.exit(0);
}

function choose(rows) {
  const byCandidate = new Map();
  for (const row of rows) {
    const values = byCandidate.get(row.candidate) ?? [];
    values.push(row);
    byCandidate.set(row.candidate, values);
  }
  const score = (candidate) => geometricMean(byCandidate.get(candidate).map((row) => row.missProbe.median));
  const mphU32 = score("mph-u32");
  const mphPacked = score("mph-packed18");
  const payload = mphPacked <= mphU32 * 1.02 ? "mph-packed18" : "mph-u32";
  const table = chooseTableCandidate(score);
  const mphScore = score(payload);
  const tableScore = score(table);
  const hashScheme = mphScore <= tableScore ? 1 : 0;
  return {
    hashScheme,
    selectedCandidate: hashScheme === 1 ? payload : table,
    selectedMphPayload: payload,
    selectedTableDensity: Number(table.slice("table-".length)) / 1000,
    tableEquivalenceBound,
    missHeavyGeometricMedianMilliseconds: {
      mph: mphScore,
      table: tableScore,
    },
    rule:
      "lowest-density table within 3% of the best miss-heavy geometric median across both structural classes; packed 18-bit payload wins when no more than 2% slower than u32",
  };
}

execFileSync(
  "cargo",
  [
    "+stable-x86_64-pc-windows-msvc",
    "build",
    "--release",
    "--manifest-path",
    path.join(crateDirectory, "Cargo.toml"),
    "--offline",
  ],
  { cwd: repositoryDirectory, stdio: "inherit" },
);
fs.mkdirSync(fixtureDirectory, { recursive: true });

const startupSamples = [];
for (let index = 0; index < warmupN + n; index += 1) {
  const started = performance.now();
  runWorker(["noop"]);
  const elapsed = performance.now() - started;
  if (index >= warmupN) startupSamples.push(elapsed);
}

const prepared = inputs.map((input) => {
  const resolved = path.resolve(repositoryDirectory, input);
  const fixture = runWorker(["prepare", resolved, fixtureDirectory]);
  return {
    ...fixture,
    sourceSha256: sha256(resolved),
  };
});

const mutationChecks = prepared.map((vocabulary) => ({
  vocabulary: vocabulary.name,
  ...runWorker(["mutations", vocabulary.scheme1Path]),
}));
if (mutationChecks.some((result) => result.red !== result.total)) {
  throw new Error("A planted load-index mutation stayed green");
}

const rows = [];
for (const vocabulary of prepared) {
  const samplesByCandidate = new Map(candidates.map((candidate) => [candidate, []]));
  for (let index = 0; index < warmupN; index += 1) {
    const offset = index % candidates.length;
    const order = [...candidates.slice(offset), ...candidates.slice(0, offset)];
    for (const candidate of order) {
      const inputPath = candidate.startsWith("mph-")
        ? vocabulary.scheme1Path
        : vocabulary.scheme0Path;
      runWorker(["sample", candidate, inputPath, String(Math.min(probeCount, 10_000))]);
    }
  }
  for (let index = 0; index < n; index += 1) {
    const offset = index % candidates.length;
    const order = [...candidates.slice(offset), ...candidates.slice(0, offset)];
    for (const candidate of order) {
      const inputPath = candidate.startsWith("mph-")
        ? vocabulary.scheme1Path
        : vocabulary.scheme0Path;
      samplesByCandidate
        .get(candidate)
        .push(runWorker(["sample", candidate, inputPath, String(probeCount)]));
    }
  }
  for (const candidate of candidates) {
    const samples = samplesByCandidate.get(candidate);
    const invariant = (name) => {
      const values = new Set(samples.map((sample) => sample[name]));
      if (values.size !== 1) throw new Error(`${vocabulary.name}/${candidate}: ${name} changed`);
      return samples[0][name];
    };
    const residentBytes = invariant("residentBytes");
    invariant("checksum");
    invariant("verifiedKeys");
    invariant("verifiedMisses");
    const materialisationWithStartup = samples.map(
      (sample, index) => sample.materialisationMilliseconds + startupSamples[index],
    );
    const row = {
      vocabulary: vocabulary.name,
      candidate,
      workload: "miss-heavy-95",
      environment: "native",
      tier: "single",
      simdLevel: "scalar",
      clockRegime: "Rust Instant plus fresh-process performance.now startup; warm filesystem cache",
      compressedBytes: invariant("compressedBytes"),
      decompressedBytes: invariant("decompressedBytes"),
      keySetSize: invariant("keySetSize"),
      blockShift: invariant("blockShift"),
      probeCount: invariant("probeCount"),
      missCount: invariant("missCount"),
      hitCount: invariant("hitCount"),
      transfer: { ...summarize(samples.map((sample) => sample.transferMilliseconds)), units: "ms" },
      decompression: {
        ...summarize(samples.map((sample) => sample.decompressionMilliseconds)),
        units: "ms",
      },
      materialisation: { ...summarize(materialisationWithStartup), units: "ms" },
      materialisationWorkerOnly: {
        ...summarize(samples.map((sample) => sample.materialisationMilliseconds)),
        units: "ms",
      },
      missProbe: {
        ...summarize(samples.map((sample) => sample.missProbeMilliseconds)),
        units: "ms",
      },
      resident: { n: 1, median: residentBytes, p95: residentBytes, variance: 0, units: "bytes" },
      memory: samples[0].memory,
      status: "measured",
    };
    rows.push(row);
    console.log(
      `${vocabulary.name}/${candidate}: materialisation=${row.materialisation.median.toFixed(3)} ms; miss-heavy=${row.missProbe.median.toFixed(3)} ms; resident=${residentBytes}`,
    );
  }
}

const result = {
  schemaVersion: 1,
  commit: currentCommit(),
  generatedAt: new Date().toISOString(),
  configuration: {
    n,
    warmupN,
    probeCount,
    missRatio: 0.95,
    compression: "Brotli quality 11, lgwin 22",
    transfer: "local filesystem read of compressed .htk; warmup outside timing",
    decompression: "brotli 8.0.4 native Rust decoder",
    materialisation: "validated file, selective copy, two-level offsets, index, fixed one-character probe, plus measured fresh-process startup",
    worker: "stable-x86_64-pc-windows-msvc release with fat LTO",
    startup: { ...summarize(startupSamples), units: "ms" },
  },
  inputs: prepared,
  mutationChecks,
  rows,
  decision: choose(rows),
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`hash_scheme=${result.decision.hashScheme}; candidate=${result.decision.selectedCandidate}`);
console.log(path.relative(repositoryDirectory, outputPath).replaceAll("\\", "/"));
