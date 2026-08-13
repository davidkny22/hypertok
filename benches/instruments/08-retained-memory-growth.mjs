#!/usr/bin/env node

import fs from "node:fs";
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

function textFor(bytes, workload) {
  const seeds = { prose: "Retained memory after one large public call. ", code: "function f(x) { return x + 1; }\n", CJK: "漢字仮名交じり文。", emoji: "🙂🚀🧪", mixed: "Text 漢字 🙂 code; " };
  const seed = seeds[workload] ?? seeds.prose;
  let text = "";
  while (Buffer.byteLength(text) < bytes) text += seed;
  while (Buffer.byteLength(text) > bytes) text = text.slice(0, -1);
  return text;
}

async function settle(epsilon, consecutive, intervalMs, backstopMs) {
  const started = performance.now();
  let previous = process.memoryUsage().rss;
  let stable = 0;
  while (performance.now() - started < backstopMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const current = process.memoryUsage().rss;
    stable = Math.abs(current - previous) <= epsilon ? stable + 1 : 0;
    previous = current;
    if (stable >= consecutive) return { rss: current, elapsedMs: performance.now() - started, stablePolls: stable };
  }
  return { rss: previous, elapsedMs: performance.now() - started, stablePolls: stable, timedOut: true };
}

async function child(payload) {
  const module = await importPublic(payload.package);
  const runtime = await module.fromBytes(fs.readFileSync(payload.vocab), { tier: payload.tier, workers: payload.workers });
  const text = textFor(payload.size, payload.workload);
  const encoded = runtime.encodeSync(text);
  const ids = new Uint32Array(payload.size).fill(encoded[0] ?? 0);
  const destination = new Uint32Array(Math.max(encoded.length + 8, 8));
  global.gc();
  const beforeSettled = await settle(payload.epsilon, payload.consecutive, payload.intervalMs, payload.settleBackstopMs);
  const beforeHeap = process.memoryUsage().heapUsed;
  let output;
  if (payload.entry === "encodeSync") output = runtime.encodeSync(text);
  else if (payload.entry === "encode") output = await runtime.encode(text);
  else if (payload.entry === "encodeInto") output = await runtime.encodeInto(text, destination);
  else if (payload.entry === "encodeDetailed") output = await runtime.encodeDetailed(text);
  else if (payload.entry === "decode") output = runtime.decode(ids);
  else throw new Error(`unsupported entry point: ${payload.entry}`);
  const checksum = typeof output === "string" ? output.length : typeof output === "number" ? output : output.ids?.length ?? output.length;
  global.gc();
  const afterSettled = await settle(payload.epsilon, payload.consecutive, payload.intervalMs, payload.settleBackstopMs);
  const afterHeap = process.memoryUsage().heapUsed;
  runtime.free();
  return {
    retainedRss: afterSettled.rss - beforeSettled.rss,
    retainedHeap: afterHeap - beforeHeap,
    checksum,
    beforeSettled,
    afterSettled,
  };
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
  if (!parameters.smoke && typeof global.gc !== "function" && !parameters["gc-child"]) {
    const run = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), ...process.argv.slice(2), "--gc-child"], { encoding: "utf8", windowsHide: true });
    if (run.status !== 0) throw new Error(run.stderr || run.stdout);
    process.stdout.write(run.stdout);
  } else {
    const runtimeName = String(parameters.runtime ?? "node");
    const tier = String(parameters.tier ?? "single");
    const entry = String(parameters.entry ?? "encodeSync");
    const operation = entry === "decode" ? "decode" : "encode";
    const workload = String(parameters.workload ?? "prose");
    const sizes = String(parameters.sizes ?? "1048576").split(",").map(Number);
    const epsilon = Number(parameters.epsilon ?? 65536);
    const consecutive = Number(parameters.consecutive ?? 3);
    const intervalMs = Number(parameters["interval-ms"] ?? 100);
    const settleBackstopMs = Number(parameters["settle-backstop-ms"] ?? 30000);
    const minimum = Number(parameters.minimum ?? 5);
    const maximum = Number(parameters.maximum ?? 128);
    const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
    const assumptions = [
      "Each size and each sample uses a fresh process, constructs through public fromBytes, and measures the first call at the target size.",
      "The phrase about warm-up pre-paying the step is treated as explaining why ordinary warmed sampling is forbidden; no target-size warm call runs before the measured call.",
      "Before and after readings follow forced GC and settle when RSS changes by no more than the stated epsilon for the stated consecutive poll count.",
      "Retained growth is after-settle RSS minus before-settle RSS; heap growth is a labeled cross-check.",
      "Median absolute deviation is the noise estimator because the governing documents do not name one.",
  ];
    const limits = [
      "Browser runtime cells are blocked because the browser RSS seam is not qualified.",
      "Wasm linear memory never shrinks, so nonzero retained steps are expected and are not treated as leaks by this instrument.",
      "A settle timeout is reported and invalidates booking rather than being hidden.",
      "Sampling starts at five, escalates to at most 128, stops when noise no longer shrinks, and observes a ten-minute backstop.",
    ];
    const cells = [];
    if (parameters.smoke) {
      cells.push({ id: "smoke", status: "not-booked", parameters: { runtime: runtimeName, tier, entry, sizes, epsilon, consecutive, intervalMs }, result: null, noise: null });
    } else if (runtimeName !== "node") {
      cells.push({ id: `${runtimeName}-${tier}-${entry}`, status: "blocked", parameters: { runtime: runtimeName, tier, entry }, result: null, noise: null, blocked: { reason: "browser-memory-seam-unqualified", needed: "A browser process RSS seam." } });
    } else {
      if (!parameters.vocab) throw new Error("--vocab=<path> is required");
      for (const size of sizes) {
        const samples = [];
        const started = performance.now();
        let target = minimum;
        let previousBand = null;
        let stop = "maximum-samples";
        const take = () => {
          const payload = Buffer.from(JSON.stringify({
            package: String(parameters.package ?? "hypertok"), vocab: path.resolve(String(parameters.vocab)), runtime: runtimeName, tier,
            workers: Number(parameters.workers ?? 1), entry, size, workload, epsilon, consecutive, intervalMs, settleBackstopMs,
          })).toString("base64url");
          const run = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), `--child=${payload}`], { encoding: "utf8", windowsHide: true });
          if (run.status !== 0) throw new Error(run.stderr || run.stdout);
          return JSON.parse(run.stdout);
        };
        while (samples.length < target) samples.push(take());
        while (samples.length < maximum) {
          const band = summarize(samples.map((sample) => sample.retainedRss)).mad;
          if (previousBand !== null && band >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
          if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
          previousBand = band;
          target = Math.min(maximum, samples.length * 2 + 1);
          while (samples.length < target && performance.now() - started < backstopMs) samples.push(take());
        }
        const settled = samples.every((sample) => !sample.beforeSettled.timedOut && !sample.afterSettled.timedOut);
        cells.push({
          id: `${runtimeName}-${tier}-${entry}-${size}-retained`,
          status: settled ? (stop === "maximum-samples" ? "unresolved" : "measured") : "unmeasurable",
          parameters: { runtime: runtimeName, tier, operation, entry, size, workload, epsilon, consecutive, intervalMs },
          result: {
            retainedRss: measured(samples.map((sample) => sample.retainedRss), "bytes"),
            retainedHeap: measured(samples.map((sample) => sample.retainedHeap), "bytes"),
            beforeSettleSpan: measured(samples.map((sample) => sample.beforeSettled.elapsedMs), "ms"),
            afterSettleSpan: measured(samples.map((sample) => sample.afterSettled.elapsedMs), "ms"),
          },
          sampling: { initial: minimum, reached: samples.length, maximum, stop, elapsedMs: performance.now() - started },
          blocked: settled ? undefined : { reason: "rss-did-not-settle", needed: "Both pre-call and post-call RSS must meet the stated settle bar." },
        });
      }
    }
    for (const cell of cells) { cell.assumptions = assumptions; cell.limits = limits; }
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, instrument: 8, subject: "retained memory growth", axes: [13], mode: parameters.smoke ? "smoke" : "measure", parameters: { ...parameters, runtime: runtimeName, tier, operation, entry, workload, sizes, epsilon, consecutive, intervalMs, settleBackstopMs, minimum, maximum, backstopMs }, cells, assumptions, limits }, null, 2)}\n`);
  }
}
