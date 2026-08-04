import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
const allowedSurfaces = new Set([
  "browser-fault-fixture",
  "compile-contract",
  "generated-artifact",
  "owned-memory",
  "test-mode",
]);

assert.equal(manifest.schemaVersion, 1);
assert.ok(Array.isArray(manifest.entries));
const ids = manifest.entries.map(({ id }) => id);
assert.equal(new Set(ids).size, ids.length, "fault ids must be unique");

let prescribed = 0;
let faults = 0;
const rows = [];
for (const entry of manifest.entries) {
  assert.match(entry.id, /^[a-z0-9-]+$/);
  assert.equal(typeof entry.invariant, "string");
  assert.ok(entry.invariant.length > 0);
  assert.ok(allowedSurfaces.has(entry.surface), `${entry.id} uses unsupported surface ${entry.surface}`);
  assert.ok(entry.expected === "pass" || entry.expected === "fail");
  assert.ok(Number.isInteger(entry.faults) && entry.faults >= 0);
  assert.equal(typeof entry.executable, "string");
  assert.ok(Array.isArray(entry.arguments));
  assert.ok(entry.arguments.every((argument) => typeof argument === "string"));
  assert.ok(entry.environment === undefined || Object.values(entry.environment).every((value) => typeof value === "string"));

  process.stdout.write(`> [${entry.id}] ${entry.executable} ${entry.arguments.join(" ")}\n`);
  const result = spawnSync(entry.executable, entry.arguments, {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, ...entry.environment },
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  const passed = result.status === 0;
  assert.equal(passed, entry.expected === "pass", `${entry.id} did not ${entry.expected}`);
  if (entry.match !== undefined) {
    assert.ok(output.includes(entry.match), `${entry.id} did not report ${entry.match}`);
  }
  faults += entry.faults;
  prescribed += entry.prescribed === true ? entry.faults : 0;
  rows.push({
    id: entry.id,
    invariant: entry.invariant,
    surface: entry.surface,
    expected: entry.expected,
    observed: passed ? "PASS" : "RED",
    faults: entry.faults,
  });
}

const git = spawnSync(
  "git",
  ["-c", `safe.directory=${repository.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
  { cwd: repository, encoding: "utf8", windowsHide: true },
);
assert.equal(git.status, 0, git.stderr);
const report = {
  schemaVersion: 1,
  commit: git.stdout.trim(),
  entries: rows.length,
  faults,
  prescribed,
  trackedSourceWrites: 0,
  rows,
};
const outputDirectory = path.join(repository, "results", "mutations");
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ pass: true, ...report })}\n`);
