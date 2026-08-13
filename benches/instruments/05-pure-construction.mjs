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
    const value = separator === -1 ? true : argument.slice(separator + 1);
    values[key] = value;
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
  return {
    sampleCount: values.length,
    median: center,
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    mad,
    relativeMad: center === 0 ? null : mad / Math.abs(center),
  };
}

function measured(values, unit) {
  const noise = summarize(values);
  return { value: noise.median, unit, noise };
}

async function importPublic(specifier) {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return import(pathToFileURL(path.resolve(specifier)).href);
  }
  return import(specifier);
}

async function nodeChild(payload) {
  const module = await importPublic(payload.package);
  const bytes = fs.readFileSync(payload.vocab);
  const primeBegin = performance.now();
  const prime = await module.fromBytes(bytes, { tier: "single" });
  const primeMs = performance.now() - primeBegin;
  prime.free();
  const targetBegin = performance.now();
  const target = await module.fromBytes(bytes, { tier: "single" });
  const targetMs = performance.now() - targetBegin;
  const properties = {
    vocabSize: target.vocabSize,
    structuralClass: target.structuralClass,
    formatVersion: target.formatVersion,
  };
  target.free();
  return { primeMs, targetMs, properties, byteLength: bytes.length };
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
  const minimum = Number(parameters.minimum ?? 5);
  const maximum = Number(parameters.maximum ?? 128);
  const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
  const format = String(parameters.format ?? "htk");
  const runtimeName = String(parameters.runtime ?? "node");
  const assumptions = [
    "Each sample starts in a fresh process with vocabulary bytes already in memory.",
    "One fromBytes construction on the target vocabulary primes memory growth, module compilation, and target-size caches, then is freed before the timed target construction.",
    "The target fromBytes call uses the installed package public entry and keeps its per-call wasm file read inside the cell.",
    "Prime and target timings are reported together; a target statistically indistinguishable from priming blocks the cell.",
    "Median absolute deviation is the noise estimator because the governing documents do not name one.",
  ];
  const limits = [
    "Only the htk format has a public loader for this cell; tiktoken and Hugging Face formats are blocked.",
    "This cell excludes JavaScript module import time and the post-construction probe used by the older harness.",
    "Sampling starts at five, escalates to at most 128, stops at resolution or futility, and observes a ten-minute backstop.",
    "Paired resolution requires the prime-target gap to exceed twice the combined median-absolute-deviation noise.",
  ];

  function mime(file) {
    if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript";
    if (file.endsWith(".wasm")) return "application/wasm";
    if (file.endsWith(".json")) return "application/json";
    return "application/octet-stream";
  }

  async function browserSample() {
    const packageRoot = path.resolve(String(parameters["package-root"] ?? "node_modules/hypertok"));
    const vocabulary = fs.readFileSync(path.resolve(String(parameters.vocab)));
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const exported = packageJson.exports["."];
    const entry = (typeof exported === "string" ? exported : exported.import ?? exported.default).replace(/^\.\//, "");
    const server = http.createServer((request, response) => {
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><title>instrument</title>");
        return;
      }
      if (request.url === "/vocab") {
        response.setHeader("Content-Type", "application/octet-stream");
        response.end(vocabulary);
        return;
      }
      const relative = decodeURIComponent((request.url ?? "").replace(/^\/package\//, ""));
      const file = path.resolve(packageRoot, relative);
      if (!file.startsWith(`${packageRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("Content-Type", mime(file));
      response.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
      const { chromium } = await import("playwright-core");
      const candidates = [
        parameters.chrome,
        process.env.HYPERTOK_CHROME_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
      ].filter((candidate) => candidate && fs.existsSync(candidate));
      if (candidates.length === 0) throw new Error("Chrome executable not found");
      browser = await chromium.launch({ executablePath: candidates[0], headless: true });
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.goto(origin);
      return await page.evaluate(async ({ entryUrl }) => {
        const module = await import(entryUrl);
        const bytes = new Uint8Array(await (await fetch("/vocab")).arrayBuffer());
        const primeBegin = performance.now();
        const prime = await module.fromBytes(bytes, { tier: "single" });
        const primeMs = performance.now() - primeBegin;
        prime.free();
        const targetBegin = performance.now();
        const target = await module.fromBytes(bytes, { tier: "single" });
        const targetMs = performance.now() - targetBegin;
        const properties = { vocabSize: target.vocabSize, structuralClass: target.structuralClass, formatVersion: target.formatVersion };
        target.free();
        return { primeMs, targetMs, properties, byteLength: bytes.length };
      }, { entryUrl: `${origin}/package/${entry}` });
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function nodeSample() {
    const payload = Buffer.from(JSON.stringify({
      package: String(parameters.package ?? "hypertok"),
      vocab: path.resolve(String(parameters.vocab)),
    })).toString("base64url");
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--child=${payload}`], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (run.status !== 0) throw new Error(run.stderr || run.stdout);
    return JSON.parse(run.stdout);
  }

  const cells = [];
  if (parameters.smoke) {
    cells.push({ id: "smoke", status: "not-booked", parameters: { format, runtime: runtimeName }, result: null, noise: null });
  } else if (format !== "htk") {
    cells.push({
      id: `${format}-construction`,
      status: "blocked",
      parameters: { format, runtime: runtimeName },
      result: null,
      noise: null,
      blocked: { reason: "public-loader-unavailable", needed: "A public fromBytes loader for the requested vocabulary format." },
    });
  } else {
    if (!parameters.vocab) throw new Error("--vocab=<path> is required");
    const samples = [];
    const started = performance.now();
    let target = minimum;
    let previousCombined = null;
    let stop = "maximum-samples";
    while (samples.length < target) samples.push(runtimeName === "browser" ? await browserSample() : nodeSample());
    while (samples.length < maximum) {
      const primeNoise = summarize(samples.map((sample) => sample.primeMs));
      const targetNoise = summarize(samples.map((sample) => sample.targetMs));
      const gap = Math.abs(targetNoise.median - primeNoise.median);
      const combined = Math.hypot(primeNoise.mad, targetNoise.mad);
      if (gap > 2 * combined) {
        stop = "resolved";
        break;
      }
      if (previousCombined !== null && combined >= previousCombined * 0.95) {
        stop = "noise-stopped-shrinking";
        break;
      }
      if (performance.now() - started >= backstopMs) {
        stop = "ten-minute-backstop";
        break;
      }
      previousCombined = combined;
      target = Math.min(maximum, samples.length * 2 + 1);
      while (samples.length < target && performance.now() - started < backstopMs) {
        samples.push(runtimeName === "browser" ? await browserSample() : nodeSample());
      }
    }
    const primeNoise = summarize(samples.map((sample) => sample.primeMs));
    const targetNoise = summarize(samples.map((sample) => sample.targetMs));
    const gap = Math.abs(targetNoise.median - primeNoise.median);
    const combined = Math.hypot(primeNoise.mad, targetNoise.mad);
    cells.push({
      id: `${runtimeName}-htk-pure-construction`,
      status: gap > 2 * combined ? "measured" : "blocked",
      parameters: {
        runtime: runtimeName,
        format,
        vocabularyBytes: samples[0].byteLength,
        vocabularyProperties: samples[0].properties,
      },
      result: {
        priming: measured(samples.map((sample) => sample.primeMs), "ms"),
        target: measured(samples.map((sample) => sample.targetMs), "ms"),
        pairedGap: measured(samples.map((sample) => sample.targetMs - sample.primeMs), "ms"),
      },
      sampling: { initial: minimum, reached: samples.length, maximum, stop, elapsedMs: performance.now() - started },
      blocked: gap > 2 * combined ? undefined : {
        reason: "target-near-priming",
        needed: "A target-prime gap exceeding twice combined noise before the futility stop.",
      },
    });
  }

  for (const cell of cells) {
    cell.assumptions = assumptions;
    cell.limits = limits;
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    instrument: 5,
    subject: "pure construction",
    axes: [5],
    mode: parameters.smoke ? "smoke" : "measure",
    parameters: { ...parameters, minimum, maximum, backstopMs, format, runtime: runtimeName },
    cells,
    assumptions,
    limits,
  }, null, 2)}\n`);
}
