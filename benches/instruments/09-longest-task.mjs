#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
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

async function nodeLoadChild(payload) {
  const histogram = monitorEventLoopDelay({ resolution: payload.resolutionMs });
  histogram.enable();
  await new Promise((resolve) => setImmediate(resolve));
  const module = await importPublic(payload.package);
  const runtime = await module.fromBytes(fs.readFileSync(payload.vocab), { tier: "single" });
  await new Promise((resolve) => setImmediate(resolve));
  histogram.disable();
  const maximumMs = histogram.max / 1e6;
  const properties = { vocabSize: runtime.vocabSize, structuralClass: runtime.structuralClass };
  runtime.free();
  return { maximumMs, properties };
}

const childArgument = process.argv.find((argument) => argument.startsWith("--node-load-child="));
if (childArgument) {
  try {
    const payload = JSON.parse(Buffer.from(childArgument.slice(18), "base64url").toString("utf8"));
    process.stdout.write(`${JSON.stringify(await nodeLoadChild(payload))}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
} else {
  const parameters = parseArgs(process.argv.slice(2));
  const runtimeName = String(parameters.runtime ?? "node");
  const leg = String(parameters.leg ?? "load");
  const tier = String(parameters.tier ?? "single");
  const entry = String(parameters.entry ?? "encode");
  const size = Number(parameters.size ?? 1048576);
  const minimum = Number(parameters.minimum ?? 5);
  const maximum = Number(parameters.maximum ?? 128);
  const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
  const resolutionMs = Number(parameters["event-loop-resolution-ms"] ?? 1);
  const assumptions = [
    "The load leg registers its observer before module import and covers import through public fromBytes construction.",
    "The call leg observes one public call at the stated input size and tier after construction and one warm call.",
    "Browser cells book the longest PerformanceLongTaskTiming duration, not the summed span; the API floor is 50 ms.",
    "Node cells book monitorEventLoopDelay maximum over the same load span and label it as the Node reading.",
    "Every load sample uses a fresh Node process or fresh browser process.",
    "Median absolute deviation is the noise estimator because the governing documents do not name one.",
  ];
  const limits = [
    "Single-tier call cells are derived from per-call overhead and throughput and are never measured here.",
    "Browser call cells exist only where the public path can yield.",
    "A browser call with no long-task entry is booked as under-50 unresolved, with performance.now bracketing supplied only for a synchronous span.",
    "Sampling starts at five, escalates to at most 128, stops when noise no longer shrinks, and observes a ten-minute backstop.",
  ];

  function adaptiveSync(makeSample) {
    const samples = [];
    const started = performance.now();
    let target = minimum;
    let previousBand = null;
    let stop = "maximum-samples";
    while (samples.length < target) samples.push(makeSample());
    while (samples.length < maximum) {
      const band = summarize(samples.map((sample) => sample.maximumMs)).mad;
      if (previousBand !== null && band >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
      if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
      previousBand = band;
      target = Math.min(maximum, samples.length * 2 + 1);
      while (samples.length < target && performance.now() - started < backstopMs) samples.push(makeSample());
    }
    return { samples, stop, elapsedMs: performance.now() - started };
  }

  async function adaptiveAsync(makeSample) {
    const samples = [];
    const started = performance.now();
    let target = minimum;
    let previousBand = null;
    let stop = "maximum-samples";
    while (samples.length < target) samples.push(await makeSample());
    while (samples.length < maximum) {
      const band = summarize(samples.map((sample) => sample.maximumMs)).mad;
      if (previousBand !== null && band >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
      if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
      previousBand = band;
      target = Math.min(maximum, samples.length * 2 + 1);
      while (samples.length < target && performance.now() - started < backstopMs) samples.push(await makeSample());
    }
    return { samples, stop, elapsedMs: performance.now() - started };
  }

  function browserServer() {
    const packageRoot = path.resolve(String(parameters["package-root"] ?? "node_modules/hypertok"));
    const vocabulary = fs.readFileSync(path.resolve(String(parameters.vocab)));
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const exported = packageJson.exports["."];
    const packageEntry = (typeof exported === "string" ? exported : exported.import ?? exported.default).replace(/^\.\//, "");
    const isolated = tier === "shared";
    const server = http.createServer((request, response) => {
      if (isolated) {
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      }
      if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>instrument</title>"); return; }
      if (request.url === "/vocab") { response.setHeader("Content-Type", "application/octet-stream"); response.end(vocabulary); return; }
      const relative = decodeURIComponent((request.url ?? "").replace(/^\/package\//, ""));
      const file = path.resolve(packageRoot, relative);
      if (!file.startsWith(`${packageRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.statusCode = 404; response.end(); return; }
      response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".json") ? "application/json" : "text/javascript");
      response.end(fs.readFileSync(file));
    });
    return { server, packageEntry, isolated };
  }

  async function launchBrowser() {
    const { chromium } = await import("playwright-core");
    const candidates = [parameters.chrome, process.env.HYPERTOK_CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((candidate) => candidate && fs.existsSync(candidate));
    if (candidates.length === 0) throw new Error("Chrome executable not found");
    return chromium.launch({ executablePath: candidates[0], headless: true });
  }

  async function browserLoadSample() {
    const hosted = browserServer();
    await new Promise((resolve) => hosted.server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${hosted.server.address().port}`;
      await page.goto(origin);
      return await page.evaluate(async ({ entryUrl }) => {
        const entries = [];
        const observer = new PerformanceObserver((list) => entries.push(...list.getEntries().map((item) => item.duration)));
        observer.observe({ type: "longtask", buffered: true });
        const begin = performance.now();
        const module = await import(entryUrl);
        const bytes = new Uint8Array(await (await fetch("/vocab")).arrayBuffer());
        const runtime = await module.fromBytes(bytes, { tier: "single" });
        const spanMs = performance.now() - begin;
        await new Promise((resolve) => setTimeout(resolve, 0));
        observer.disconnect();
        runtime.free();
        return { maximumMs: entries.length ? Math.max(...entries) : 0, spanMs, under50: entries.length === 0 };
      }, { entryUrl: `${origin}/package/${hosted.packageEntry}` });
    } finally {
      await browser?.close();
      await new Promise((resolve) => hosted.server.close(resolve));
    }
  }

  async function browserCallSamples() {
    const hosted = browserServer();
    await new Promise((resolve) => hosted.server.listen(0, "127.0.0.1", resolve));
    const browser = await launchBrowser();
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${hosted.server.address().port}`;
    await page.goto(origin);
    await page.evaluate(async ({ entryUrl, tierValue, workers, sizeValue, entryValue }) => {
      const module = await import(entryUrl);
      const bytes = new Uint8Array(await (await fetch("/vocab")).arrayBuffer());
      const runtime = await module.fromBytes(bytes, { tier: tierValue, workers });
      const text = "a".repeat(sizeValue);
      const ids = new Uint32Array(sizeValue).fill(runtime.encodeSync("a")[0] ?? 0);
      const call = async () => entryValue === "decode" ? runtime.decode(ids) : runtime.encode(text);
      await call();
      globalThis.__longTaskInstrument = { runtime, call };
    }, { entryUrl: `${origin}/package/${hosted.packageEntry}`, tierValue: tier, workers: Number(parameters.workers ?? 1), sizeValue: size, entryValue: entry });
    try {
      return await adaptiveAsync(() => page.evaluate(async () => {
        const entries = [];
        const observer = new PerformanceObserver((list) => entries.push(...list.getEntries().map((item) => item.duration)));
        observer.observe({ type: "longtask", buffered: false });
        const begin = performance.now();
        const output = await globalThis.__longTaskInstrument.call();
        const spanMs = performance.now() - begin;
        await new Promise((resolve) => setTimeout(resolve, 0));
        observer.disconnect();
        return { maximumMs: entries.length ? Math.max(...entries) : 0, spanMs, under50: entries.length === 0, checksum: output.length };
      }));
    } finally {
      await page.evaluate(() => globalThis.__longTaskInstrument.runtime.free());
      await browser.close();
      await new Promise((resolve) => hosted.server.close(resolve));
    }
  }

  const cells = [];
  if (parameters.smoke) {
    cells.push({ id: "smoke", status: "not-booked", parameters: { runtime: runtimeName, leg, tier, entry, size }, result: null, noise: null });
  } else if (leg === "call" && tier === "single") {
    cells.push({ id: `${runtimeName}-single-call`, status: "derived", parameters: { runtime: runtimeName, tier, entry, size }, result: null, noise: null, blocked: { reason: "single-tier-call-is-derived", needed: "Compose axis 4 intercept and axis 1 throughput." } });
  } else if (runtimeName === "node" && leg === "call") {
    cells.push({ id: `node-${tier}-call`, status: "blocked", parameters: { runtime: runtimeName, tier, entry, size }, result: null, noise: null, blocked: { reason: "public-tier-unreachable", needed: "A Node public path that can yield on the requested tier." } });
  } else {
    if (!parameters.vocab) throw new Error("--vocab=<path> is required");
    let adaptive;
    if (runtimeName === "node") {
      adaptive = adaptiveSync(() => {
        const payload = Buffer.from(JSON.stringify({ package: String(parameters.package ?? "hypertok"), vocab: path.resolve(String(parameters.vocab)), resolutionMs })).toString("base64url");
        const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--node-load-child=${payload}`], { encoding: "utf8", windowsHide: true });
        if (run.status !== 0) throw new Error(run.stderr || run.stdout);
        return JSON.parse(run.stdout);
      });
    } else if (leg === "load") adaptive = await adaptiveAsync(browserLoadSample);
    else adaptive = await browserCallSamples();
    const under50 = adaptive.samples.every((sample) => sample.under50 || sample.maximumMs < 50);
    cells.push({
      id: `${runtimeName}-${leg}-${tier}`,
      status: under50 && runtimeName === "browser" ? "under-50-unresolved" : (adaptive.stop === "maximum-samples" ? "unresolved" : "measured"),
      parameters: { runtime: runtimeName, leg, tier, entry: leg === "call" ? entry : null, size: leg === "call" ? size : null, eventLoopResolutionMs: runtimeName === "node" ? resolutionMs : null },
      result: {
        longestBlock: measured(adaptive.samples.map((sample) => sample.maximumMs), "ms"),
        bracketedSpan: adaptive.samples.every((sample) => Number.isFinite(sample.spanMs)) ? measured(adaptive.samples.map((sample) => sample.spanMs), "ms") : null,
      },
      sampling: { initial: minimum, reached: adaptive.samples.length, maximum, stop: adaptive.stop, elapsedMs: adaptive.elapsedMs },
    });
  }
  for (const cell of cells) { cell.assumptions = assumptions; cell.limits = limits; }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, instrument: 9, subject: "longest task", axes: [14], mode: parameters.smoke ? "smoke" : "measure", parameters: { ...parameters, runtime: runtimeName, leg, tier, entry, size, minimum, maximum, backstopMs, resolutionMs }, cells, assumptions, limits }, null, 2)}\n`);
}
