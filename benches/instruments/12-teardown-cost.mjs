#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator === -1 ? undefined : separator);
    values[key] = separator === -1 ? true : argument.slice(separator + 1);
  }
  return values;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(values) {
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  const sorted = [...values].sort((left, right) => left - right);
  return { sampleCount: values.length, median: center, p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)], mad, relativeMad: center === 0 ? null : mad / Math.abs(center) };
}

function measured(values, unit) {
  const noise = summarize(values);
  return { value: noise.median, unit, noise };
}

async function importPublic(specifier) {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) return import(pathToFileURL(path.resolve(specifier)).href);
  return import(specifier);
}

async function nodeChild(payload) {
  const module = await importPublic(payload.package);
  const runtime = await module.fromBytes(fs.readFileSync(payload.vocab), { tier: "single" });
  await runtime.encode("teardown warm call");
  const begin = performance.now();
  runtime.free();
  return { returnMs: performance.now() - begin };
}

const childArgument = process.argv.find((argument) => argument.startsWith("--child="));
if (childArgument) {
  try {
    const payload = JSON.parse(Buffer.from(childArgument.slice(8), "base64url").toString("utf8"));
    process.stdout.write(`${JSON.stringify(await nodeChild(payload))}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
} else {
  const parameters = parseArgs(process.argv.slice(2));
  const runtimeName = String(parameters.runtime ?? "node");
  const tier = String(parameters.tier ?? "single");
  const workers = Number(parameters.workers ?? 1);
  const minimum = Number(parameters.minimum ?? 5);
  const maximum = Number(parameters.maximum ?? 128);
  const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
  const assumptions = [
    "Each sample starts in a fresh process, constructs at the stated tier and worker count through public fromBytes, and warms with one public call.",
    "The return leg times one public free call from entry until it returns.",
    "On the worker tier the synchronous return prefix includes W Worker.terminate calls; on the single tier it books call-return overhead only.",
    "Median absolute deviation is the noise estimator because the governing documents do not name one.",
  ];
  const limits = [
    "Worker and shared quiescence are blocked because the browser exposes neither qualified process RSS nor thread-count settling.",
    "Single-tier quiescence is blocked because no thread exists and wasm memory never shrinks.",
    "Return and quiescence remain separate readings; a missing quiescence seam never substitutes a delay after free.",
    "Sampling starts at five, escalates to at most 128, stops when noise no longer shrinks, and observes a ten-minute backstop.",
  ];

  async function browserSample() {
    const packageRoot = path.resolve(String(parameters["package-root"] ?? "node_modules/hypertok"));
    const vocabulary = fs.readFileSync(path.resolve(String(parameters.vocab)));
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const exported = packageJson.exports["."];
    const packageEntry = (typeof exported === "string" ? exported : exported.import ?? exported.default).replace(/^\.\//, "");
    const isolated = tier === "shared";
    const server = http.createServer((request, response) => {
      if (isolated) { response.setHeader("Cross-Origin-Opener-Policy", "same-origin"); response.setHeader("Cross-Origin-Embedder-Policy", "require-corp"); }
      if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>instrument</title>"); return; }
      if (request.url === "/vocab") { response.setHeader("Content-Type", "application/octet-stream"); response.end(vocabulary); return; }
      const relative = decodeURIComponent((request.url ?? "").replace(/^\/package\//, ""));
      const file = path.resolve(packageRoot, relative);
      if (!file.startsWith(`${packageRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.statusCode = 404; response.end(); return; }
      response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".json") ? "application/json" : "text/javascript");
      response.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
      const { chromium } = await import("playwright-core");
      const candidates = [parameters.chrome, process.env.HYPERTOK_CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((candidate) => candidate && fs.existsSync(candidate));
      if (candidates.length === 0) throw new Error("Chrome executable not found");
      browser = await chromium.launch({ executablePath: candidates[0], headless: true });
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.goto(origin);
      return await page.evaluate(async ({ entryUrl, tierValue, workerCount }) => {
        const module = await import(entryUrl);
        const bytes = new Uint8Array(await (await fetch("/vocab")).arrayBuffer());
        const runtime = await module.fromBytes(bytes, { tier: tierValue, workers: workerCount });
        await runtime.encode("teardown warm call");
        const begin = performance.now();
        runtime.free();
        return { returnMs: performance.now() - begin };
      }, { entryUrl: `${origin}/package/${packageEntry}`, tierValue: tier, workerCount: workers });
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function nodeSample() {
    const payload = Buffer.from(JSON.stringify({ package: String(parameters.package ?? "hypertok"), vocab: path.resolve(String(parameters.vocab)) })).toString("base64url");
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--child=${payload}`], { encoding: "utf8", windowsHide: true });
    if (run.status !== 0) throw new Error(run.stderr || run.stdout);
    return JSON.parse(run.stdout);
  }

  const cells = [];
  if (parameters.smoke) {
    cells.push({ id: "smoke", status: "not-booked", parameters: { runtime: runtimeName, tier, workers }, result: null, noise: null });
  } else {
    if (!parameters.vocab) throw new Error("--vocab=<path> is required");
    if (runtimeName === "node" && tier !== "single") {
      cells.push({ id: `${runtimeName}-${tier}-return`, status: "blocked", parameters: { runtime: runtimeName, tier, workers }, result: null, noise: null, blocked: { reason: "public-tier-unreachable", needed: "A browser host for worker or shared tier construction." } });
    } else {
      const samples = [];
      const started = performance.now();
      let target = minimum;
      let previousBand = null;
      let stop = "maximum-samples";
      while (samples.length < target) samples.push(runtimeName === "browser" ? await browserSample() : nodeSample());
      while (samples.length < maximum) {
        const band = summarize(samples.map((sample) => sample.returnMs)).mad;
        if (previousBand !== null && band >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
        if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
        previousBand = band;
        target = Math.min(maximum, samples.length * 2 + 1);
        while (samples.length < target && performance.now() - started < backstopMs) samples.push(runtimeName === "browser" ? await browserSample() : nodeSample());
      }
      cells.push({
        id: `${runtimeName}-${tier}-return`,
        status: stop === "maximum-samples" ? "unresolved" : "measured",
        parameters: { runtime: runtimeName, tier, workers },
        result: { returnLeg: measured(samples.map((sample) => sample.returnMs), "ms") },
        sampling: { initial: minimum, reached: samples.length, maximum, stop, elapsedMs: performance.now() - started },
      });
    }
    cells.push({
      id: `${runtimeName}-${tier}-quiescence`,
      status: "blocked",
      parameters: { runtime: runtimeName, tier, workers },
      result: null,
      noise: null,
      blocked: tier === "single"
        ? { reason: "no-observable-quiescence-transition", needed: "None currently exists: no thread terminates and wasm memory never shrinks." }
        : { reason: "browser-quiescence-seam-unqualified", needed: "Qualified browser RSS and thread-count settling observations." },
    });
  }
  for (const cell of cells) { cell.assumptions = assumptions; cell.limits = limits; }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, instrument: 12, subject: "teardown cost", axes: [19], mode: parameters.smoke ? "smoke" : "measure", parameters: { ...parameters, runtime: runtimeName, tier, workers, minimum, maximum, backstopMs }, cells, assumptions, limits }, null, 2)}\n`);
}
