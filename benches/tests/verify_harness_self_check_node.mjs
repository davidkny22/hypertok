import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { axisNames } from "../common/timing.mjs";
import { runHarnessSelfCheck } from "../common/harness_self_check.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const resultPath = path.join(repositoryDirectory, "results", "harness", "node-self-check.json");
const result = await runHarnessSelfCheck();

assert.deepEqual(Object.keys(result.axes), axisNames);
assert.deepEqual(result.mutations, { backwardClock: "RED", crossAxisLabel: "RED" });
assert.ok(result.injectedDelay.median >= result.noOp.median + 1);

const commit = execFileSync(
  "git",
  ["-c", `safe.directory=${repositoryDirectory.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
  { cwd: repositoryDirectory, encoding: "utf8" },
).trim();
fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(
  resultPath,
  `${JSON.stringify({ schemaVersion: 1, environment: "node", nodeVersion: process.version, commit, ...result }, null, 2)}\n`,
);

console.log(
  `Node timer PASS (no-op median=${result.noOp.median.toFixed(6)} ms; injected median=${result.injectedDelay.median.toFixed(6)} ms)`,
);
console.log("Node axes PASS (transfer=1, decompression=2, materialisation=3, encode=4 ms)");
console.log("Node mutations RED (2/2)");
