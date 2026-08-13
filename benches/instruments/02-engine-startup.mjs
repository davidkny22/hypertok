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
    if (key === "real") (values.real ??= []).push(value);
    else values[key] = value;
  }
  return values;
}

function uleb(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

function syntheticModule(targetBytes) {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const bodyPayload = Math.max(4, Math.min(1024, targetBytes - 32));
  const functionCount = Math.max(1, Math.floor((targetBytes - 32) / (bodyPayload + 4)));
  const typeSection = section(1, [0x01, 0x60, 0x00, 0x00]);
  const functionSection = section(3, [...uleb(functionCount), ...Array(functionCount).fill(0)]);
  const bodies = [];
  for (let index = 0; index < functionCount; index += 1) {
    const body = [0x00, ...Array(bodyPayload - 2).fill(0x01), 0x0b];
    bodies.push(...uleb(body.length), ...body);
  }
  return Buffer.from([...header, ...typeSection, ...functionSection, ...section(10, [...uleb(functionCount), ...bodies])]);
}

function memoryModule(pages) {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const memory = section(5, [0x01, 0x00, ...uleb(pages)]);
  const name = [...Buffer.from("memory")];
  const exports = section(7, [0x01, ...uleb(name.length), ...name, 0x02, 0x00]);
  return Buffer.from([...header, ...memory, ...exports]);
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

function result(values, unit) {
  const noise = summarize(values);
  return { value: noise.median, unit, noise };
}

function regression(points) {
  const count = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const denominator = count * sumXX - sumX * sumX;
  const slope = (count * sumXY - sumX * sumY) / denominator;
  return { slope, intercept: (sumY - slope * sumX) / count };
}

async function child(payload) {
  if (payload.kind === "compile") {
    const bytes = payload.file ? fs.readFileSync(payload.file) : syntheticModule(payload.bytes);
    const begin = performance.now();
    await WebAssembly.compile(bytes);
    return { ms: performance.now() - begin, bytes: bytes.length };
  }
  if (payload.kind === "reserve") {
    const module = await WebAssembly.compile(memoryModule(payload.pages));
    const begin = performance.now();
    await WebAssembly.instantiate(module);
    return { ms: performance.now() - begin, pages: payload.pages };
  }
  if (payload.kind === "touch") {
    const instance = await WebAssembly.instantiate(memoryModule(payload.pages));
    const memory = instance.instance.exports.memory;
    const before = process.memoryUsage.rss();
    const view = new Uint8Array(memory.buffer);
    const begin = performance.now();
    for (let offset = 0; offset < view.length; offset += 65536) view[offset] = 1;
    const ms = performance.now() - begin;
    return { ms, pages: payload.pages, bytes: view.length, rssStep: process.memoryUsage.rss() - before };
  }
  if (payload.kind === "glue") {
    const glue = await import(`${pathToFileURL(payload.glue).href}?sample=${payload.nonce}`);
    const module = await WebAssembly.compile(fs.readFileSync(payload.file));
    const begin = performance.now();
    glue.initSync({ module });
    return { ms: performance.now() - begin, bytes: fs.statSync(payload.file).size };
  }
  throw new Error(`unknown child kind: ${payload.kind}`);
}

const childArgument = process.argv.find((argument) => argument.startsWith("--child="));
if (childArgument) {
  try {
    const payload = JSON.parse(Buffer.from(childArgument.slice(8), "base64url").toString("utf8"));
    process.stdout.write(`${JSON.stringify(await child(payload))}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
} else {
  const parameters = parseArgs(process.argv.slice(2));
  const minimum = Number(parameters.minimum ?? 5);
  const maximum = Number(parameters.maximum ?? 128);
  const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
  const sizeSweep = String(parameters.sizes ?? "65536,262144,1048576")
    .split(",").map(Number);
  const pageSweep = String(parameters.pages ?? "1,16,64,256")
    .split(",").map(Number);
  const assumptions = [
    "Every compile, reservation, first-touch, glue-init, and browser anchor sample runs in a fresh process.",
    "Synthetic modules vary executable function bodies rather than padding custom sections.",
    "Compile throughput excludes background optimizing tier-up after WebAssembly.compile resolves.",
    "Declared pages reserve virtual address space and first-touch writes one byte per 64 KiB page to price commit-and-zero work.",
    "The real-artifact anchor overrides a synthetic slope when its gap exceeds twice combined median-absolute-deviation noise.",
    "Median absolute deviation is the noise estimator because the governing documents do not name one.",
  ];
  const limits = [
    "The full hybrid sweep runs in Node; Chrome measures one real artifact anchor and a same-process compiled-module cache check.",
    "Other runtimes are blocked until explicitly added.",
    "Sampling starts at five, escalates to at most 128, stops when the noise band no longer shrinks, and observes a ten-minute backstop per cell.",
    "The glue-init anchor uses the installed package's shipped bindgen glue and is not the derived cold-row composition.",
  ];

  function sample(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--child=${encoded}`], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (run.status !== 0) throw new Error(run.stderr || run.stdout);
    return JSON.parse(run.stdout);
  }

  function adaptive(makeSample) {
    const started = performance.now();
    const samples = [];
    let target = minimum;
    let previousBand = null;
    let stop = "maximum-samples";
    while (samples.length < target) samples.push(makeSample(samples.length));
    while (samples.length < maximum) {
      const band = summarize(samples.map((value) => value.metric)).mad;
      if (previousBand !== null && band >= previousBand * 0.95) {
        stop = "noise-stopped-shrinking";
        break;
      }
      if (performance.now() - started >= backstopMs) {
        stop = "ten-minute-backstop";
        break;
      }
      previousBand = band;
      target = Math.min(maximum, samples.length * 2 + 1);
      while (samples.length < target && performance.now() - started < backstopMs) {
        samples.push(makeSample(samples.length));
      }
    }
    return { samples, stop, elapsedMs: performance.now() - started };
  }

  async function adaptiveAsync(makeSample) {
    const started = performance.now();
    const samples = [];
    let target = minimum;
    let previousBand = null;
    let stop = "maximum-samples";
    while (samples.length < target) samples.push(await makeSample(samples.length));
    while (samples.length < maximum) {
      const band = summarize(samples.map((value) => value.metric)).mad;
      if (previousBand !== null && band >= previousBand * 0.95) {
        stop = "noise-stopped-shrinking";
        break;
      }
      if (performance.now() - started >= backstopMs) {
        stop = "ten-minute-backstop";
        break;
      }
      previousBand = band;
      target = Math.min(maximum, samples.length * 2 + 1);
      while (samples.length < target && performance.now() - started < backstopMs) {
        samples.push(await makeSample(samples.length));
      }
    }
    return { samples, stop, elapsedMs: performance.now() - started };
  }

  async function chromeAnchor(file) {
    const bytes = fs.readFileSync(file);
    const server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "application/wasm");
      response.end(bytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
      const browser = await chromium.launch({ executablePath: candidates[0], headless: true });
      try {
        const page = await browser.newPage();
        const url = `http://127.0.0.1:${server.address().port}/artifact.wasm`;
        return await page.evaluate(async (artifactUrl) => {
          const bytesValue = await (await fetch(artifactUrl)).arrayBuffer();
          const firstBegin = performance.now();
          await WebAssembly.compile(bytesValue.slice(0));
          const firstMs = performance.now() - firstBegin;
          const cachedBegin = performance.now();
          await WebAssembly.compile(bytesValue.slice(0));
          return { firstMs, cachedMs: performance.now() - cachedBegin };
        }, url);
      } finally {
        await browser.close();
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const cells = [];
  if (parameters.smoke) {
    cells.push({ id: "smoke", status: "not-booked", parameters: { sizeSweep, pageSweep }, result: null, noise: null });
  } else {
    const compileSamples = adaptive(() => {
      const points = sizeSweep.map((bytes) => {
        const measured = sample({ kind: "compile", bytes });
        return { x: measured.bytes / 1e6, y: measured.ms };
      });
      const fit = regression(points);
      return { metric: fit.slope, slope: fit.slope, intercept: fit.intercept, points };
    });
    cells.push({
      id: "node-synthetic-compile-throughput",
      status: compileSamples.stop === "maximum-samples" ? "unresolved" : "measured",
      parameters: { engine: "node", sizes: sizeSweep },
      result: {
        compileRate: result(compileSamples.samples.map((value) => 1000 / value.slope), "MB/s"),
        intercept: result(compileSamples.samples.map((value) => value.intercept), "ms"),
      },
      sampling: { initial: minimum, reached: compileSamples.samples.length, maximum, stop: compileSamples.stop },
    });

    const reserveSamples = adaptive(() => {
      const points = pageSweep.map((pages) => ({ x: pages, y: sample({ kind: "reserve", pages }).ms }));
      const fit = regression(points);
      return { metric: fit.intercept, slope: fit.slope, intercept: fit.intercept };
    });
    cells.push({
      id: "node-page-reservation",
      status: reserveSamples.stop === "maximum-samples" ? "unresolved" : "measured",
      parameters: { engine: "node", pages: pageSweep },
      result: {
        reservationIntercept: result(reserveSamples.samples.map((value) => value.intercept), "ms"),
        pagesSlope: result(reserveSamples.samples.map((value) => value.slope), "ms/page"),
      },
      sampling: { initial: minimum, reached: reserveSamples.samples.length, maximum, stop: reserveSamples.stop },
    });

    const touchSamples = adaptive(() => {
      const rows = pageSweep.map((pages) => sample({ kind: "touch", pages }));
      const rates = rows.map((row) => (row.bytes / 1e9) / (row.ms / 1000));
      return { metric: median(rates), rate: median(rates), rssStep: median(rows.map((row) => row.rssStep)) };
    });
    cells.push({
      id: "node-first-touch",
      status: touchSamples.stop === "maximum-samples" ? "unresolved" : "measured",
      parameters: { engine: "node", pages: pageSweep },
      result: {
        firstTouchRate: result(touchSamples.samples.map((value) => value.rate), "GB/s"),
        rssStep: result(touchSamples.samples.map((value) => value.rssStep), "bytes"),
      },
      sampling: { initial: minimum, reached: touchSamples.samples.length, maximum, stop: touchSamples.stop },
    });

    const realRows = [];
    for (const realValue of parameters.real ?? []) {
      const [label, fileValue, glueValue] = String(realValue).split("|");
      const file = path.resolve(fileValue ?? label);
      const compile = adaptive(() => {
        const measured = sample({ kind: "compile", file });
        return { metric: measured.ms, ms: measured.ms };
      });
      const row = {
        id: `node-real-anchor-${label}`,
        status: compile.stop === "maximum-samples" ? "unresolved" : "measured",
        parameters: { engine: "node", label, file },
        result: { compileTime: result(compile.samples.map((value) => value.ms), "ms") },
        sampling: { initial: minimum, reached: compile.samples.length, maximum, stop: compile.stop },
      };
      if (glueValue) {
        const glue = adaptive((nonce) => {
          const measured = sample({ kind: "glue", file, glue: path.resolve(glueValue), nonce });
          return { metric: measured.ms, ms: measured.ms };
        });
        row.result.glueInit = result(glue.samples.map((value) => value.ms), "ms");
      } else {
        row.glueInit = { status: "blocked", reason: "shipped-glue-path-not-supplied" };
      }
      cells.push(row);
      realRows.push({ label, file, row, compile });
    }
    if (realRows.length > 0) {
      const comparisons = realRows.map(({ label, file, compile }) => {
        const sizeMb = fs.statSync(file).size / 1e6;
        const predicted = compileSamples.samples.map((value) => value.intercept + value.slope * sizeMb);
        const observed = compile.samples.map((value) => value.ms);
        const predictedNoise = summarize(predicted);
        const observedNoise = summarize(observed);
        const gap = observedNoise.median - predictedNoise.median;
        const combined = Math.hypot(predictedNoise.mad, observedNoise.mad);
        return {
          label,
          predicted: result(predicted, "ms"),
          observed: result(observed, "ms"),
          gap: {
            value: gap,
            unit: "ms",
            noise: { kind: "combined-median-absolute-deviation", absolute: combined },
          },
          offSyntheticLine: Math.abs(gap) > 2 * combined,
        };
      });
      const syntheticDiscarded = comparisons.some((comparison) => comparison.offSyntheticLine);
      cells.push({
        id: "compile-model-basis",
        status: syntheticDiscarded ? "real-artifact-basis" : "synthetic-line-retained",
        parameters: { rule: "real artifact overrides when its gap exceeds twice combined noise" },
        result: { basis: syntheticDiscarded ? "real-artifact-anchors" : "synthetic-slope", syntheticDiscarded, comparisons },
      });
      const chrome = await adaptiveAsync(async () => {
        const anchor = await chromeAnchor(realRows[0].file);
        return { ...anchor, metric: anchor.firstMs };
      });
      cells.push({
        id: `chrome-real-anchor-${realRows[0].label}`,
        status: chrome.stop === "maximum-samples" ? "unresolved" : "measured",
        parameters: { engine: "chrome", label: realRows[0].label, freshBrowser: true },
        result: {
          firstCompile: result(chrome.samples.map((sample) => sample.firstMs), "ms"),
          cachedCompile: result(chrome.samples.map((sample) => sample.cachedMs), "ms"),
        },
        sampling: { initial: minimum, reached: chrome.samples.length, maximum, stop: chrome.stop, elapsedMs: chrome.elapsedMs },
      });
    } else {
      cells.push({
        id: "real-artifact-anchor",
        status: "blocked",
        parameters: {},
        result: null,
        noise: null,
        blocked: { reason: "real-artifact-not-supplied", needed: "At least one --real=<label>|<wasm>|<glue> input." },
      });
    }
  }

  for (const cell of cells) {
    cell.assumptions = assumptions;
    cell.limits = limits;
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    instrument: 2,
    subject: "engine startup sweep",
    axes: ["engine-startup-term"],
    mode: parameters.smoke ? "smoke" : "measure",
    parameters: { ...parameters, minimum, maximum, backstopMs, sizeSweep, pageSweep },
    cells,
    assumptions,
    limits,
  }, null, 2)}\n`);
}
