import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { axisNames } from "../common/timing.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultDirectory = path.resolve(benchesDirectory, "..", "results", "harness");
const nodeResult = JSON.parse(fs.readFileSync(path.join(resultDirectory, "node-self-check.json")));
const browserResult = JSON.parse(fs.readFileSync(path.join(resultDirectory, "browser-self-check.json")));

assert.equal(nodeResult.commit, browserResult.commit);
assert.deepEqual(nodeResult.exactStatistics, browserResult.exactStatistics);
assert.deepEqual(nodeResult.mutations, browserResult.mutations);
for (const name of axisNames) {
  assert.deepEqual(nodeResult.axes[name], browserResult.axes[name]);
}

console.log("cross-environment self-check PASS (statistics, 4 axes, and 2 mutations)");
