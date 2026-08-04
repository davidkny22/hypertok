import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchHarnessBrowser, observeRequests } from "./browser/control.mjs";
import { measureDecodeArtifactPair } from "./common/decode_artifact_pricing.mjs";
import { loadCorpus } from "./common/corpus.mjs";
import { buildBenchmarkHtk } from "./common/gpt2_htk.mjs";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const outputDirectory = path.join(repositoryDirectory, "results", "decode-direct-gather");
const packageSource = path.join(repositoryDirectory, "hypertok-js", "src");
const baseFeatures = [
  "portable-json",
  "wasm-binding",
  "htk",
  "sentencepiece-core",
  "opt-marshalling",
  "opt-chunk-prescan",
  "opt-scan-two-phase",
  "opt-level-select",
  "opt-cold-diet",
  "opt-fused-pair-ranks",
  "opt-compact-ranks",
  "opt-decode-assembly",
];

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${arguments_.join(" ")} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout.trim();
}

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function buildPackage(name, extraFeatures = []) {
  const root = path.join(outputDirectory, name);
  const target = path.join(root, "target");
  const binding = path.join(root, "binding");
  const packageDirectory = path.join(root, "package");
  fs.mkdirSync(binding, { recursive: true });
  fs.mkdirSync(path.join(packageDirectory, "wasm", "single"), { recursive: true });
  run("cargo", [
    "+stable-x86_64-pc-windows-msvc",
    "build",
    "--locked",
    "--offline",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--no-default-features",
    "--features",
    [...baseFeatures, ...extraFeatures].join(","),
    "--target-dir",
    target,
  ], {
    env: { ...process.env, RUSTFLAGS: "-C target-feature=+simd128" },
  });
  const wasm = path.join(target, "wasm32-unknown-unknown", "release", "hypertok.wasm");
  run("wasm-bindgen", [
    wasm,
    "--out-dir",
    binding,
    "--target",
    "web",
    "--no-typescript",
    "--out-name",
    "hypertok_wasm_core",
  ]);
  fs.cpSync(packageSource, path.join(packageDirectory, "src"), {
    recursive: true,
    force: true,
  });
  fs.cpSync(binding, path.join(packageDirectory, "wasm", "single"), {
    recursive: true,
    force: true,
  });
  const boundWasm = path.join(
    packageDirectory,
    "wasm",
    "single",
    "hypertok_wasm_core_bg.wasm",
  );
  return Object.freeze({
    name,
    directory: packageDirectory,
    features: Object.freeze([...baseFeatures, ...extraFeatures]),
    wasmSha256: digest(boundWasm),
    wasmBytes: fs.statSync(boundWasm).size,
  });
}

async function loadPublicRuntime(artifact, htk) {
  const entry = path.join(artifact.directory, "src", "index.mjs");
  const { fromBytes } = await import(`${pathToFileURL(entry).href}?artifact=${artifact.name}`);
  return fromBytes(htk, { tier: "single" });
}

function contentType(filePath) {
  if (filePath.endsWith(".mjs") || filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function resolvedChild(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error("request path escapes its served root");
  return target;
}

async function startServer({ baseline, candidate, htk }) {
  const roots = new Map([
    ["baseline", baseline.directory],
    ["candidate", candidate.directory],
    ["common", path.join(benchesDirectory, "common")],
  ]);
  const page = Buffer.from("<!doctype html><meta charset=\"utf-8\"><title>decode gather</title>");
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      let body;
      let type;
      if (url.pathname === "/") {
        body = page;
        type = "text/html; charset=utf-8";
      } else if (url.pathname === "/gpt2.htk") {
        body = htk;
        type = "application/octet-stream";
      } else {
        const [, rootName, ...parts] = url.pathname.split("/");
        const root = roots.get(rootName);
        if (root === undefined || parts.length === 0) {
          response.writeHead(404).end();
          return;
        }
        const filePath = resolvedChild(root, parts.join("/"));
        body = fs.readFileSync(filePath);
        type = contentType(filePath);
      }
      response.writeHead(200, {
        "Content-Type": type,
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))),
  });
}

fs.mkdirSync(outputDirectory, { recursive: true });
const baselineArtifact = buildPackage("baseline");
const candidateArtifact = buildPackage("candidate", ["opt-decode-direct-gather"]);
const htk = buildBenchmarkHtk();
const workloads = loadCorpus();
const baseline = await loadPublicRuntime(baselineArtifact, htk.bytes);
const candidate = await loadPublicRuntime(candidateArtifact, htk.bytes);
let node;
try {
  node = measureDecodeArtifactPair({ baseline, candidate, workloads, n: 21, warmup: 2 });
} finally {
  baseline.free();
  candidate.free();
}

const server = await startServer({
  baseline: baselineArtifact,
  candidate: candidateArtifact,
  htk: htk.bytes,
});
const { browser, browserVersion, executablePath } = await launchHarnessBrowser();
let chrome;
let requestProof;
try {
  const page = await browser.newPage();
  const requests = observeRequests(page);
  await page.goto(server.origin, { waitUntil: "load" });
  chrome = await page.evaluate(async (inputWorkloads) => {
    const [{ fromBytes: fromBaseline }, { fromBytes: fromCandidate }, pricing, response] =
      await Promise.all([
        import("/baseline/src/index.mjs"),
        import("/candidate/src/index.mjs"),
        import("/common/decode_artifact_pricing.mjs"),
        fetch("/gpt2.htk"),
      ]);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const baselineRuntime = await fromBaseline(bytes, { tier: "single" });
    const candidateRuntime = await fromCandidate(bytes, { tier: "single" });
    try {
      return {
        crossOriginIsolated: globalThis.crossOriginIsolated,
        ...pricing.measureDecodeArtifactPair({
          baseline: baselineRuntime,
          candidate: candidateRuntime,
          workloads: inputWorkloads,
          n: 21,
          warmup: 2,
        }),
      };
    } finally {
      baselineRuntime.free();
      candidateRuntime.free();
    }
  }, workloads);
  requestProof = requests.assertLocal(server.origin);
  await page.close();
} finally {
  await browser.close();
  await server.close();
}

const report = Object.freeze({
  schemaVersion: 1,
  commit: run("git", ["-c", `safe.directory=${repositoryDirectory.replaceAll("\\", "/")}`, "rev-parse", "HEAD"]),
  method: "same-session alternating public fromBytes artifact pair",
  htkSha256: htk.sha256,
  baselineArtifact,
  candidateArtifact,
  node: Object.freeze({ runtime: process.version, ...node }),
  chrome: Object.freeze({ browserVersion, executablePath, requestProof, ...chrome }),
});
const outputPath = path.join(outputDirectory, "pricing.json");
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
