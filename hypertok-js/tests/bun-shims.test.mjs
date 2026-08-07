import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(directory);
const repository = path.dirname(packageRoot);
const runner = path.join(directory, "bun", "shim-case.mjs");
const vocabulary = path.join(repository, "hypertok-vocab", "gpt2", "vocab.htk");
const bun = path.join(packageRoot, "node_modules", "bun", "bin", "bun.exe");
const expectedError = "the tiktoken shim requires a resident single-tier runtime";
const expectedHuggingFaceError = "the Hugging Face shim requires a resident single-tier runtime";

function run(moduleRoot) {
  const args = moduleRoot === undefined
    ? [runner, "--package", vocabulary]
    : [runner, moduleRoot, vocabulary];
  const result = spawnSync(bun, args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 60_000,
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const report = lines.length === 0 ? undefined : JSON.parse(lines.at(-1));
  return { ...result, report };
}

test("real Bun auto tier reaches both synchronous shims through one resident view", () => {
  const result = run();
  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  assert.equal(result.report.bun, "1.3.13");
  assert.equal(result.report.publicTier, "worker");
  assert.match(result.report.publicEncodeSyncError, /worker tier/);
  assert.equal(result.report.resolvedTier, "single");
  assert.equal(result.report.singleLoads, 1);
  assert.equal(result.report.residentSingleIdentity, 1);
  assert.equal(result.report.fetchCalls, 0);
  assert.equal(result.report.tiktoken.ok, true);
  assert.equal(result.report.huggingFace.ok, true);
  assert.deepEqual(result.report.tiktoken.ids, result.report.expected);
  assert.deepEqual(result.report.huggingFace.ids, result.report.expected);
  assert.equal(result.report.sameSessionClosed, true);
  console.log("bun resident shims GREEN=2/2");
});

test("registration mutation reproduces the original error for both shims", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "hypertok-bun-registration-"));
  try {
    cpSync(path.join(packageRoot, "src"), path.join(temporary, "src"), { recursive: true });
    cpSync(path.join(packageRoot, "wasm"), path.join(temporary, "wasm"), { recursive: true });
    const indexPath = path.join(temporary, "src", "index.mjs");
    const source = readFileSync(indexPath, "utf8");
    const fixed = "return registerShimRuntime(handle, resolveShimRuntime(runtime));";
    const mutated = "return registerShimRuntime(handle, runtime);";
    assert.equal(source.split(fixed).length - 1, 1, "registration seam must have one mutation site");
    writeFileSync(indexPath, source.replace(fixed, mutated));

    const result = run(temporary);
    assert.equal(
      result.status,
      23,
      [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
    assert.equal(result.report.publicTier, "worker");
    assert.equal(result.report.tiktoken.ok, false);
    assert.equal(result.report.tiktoken.message, expectedError);
    assert.equal(result.report.huggingFace.ok, false);
    assert.equal(result.report.huggingFace.message, expectedHuggingFaceError);
    console.log("bun registration mutation RED=2/2");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
