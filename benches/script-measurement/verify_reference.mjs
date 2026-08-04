import fs from "node:fs";
import { workloadIds } from "./corpus.mjs";

const [hostPath, referencePath, manifestPath, lockPath, mode = "gate"] = process.argv.slice(2);
if (!hostPath || !referencePath || !manifestPath || !lockPath) {
  throw new Error(
    "usage: verify_reference.mjs host-agreement reference-agreement manifest lock [gate|mutation-revision|mutation-id]",
  );
}
if (!new Set(["gate", "mutation-revision", "mutation-id"]).has(mode)) {
  throw new Error(`unknown reference verification mode ${mode}`);
}

const expectedVersion = "0.10.0";
const expectedCommit = "34a1599f0c0ae7d7cd0d1c530e6522320158b360";
const expectedSourceDigest = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";
const repository = "https://github.com/marcelroed/gigatoken";
const parse = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hostRows = parse(hostPath);
const referenceRows = parse(referencePath);

if (mode === "mutation-revision") {
  referenceRows[0] = { ...referenceRows[0], referenceCommit: `0${expectedCommit.slice(1)}` };
}
if (mode === "mutation-id") {
  const digest = referenceRows[0].idDigest;
  const replacement = digest.startsWith("0") ? "1" : "0";
  referenceRows[0] = { ...referenceRows[0], idDigest: `${replacement}${digest.slice(1)}` };
}

const manifest = fs.readFileSync(manifestPath, "utf8");
if (
  !manifest.includes(`git = "${repository}"`) ||
  !manifest.includes(`rev = "${expectedCommit}"`)
) {
  throw new Error("gigatoken reference manifest is not pinned to the exact revision");
}
const packageBlock = fs
  .readFileSync(lockPath, "utf8")
  .split("[[package]]")
  .find((block) => /^name = "gigatoken"$/m.test(block.trim()));
if (!packageBlock) throw new Error("gigatoken reference lock package is absent");
if (!packageBlock.includes(`version = "${expectedVersion}"`)) {
  throw new Error("gigatoken reference lock version differs");
}
const source = packageBlock.match(/^source = "([^"]+)"$/m)?.[1];
if (!source?.startsWith(`git+${repository}?rev=${expectedCommit}#`) || !source.endsWith(expectedCommit)) {
  throw new Error(`gigatoken reference lock source differs: ${source ?? "absent"}`);
}

const indexed = (rows, label) => {
  if (!Array.isArray(rows) || rows.length !== workloadIds.length) {
    throw new Error(`${label} agreement row count differs`);
  }
  const map = new Map();
  for (const row of rows) {
    if (!workloadIds.includes(row.workload) || map.has(row.workload)) {
      throw new Error(`${label} has invalid workload ${row.workload}`);
    }
    if (!Number.isInteger(row.tokenCount) || row.tokenCount < 0 || !/^[0-9a-f]{64}$/.test(row.idDigest)) {
      throw new Error(`${label} has invalid agreement row ${row.workload}`);
    }
    map.set(row.workload, row);
  }
  return map;
};

const host = indexed(hostRows, "hypertok host");
const reference = indexed(referenceRows, "gigatoken reference");
for (const workload of workloadIds) {
  const actual = reference.get(workload);
  if (
    actual.reference !== "gigatoken" ||
    actual.referenceVersion !== expectedVersion ||
    actual.referenceCommit !== expectedCommit ||
    actual.sourceDigest !== expectedSourceDigest
  ) {
    throw new Error(`${workload} gigatoken provenance differs`);
  }
  const expected = host.get(workload);
  if (actual.tokenCount !== expected.tokenCount || actual.idDigest !== expected.idDigest) {
    throw new Error(`${workload} gigatoken agreement differs`);
  }
}

console.log(
  `gigatoken reference agreement PASS: workloads=${workloadIds.length}/${workloadIds.length} version=${expectedVersion} commit=${expectedCommit}`,
);
