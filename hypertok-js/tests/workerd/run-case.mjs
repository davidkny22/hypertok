import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const directory = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
if (mode !== "standard" && mode !== "nodejs_compat") {
  throw new Error("mode must be standard or nodejs_compat");
}

const startupTimeout = setTimeout(() => {
  console.error(`workerd ${mode} startup timed out`);
  process.exit(1);
}, 20_000);

let worker;
try {
  worker = await unstable_dev(path.join(directory, "worker.mjs"), {
    config: path.join(directory, "wrangler.jsonc"),
    compatibilityFlags: mode === "nodejs_compat" ? ["nodejs_compat"] : [],
    local: true,
    logLevel: "error",
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      showInteractiveDevSession: false,
      watch: false,
    },
  });
  clearTimeout(startupTimeout);
  const response = await worker.fetch("http://hypertok.test/");
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const result = JSON.parse(body);
  assert.equal(result.ok, true, body);
  assert.equal(result.tier, "single", body);
  assert.equal(result.decoded, "workerd edge round trip \u{1F469}\u{1F3FD}\u200D\u{1F4BB}", body);
  assert.deepEqual(
    result.ids,
    [28816, 67, 5743, 2835, 5296, 50169, 102, 8582, 237, 121, 447, 235, 8582, 240, 119],
    body,
  );
  console.log(
    `workerd mode=${mode} status=${response.status} tier=${result.tier} ids=${result.ids.join(",")}`,
  );
} finally {
  clearTimeout(startupTimeout);
  await worker?.stop();
}
