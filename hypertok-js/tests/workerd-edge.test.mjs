import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(directory, "workerd", "run-case.mjs");

for (const mode of ["standard", "nodejs_compat"]) {
  test(`initializes and round trips in real workerd (${mode})`, () => {
    const result = spawnSync(process.execPath, [runner, mode], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 30_000,
    });
    assert.equal(
      result.status,
      0,
      [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
    assert.match(result.stdout, new RegExp(`workerd mode=${mode} status=200 tier=single`));
  });
}
