#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

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

function generatedInput(minimumPretokens, minimumBytes) {
  const piece = "worker ";
  let text = piece.repeat(Math.max(minimumPretokens, 1));
  while (Buffer.byteLength(text) < minimumBytes) text += piece;
  return text;
}

const parameters = parseArgs(process.argv.slice(2));
const tier = String(parameters.tier ?? "worker");
const entry = String(parameters.entry ?? "encode");
const workers = [...new Set(String(parameters.workers ?? "1,2,4").split(",").map(Number))].sort((left, right) => left - right);
const calls = Number(parameters.calls ?? Math.max(...workers));
const minimum = Number(parameters.minimum ?? 5);
const maximum = Number(parameters.maximum ?? 128);
const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
const workload = String(parameters.workload ?? "prose");
const reserved = String(parameters.reserved ?? "none");
const assumptions = [
  "The browser constructs W = 1, W = 2, and the requested W = n through the installed package public fromBytes entry on the same tier and workload.",
  "Each sample issues concurrent public encode calls so multiple workers can be active, with warm-up outside timing and outputs consumed.",
  "Efficiency is throughput at W divided by W times this instrument's own W = 1 throughput from the same sample round.",
  "Worker-tier input uses more than 1024 times W minus one short pretokens or exceeds the chunk threshold, using input bytes and workload class as the public proxy.",
  "The generated ASCII workload is assumed to avoid worker-unsupported byte patterns because no public capability signal exists.",
  "Shared-tier saturation is an explicitly stated assumption because the public surface exposes no flush or engagement signal.",
  "Median absolute deviation is the noise estimator because the governing documents do not name one.",
];
const limits = [
  "Node cannot construct worker tiers publicly, so this instrument runs in a browser host only.",
  "Decode runs on the calling thread on every tier; decode scaling is determined at 1/W and is not measured.",
  "Reserved-policy encode is deterministic calling-thread fallback and is not measured.",
  "A fallback-served sample is invalid, but no public fallback signal exists; every cell remains assumption-bound and carries the input proxies.",
  "Sampling starts at five, escalates to at most 128, stops when ratio noise no longer shrinks, and observes a ten-minute backstop.",
];

const cells = [];
if (parameters.smoke) {
  cells.push({ id: "smoke", status: "not-booked", parameters: { tier, entry, workers, calls, workload, reserved }, result: null, noise: null });
} else if (!new Set(["worker", "shared"]).has(tier)) {
  cells.push({ id: `${tier}-scaling`, status: "blocked", parameters: { tier }, result: null, noise: null, blocked: { reason: "axis-tier-out-of-scope", needed: "The worker or shared tier." } });
} else if (reserved !== "none") {
  cells.push({ id: `${tier}-reserved-scaling`, status: "blocked", parameters: { tier, reserved }, result: null, noise: null, blocked: { reason: "reserved-policy-fallback-by-construction", needed: "No measurement; axis 9 defines this cell as deterministic calling-thread fallback." } });
} else {
  if (!parameters.vocab) throw new Error("--vocab=<path> is required");
  if (!workers.includes(1)) throw new Error("--workers must include 1 for the denominator");
  if (!new Set(["encode", "encodeInto", "encodeDetailed"]).has(entry)) throw new Error("--entry must be encode, encodeInto, or encodeDetailed");
  const maximumWorkers = Math.max(...workers);
  const minimumPretokens = Number(parameters.pretokens ?? (1024 * Math.max(0, maximumWorkers - 1) + 1));
  const input = parameters.input ? fs.readFileSync(path.resolve(String(parameters.input)), "utf8") : generatedInput(minimumPretokens, Number(parameters.bytes ?? 1048576));
  const inputBytes = Buffer.byteLength(input);
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
    await page.evaluate(async ({ entryUrl, tierValue, workerValues, inputValue, entryValue, callCount }) => {
      const module = await import(entryUrl);
      const bytes = new Uint8Array(await (await fetch("/vocab")).arrayBuffer());
      const runtimes = {};
      for (const workerCount of workerValues) {
        const runtime = await module.fromBytes(bytes, { tier: tierValue, workers: workerCount });
        const expected = (await runtime.encode(inputValue)).length;
        const destinations = Array.from({ length: callCount }, () => new Uint32Array(expected + 8));
        const invoke = async () => {
          const tasks = Array.from({ length: callCount }, (_, index) => {
            if (entryValue === "encode") return runtime.encode(inputValue);
            if (entryValue === "encodeInto") return runtime.encodeInto(inputValue, destinations[index]);
            return runtime.encodeDetailed(inputValue);
          });
          const outputs = await Promise.all(tasks);
          return outputs.reduce((sum, output) => sum + (typeof output === "number" ? output : output.ids?.length ?? output.length), 0);
        };
        await invoke();
        runtimes[workerCount] = { runtime, invoke };
      }
      globalThis.__workerScaling = runtimes;
    }, { entryUrl: `${origin}/package/${packageEntry}`, tierValue: tier, workerValues: workers, inputValue: input, entryValue: entry, callCount: calls });

    const samples = [];
    const started = performance.now();
    let target = minimum;
    let previousBand = null;
    let stop = "maximum-samples";
    const take = (round) => page.evaluate(async ({ workerValues, inputByteCount, callCount, roundValue }) => {
      const order = workerValues.map((_, index) => workerValues[(index + roundValue) % workerValues.length]);
      const rows = {};
      for (const workerCount of order) {
        const begin = performance.now();
        const checksum = await globalThis.__workerScaling[workerCount].invoke();
        const ms = performance.now() - begin;
        rows[workerCount] = { throughput: ((inputByteCount * callCount) / 1e6) / (ms / 1000), ms, checksum };
      }
      return rows;
    }, { workerValues: workers, inputByteCount: inputBytes, callCount: calls, roundValue: round });
    while (samples.length < target) samples.push(await take(samples.length));
    while (samples.length < maximum) {
      const ratioValues = samples.flatMap((sample) => workers.filter((value) => value !== 1).map((value) => sample[value].throughput / (value * sample[1].throughput)));
      const band = summarize(ratioValues).mad;
      if (previousBand !== null && band >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
      if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
      previousBand = band;
      target = Math.min(maximum, samples.length * 2 + 1);
      while (samples.length < target && performance.now() - started < backstopMs) samples.push(await take(samples.length));
    }
    for (const workerCount of workers) {
      cells.push({
        id: `${tier}-${entry}-workers-${workerCount}`,
        status: "measured-assumption-bound",
        parameters: { tier, entry, workers: workerCount, workload, inputBytes, pretokenProxy: minimumPretokens, concurrentCalls: calls, runtime: "chrome", fallbackSignal: "unavailable" },
        result: {
          throughput: measured(samples.map((sample) => sample[workerCount].throughput), "MB/s"),
          efficiency: workerCount === 1
            ? { value: 1, unit: "ratio", noise: { kind: "defined-denominator", absolute: 0, relative: 0 } }
            : measured(samples.map((sample) => sample[workerCount].throughput / (workerCount * sample[1].throughput)), "ratio"),
        },
        sampling: { initial: minimum, reached: samples.length, maximum, stop, elapsedMs: performance.now() - started },
      });
    }
    cells.push({ id: `${tier}-decode-determined`, status: "determined", parameters: { tier, operation: "decode" }, result: { efficiency: { expression: "1/W", noise: { kind: "definition" } } } });
    await page.evaluate(() => Object.values(globalThis.__workerScaling).forEach(({ runtime }) => runtime.free()));
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const cell of cells) { cell.assumptions = assumptions; cell.limits = limits; }
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, instrument: 10, subject: "worker scaling", axes: [9], mode: parameters.smoke ? "smoke" : "measure", parameters: { ...parameters, tier, entry, workers, calls, workload, reserved, minimum, maximum, backstopMs }, cells, assumptions, limits }, null, 2)}\n`);
