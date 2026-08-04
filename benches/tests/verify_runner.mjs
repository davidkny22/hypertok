import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function plan(...args) {
  return JSON.parse(
    execFileSync(process.execPath, ["run.mjs", ...args, "--list"], {
      cwd: benchesDirectory,
      encoding: "utf8",
    }),
  );
}

const tests = plan("test");
assert.equal(tests.command, "test");
assert.ok(tests.files.includes("tests/verify_public_contracts.mjs"));
assert.ok(tests.files.includes("tests/verify_agreement_cross_env.mjs"));

const smoke = plan("benchmark", "--profile", "arena", "--mode", "smoke");
assert.equal(smoke.profile, "arena");
assert.equal(smoke.mode, "smoke");
assert.ok(
  smoke.files.indexOf("tests/verify_agreement_cross_env.mjs") <
    smoke.files.indexOf("measure_node_throughput.mjs"),
);
for (const file of ["measure_node_load.mjs", "measure_browser_load.mjs"]) {
  assert.ok(smoke.files.includes(file));
}

const shipping = plan("benchmark", "--profile", "shipping", "--mode", "smoke");
assert.equal(shipping.profile, "shipping");
assert.equal(shipping.mode, "smoke");
for (const file of ["script-measurement/run.mjs", "measure_shim_overhead.mjs"]) {
  assert.ok(shipping.files.includes(file));
}

const invalid = spawnSync(
  process.execPath,
  ["run.mjs", "benchmark", "--mode", "unknown", "--list"],
  { cwd: benchesDirectory, encoding: "utf8" },
);
assert.notEqual(invalid.status, 0);
assert.match(invalid.stderr, /Unknown benchmark mode/);

const environmentWithoutSource = { ...process.env };
delete environmentWithoutSource.HYPERTOK_SOURCE_RANKS;
const missingSource = spawnSync(
  process.execPath,
  ["run.mjs", "benchmark", "--profile", "shipping", "--mode", "smoke"],
  { cwd: benchesDirectory, encoding: "utf8", env: environmentWithoutSource },
);
assert.notEqual(missingSource.status, 0);
assert.match(missingSource.stderr, /requires --source-ranks/);

console.log("public runner plan PASS (test and smoke ordering)");
console.log("shipping runner plan PASS (decomposition and shim overhead)");
console.log("unknown mode mutation RED");
console.log("missing source-ranks mutation RED");
