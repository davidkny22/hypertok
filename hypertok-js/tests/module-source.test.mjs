import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(packageRoot, "..");
const probe = path.join(packageRoot, "tests", "module-source-probe.mjs");
const wasm = path.join(packageRoot, "wasm", "single", "hypertok_wasm_core_bg.wasm");
const vocabulary = path.join(repository, "hypertok-vocab", "gpt2", "vocab.htk");

for (const mode of ["bytes", "module"]) {
  test(`loads from caller-supplied wasm ${mode}`, () => {
    const result = spawnSync(process.execPath, [probe, mode, wasm, vocabulary], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
