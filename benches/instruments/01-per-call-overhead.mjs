#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
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

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function summarize(values) {
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  return {
    sampleCount: values.length,
    median: center,
    p95: percentile(values, 0.95),
    mad,
    relativeMad: center === 0 ? null : mad / Math.abs(center),
  };
}

function regression(points) {
  const count = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const denominator = count * sumXX - sumX * sumX;
  if (denominator === 0) throw new Error("sweep does not contain enough distinct sizes");
  const slope = (count * sumXY - sumX * sumY) / denominator;
  return { slope, intercept: (sumY - slope * sumX) / count };
}

function nextCount(count, maximum) {
  return Math.min(maximum, count * 2 + 1);
}

function timerResolution(clock) {
  let previous = clock();
  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 10000; index += 1) {
    const current = clock();
    const delta = current - previous;
    if (delta > 0 && delta < smallest) smallest = delta;
    previous = current;
  }
  return Number.isFinite(smallest) ? smallest : null;
}

function consume(value) {
  if (value instanceof Uint32Array || Array.isArray(value)) return value.length;
  if (typeof value === "number") return value;
  if (value?.ids) return value.ids.length + (value.starts?.length ?? 0);
  if (typeof value === "string") return value.length;
  return 1;
}

async function oneSweep(runtime, operation, maximum, batch) {
  const points = [];
  let checksum = 0;
  const firstId = runtime.encodeSync("a")[0] ?? 0;
  const startSize = operation === "decode" ? 1 : 0;
  for (let size = startSize; size <= maximum; size += 1) {
    const text = "a".repeat(size);
    const ids = new Uint32Array(size).fill(firstId);
    const destination = operation === "encodeInto"
      ? new Uint32Array(Math.max(1, runtime.encodeSync(text).length + 8))
      : null;
    const begin = performance.now();
    for (let iteration = 0; iteration < batch; iteration += 1) {
      let output;
      if (operation === "encodeSync") output = runtime.encodeSync(text);
      else if (operation === "decode") output = runtime.decode(ids);
      else if (operation === "encode") output = await runtime.encode(text);
      else if (operation === "encodeInto") output = await runtime.encodeInto(text, destination);
      else if (operation === "encodeDetailed") output = await runtime.encodeDetailed(text);
      else throw new Error(`unsupported operation: ${operation}`);
      checksum ^= consume(output) + iteration;
    }
    const elapsed = performance.now() - begin;
    points.push({ x: size, y: (elapsed * 1e6) / batch });
  }
  return { ...regression(points), sizeZeroNs: startSize === 0 ? points[0].y : null, checksum };
}

async function adaptiveSweeps(makeSweep, minimum, maximum, backstopMs) {
  const started = performance.now();
  const samples = [];
  let target = minimum;
  let previousBand = null;
  let stop = "maximum-samples";
  while (samples.length < target) samples.push(await makeSweep());
  while (samples.length < maximum) {
    const band = summarize(samples.map((sample) => sample.intercept)).mad;
    if (previousBand !== null && band >= previousBand * 0.95) {
      stop = "noise-stopped-shrinking";
      break;
    }
    if (performance.now() - started >= backstopMs) {
      stop = "ten-minute-backstop";
      break;
    }
    previousBand = band;
    target = nextCount(samples.length, maximum);
    while (samples.length < target && performance.now() - started < backstopMs) {
      samples.push(await makeSweep());
    }
  }
  return { samples, stop, elapsedMs: performance.now() - started };
}

function resultNumber(values, unit) {
  const noise = summarize(values);
  return { value: noise.median, unit, noise };
}

function resultCell(operation, adaptive, batch, maximum, runtimeName, resolution) {
  const intercepts = adaptive.samples.map((sample) => sample.intercept);
  const slopes = adaptive.samples.map((sample) => sample.slope);
  const zero = adaptive.samples.map((sample) => sample.sizeZeroNs).filter((value) => value !== null);
  return {
    id: `${runtimeName}-${operation}-total`,
    status: adaptive.stop === "maximum-samples" ? "unresolved" : "measured",
    parameters: { operation, entryPoint: operation, tier: "single", maximum, batch, runtime: runtimeName },
    result: {
      totalOverhead: resultNumber(intercepts, "ns"),
      slope: resultNumber(slopes, operation === "decode" ? "ns/id" : "ns/byte"),
      sizeZeroShortcut: zero.length > 0 ? resultNumber(zero, "ns") : null,
      timerResolution: { value: resolution, unit: "ms", noise: { kind: "observed-minimum" } },
    },
    sampling: {
      initial: 5,
      reached: adaptive.samples.length,
      maximum: 128,
      stop: adaptive.stop,
      elapsedMs: adaptive.elapsedMs,
      noiseEstimator: "median absolute deviation around the sample median",
    },
  };
}

async function importPublicPackage(specifier) {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return import(pathToFileURL(path.resolve(specifier)).href);
  }
  return import(specifier);
}

function mime(file) {
  if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function browserRuntime(parameters, operations, maximum, batch, minimum, sampleMaximum, backstopMs) {
  const packageRoot = path.resolve(String(parameters["package-root"] ?? "node_modules/hypertok"));
  const vocab = fs.readFileSync(path.resolve(String(parameters.vocab)));
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const exportValue = packageJson.exports["."];
  const entry = (typeof exportValue === "string" ? exportValue : exportValue.import ?? exportValue.default).replace(/^\.\//, "");
  const isolated = String(parameters.isolated ?? "false") === "true";
  const server = http.createServer((request, response) => {
    if (isolated) {
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    if (request.url === "/vocab") {
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(vocab);
      return;
    }
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>instrument</title>");
      return;
    }
    const relative = decodeURIComponent((request.url ?? "/").replace(/^\/package\//, ""));
    const resolved = path.resolve(packageRoot, relative);
    if (!resolved.startsWith(`${packageRoot}${path.sep}`) || !fs.existsSync(resolved)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("Content-Type", mime(resolved));
    response.end(fs.readFileSync(resolved));
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
    await page.evaluate(async ({ entryUrl }) => {
      const module = await import(entryUrl);
      const bytes = new Uint8Array(await (await fetch("/vocab")).arrayBuffer());
      globalThis.__instrumentRuntime = await module.fromBytes(bytes, { tier: "single" });
    }, { entryUrl: `${origin}/package/${entry}` });
    const resolution = await page.evaluate(() => {
      let previous = performance.now();
      let smallest = Number.POSITIVE_INFINITY;
      for (let index = 0; index < 10000; index += 1) {
        const current = performance.now();
        const delta = current - previous;
        if (delta > 0 && delta < smallest) smallest = delta;
        previous = current;
      }
      return Number.isFinite(smallest) ? smallest : null;
    });
    const cells = [];
    for (const operation of operations) {
      const makeSweep = () => page.evaluate(async ({ operationValue, maximumValue, batchValue }) => {
        const runtime = globalThis.__instrumentRuntime;
        const consumeValue = (value) => {
          if (value instanceof Uint32Array || Array.isArray(value)) return value.length;
          if (typeof value === "number") return value;
          if (value?.ids) return value.ids.length + (value.starts?.length ?? 0);
          if (typeof value === "string") return value.length;
          return 1;
        };
        const fit = (points) => {
          const count = points.length;
          const sumX = points.reduce((sum, point) => sum + point.x, 0);
          const sumY = points.reduce((sum, point) => sum + point.y, 0);
          const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
          const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
          const denominator = count * sumXX - sumX * sumX;
          const slope = (count * sumXY - sumX * sumY) / denominator;
          return { slope, intercept: (sumY - slope * sumX) / count };
        };
        const points = [];
        let checksum = 0;
        const firstId = runtime.encodeSync("a")[0] ?? 0;
        const startSize = operationValue === "decode" ? 1 : 0;
        for (let size = startSize; size <= maximumValue; size += 1) {
          const text = "a".repeat(size);
          const ids = new Uint32Array(size).fill(firstId);
          const destination = operationValue === "encodeInto"
            ? new Uint32Array(Math.max(1, runtime.encodeSync(text).length + 8))
            : null;
          const begin = performance.now();
          for (let iteration = 0; iteration < batchValue; iteration += 1) {
            let output;
            if (operationValue === "encodeSync") output = runtime.encodeSync(text);
            else if (operationValue === "decode") output = runtime.decode(ids);
            else if (operationValue === "encode") output = await runtime.encode(text);
            else if (operationValue === "encodeInto") output = await runtime.encodeInto(text, destination);
            else output = await runtime.encodeDetailed(text);
            checksum ^= consumeValue(output) + iteration;
          }
          points.push({ x: size, y: ((performance.now() - begin) * 1e6) / batchValue });
        }
        return { ...fit(points), sizeZeroNs: startSize === 0 ? points[0].y : null, checksum };
      }, { operationValue: operation, maximumValue: maximum, batchValue: batch });
      const adaptive = await adaptiveSweeps(makeSweep, minimum, sampleMaximum, backstopMs);
      cells.push(resultCell(operation, adaptive, batch, maximum, "chrome", resolution));
    }
    await page.evaluate(() => globalThis.__instrumentRuntime.free());
    return { cells, browserVersion: browser.version(), isolated };
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

const parameters = parseArgs(process.argv.slice(2));
const operations = String(parameters.operations ?? "encodeSync,decode,encode,encodeInto,encodeDetailed").split(",");
const maximum = Number(parameters.maximum ?? 256);
const batch = Number(parameters.batch ?? 1000);
const minimum = Number(parameters.minimum ?? 5);
const sampleMaximum = Number(parameters["sample-maximum"] ?? 128);
const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
if (batch < 1000) throw new Error("--batch must be at least 1000");
const assumptions = [
  "Every sweep uses one warmed single-tier tokenizer created through the installed package's public fromBytes entry point.",
  "Encode sweeps cover 0 through 256 input bytes by default; decode sweeps cover 1 through 256 ids.",
  "Async entry points execute sequential awaits with one call in flight, and every output contributes to a checksum.",
  "The regression intercept is fixed per-call cost and the fitted slope is the size-dependent term.",
  "Median absolute deviation is the noise estimator because the governing documents do not name one.",
  "Browser batching is mandatory; the report records observed timer resolution and the isolation regime.",
];
const limits = [
  "Worker and shared intercept cells are blocked because no public signal distinguishes worker service from calling-thread fallback.",
  "The size-zero point is an early-return shortcut detector and is reported separately from the fitted intercept.",
  "A callable simple export is absent unless --simple-export names one in the shipped binary; raw and glue layers then remain blocked-for-owner.",
  "The test-gated no-op export fallback is owner-fenced and this script never adds or requests it.",
  "Single-cell sampling starts at five, escalates to at most 128, stops when the MAD band no longer shrinks, and observes a ten-minute backstop.",
];

let cells = [];
let environment = {};
if (parameters.smoke) {
  cells.push({ id: "smoke", status: "not-booked", parameters: { operations, maximum, batch }, result: null, noise: null });
} else if (String(parameters.runtime ?? "node") === "browser") {
  if (!parameters.vocab) throw new Error("browser measurement requires --vocab=<path>");
  const measured = await browserRuntime(parameters, operations, maximum, batch, minimum, sampleMaximum, backstopMs);
  cells.push(...measured.cells);
  environment = { browserVersion: measured.browserVersion, isolated: measured.isolated, runtime: "chrome" };
} else {
  if (!parameters.vocab) throw new Error("Node measurement requires --vocab=<path>");
  const packageModule = await importPublicPackage(String(parameters.package ?? "hypertok"));
  const bytes = fs.readFileSync(path.resolve(String(parameters.vocab)));
  const runtime = await packageModule.fromBytes(bytes, { tier: "single" });
  const resolution = timerResolution(() => performance.now());
  try {
    for (const operation of operations) {
      const adaptive = await adaptiveSweeps(
        () => oneSweep(runtime, operation, maximum, batch),
        minimum,
        sampleMaximum,
        backstopMs,
      );
      cells.push(resultCell(operation, adaptive, batch, maximum, "node", resolution));
    }
  } finally {
    runtime.free();
  }
  environment = { node: process.version, runtime: "node" };
}

for (const layer of ["raw-call", "bindgen-glue", "wrapper-fixed-work"]) {
  cells.push({
    id: `layer-${layer}`,
    status: parameters["simple-export"] ? "blocked" : "blocked-for-owner",
    parameters: { simpleExport: parameters["simple-export"] ?? null },
    result: null,
    noise: null,
    blocked: {
      reason: parameters["simple-export"] ? "initialized-glue-export-not-publicly-callable" : "no-callable-simple-export-confirmed",
      needed: parameters["simple-export"]
        ? "A public installed-package seam exposing the named initialized glue function without a product-only test export."
        : "Owner approval for the test-gated no-op export fallback.",
    },
  });
}
for (const tier of ["worker", "shared"]) {
  cells.push({
    id: `${tier}-intercept`,
    status: "blocked",
    parameters: { tier },
    result: null,
    noise: null,
    blocked: { reason: "public-fallback-signal-missing", needed: "A public signal proving the sample was served off-thread." },
  });
}
for (const cell of cells) {
  cell.assumptions = assumptions;
  cell.limits = limits;
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  instrument: 1,
  subject: "per-call overhead",
  axes: [4],
  mode: parameters.smoke ? "smoke" : "measure",
  parameters: { ...parameters, operations, maximum, batch, minimum, sampleMaximum, backstopMs },
  environment,
  cells,
  assumptions,
  limits,
}, null, 2)}\n`);
