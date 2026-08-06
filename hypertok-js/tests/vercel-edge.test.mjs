import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(directory);
const repository = path.dirname(packageRoot);
const fixture = path.join(directory, "vercel");
const buildDirectory = path.join(fixture, ".next");
const publicDirectory = path.join(fixture, "public");
const vocabularyTarget = path.join(publicDirectory, "vocab.htk");
const vocabularySource = path.join(repository, "hypertok-vocab", "gpt2", "vocab.htk");
const nextBin = path.join(packageRoot, "node_modules", "next", "dist", "bin", "next");
const probeText = "vercel edge round trip \u{1F469}\u{1F3FD}\u200D\u{1F4BB}";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(url, process, output) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Next.js exited before serving the edge route\n${output()}`);
    }
    try {
      return await fetch(url);
    } catch (error) {
      // The production server has not opened its socket yet.
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js startup timed out: ${lastError?.message}\n${output()}`);
}

test("initializes and round trips in the real Next.js edge runtime", { timeout: 180_000 }, async () => {
  mkdirSync(publicDirectory, { recursive: true });
  copyFileSync(vocabularySource, vocabularyTarget);
  const environment = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
  };
  let child;
  try {
    const build = spawnSync(process.execPath, [nextBin, "build", fixture, "--turbopack"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: environment,
      timeout: 150_000,
    });
    assert.equal(
      build.status,
      0,
      [build.error?.message, build.stdout, build.stderr].filter(Boolean).join("\n"),
    );

    const port = await availablePort();
    const url = `http://127.0.0.1:${port}/api/round-trip`;
    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, [nextBin, "start", fixture, "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: packageRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const response = await waitForServer(url, child, () => `${stdout}\n${stderr}`);
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const result = JSON.parse(body);
    assert.equal(result.ok, true, body);
    assert.equal(result.tier, "single", body);
    assert.equal(result.decoded, probeText, body);
    assert.deepEqual(
      result.ids,
      [332, 5276, 5743, 2835, 5296, 50169, 102, 8582, 237, 121, 447, 235, 8582, 240, 119],
      body,
    );
    console.log(
      `vercel edge-light status=${response.status} tier=${result.tier} ids=${result.ids.join(",")}`,
    );
  } finally {
    if (child?.exitCode === null) child.kill();
    rmSync(buildDirectory, { recursive: true, force: true });
    rmSync(vocabularyTarget, { force: true });
  }
});
