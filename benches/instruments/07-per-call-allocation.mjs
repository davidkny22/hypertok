#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { Session } from "node:inspector";
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

function post(session, method, params = {}) {
  return new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
}

function profileBytes(node) {
  return Number(node.selfSize ?? 0) + (node.children ?? []).reduce((sum, child) => sum + profileBytes(child), 0);
}

function textFor(bytes, workload) {
  const seeds = { prose: "Public allocation measurement over prose. ", code: "const ids = tok.encode(text);\n", CJK: "漢字仮名交じり文。", emoji: "🙂🚀🧪", mixed: "Text 漢字 🙂 code; " };
  const seed = seeds[workload] ?? seeds.prose;
  let text = "";
  while (Buffer.byteLength(text) < bytes) text += seed;
  while (Buffer.byteLength(text) > bytes) text = text.slice(0, -1);
  return text;
}

async function importPublic(specifier) {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) return import(pathToFileURL(path.resolve(specifier)).href);
  return import(specifier);
}

const parameters = parseArgs(process.argv.slice(2));
if (!parameters.smoke && typeof global.gc !== "function" && !parameters["gc-child"]) {
  const run = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), ...process.argv.slice(2), "--gc-child"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  process.stdout.write(run.stdout);
} else {
  const operation = String(parameters.operation ?? "encode");
  const entry = String(parameters.entry ?? (operation === "decode" ? "decode" : "encodeSync"));
  const tier = String(parameters.tier ?? "single");
  const runtimeName = String(parameters.runtime ?? "node");
  const size = Number(parameters.size ?? 4096);
  const calls = Number(parameters.calls ?? 1000);
  const samplingInterval = Number(parameters["sampling-interval"] ?? 32768);
  const minimum = Number(parameters.minimum ?? 5);
  const maximum = Number(parameters.maximum ?? 128);
  const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
  const workload = String(parameters.workload ?? "prose");
  const assumptions = [
    "Node runs with garbage collection exposed, forces GC once before each sample, and performs no requested GC between measured calls.",
    "The V8 SamplingHeapProfiler books allocated bytes; heap delta is only a cross-check and is void when a GC event occurs.",
    "Profiler allocation is divided by the measured call count, and outputs are consumed inside the measured span.",
    "The sample is measurable only when profiled allocation exceeds one hundred times the stated sampling interval.",
    "RSS delta is a labeled proxy for inaccessible wasm linear-memory allocation, not a replacement for profiler bytes.",
    "Median absolute deviation is the noise estimator because the governing documents do not name one.",
  ];
  const limits = [
    "The installed package exposes no public linear-memory allocation counter.",
    "Cells unreachable at the requested tier or entry point are blocked rather than mapped to another path.",
    "GC event counts carry no byte quantity.",
    "Sampling starts at five, escalates to at most 128, stops when noise no longer shrinks, and observes a ten-minute backstop.",
  ];

  const cells = [];
  if (parameters.smoke) {
    cells.push({ id: "smoke", status: "not-booked", parameters: { operation, entry, tier, runtime: runtimeName, size, calls, samplingInterval }, result: null, noise: null });
  } else if (runtimeName !== "node") {
    cells.push({
      id: `${runtimeName}-${tier}-${entry}`,
      status: "blocked",
      parameters: { operation, entry, tier, runtime: runtimeName },
      result: null,
      noise: null,
      blocked: { reason: "allocation-counter-unavailable", needed: "A runtime allocation profiler equivalent to Node's inspector SamplingHeapProfiler." },
    });
  } else {
    if (!parameters.vocab) throw new Error("--vocab=<path> is required");
    const module = await importPublic(String(parameters.package ?? "hypertok"));
    let runtime;
    try {
      runtime = await module.fromBytes(fs.readFileSync(path.resolve(String(parameters.vocab))), { tier, workers: Number(parameters.workers ?? 1) });
    } catch (error) {
      cells.push({
        id: `${runtimeName}-${tier}-${entry}`,
        status: "blocked",
        parameters: { operation, entry, tier, runtime: runtimeName },
        result: null,
        noise: null,
        blocked: { reason: "public-cell-unreachable", needed: error.message },
      });
    }
    if (runtime) {
      const text = textFor(size, workload);
      const encoded = runtime.encodeSync(text);
      const ids = new Uint32Array(size).fill(encoded[0] ?? 0);
      const destination = new Uint32Array(Math.max(encoded.length + 8, 8));
      const call = async () => {
        if (entry === "encodeSync") return runtime.encodeSync(text).length;
        if (entry === "encode") return (await runtime.encode(text)).length;
        if (entry === "encodeInto") return runtime.encodeInto(text, destination);
        if (entry === "encodeDetailed") return (await runtime.encodeDetailed(text)).ids.length;
        if (entry === "decode") return runtime.decode(ids).length;
        throw new Error(`unsupported entry point: ${entry}`);
      };
      await call();

      const oneSample = async () => {
        global.gc();
        const beforeHeap = process.memoryUsage().heapUsed;
        const beforeRss = process.memoryUsage.rss();
        let gcCount = 0;
        const observer = new PerformanceObserver((list) => { gcCount += list.getEntries().length; });
        observer.observe({ entryTypes: ["gc"] });
        const session = new Session();
        session.connect();
        await post(session, "HeapProfiler.enable");
        await post(session, "HeapProfiler.startSampling", { samplingInterval });
        let checksum = 0;
        for (let index = 0; index < calls; index += 1) checksum ^= (await call()) + index;
        const profile = await post(session, "HeapProfiler.stopSampling");
        session.disconnect();
        observer.disconnect();
        const after = process.memoryUsage();
        const allocated = profileBytes(profile.profile.head);
        return {
          allocatedPerCall: allocated / calls,
          allocated,
          heapDeltaPerCall: gcCount === 0 ? (after.heapUsed - beforeHeap) / calls : null,
          rssProxyPerCall: (after.rss - beforeRss) / calls,
          gcCount,
          checksum,
        };
      };

      const samples = [];
      const started = performance.now();
      let target = minimum;
      let previousBand = null;
      let stop = "maximum-samples";
      while (samples.length < target) samples.push(await oneSample());
      while (samples.length < maximum) {
        const band = summarize(samples.map((sample) => sample.allocatedPerCall)).mad;
        if (previousBand !== null && band >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
        if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
        previousBand = band;
        target = Math.min(maximum, samples.length * 2 + 1);
        while (samples.length < target && performance.now() - started < backstopMs) samples.push(await oneSample());
      }
      const allocationQualified = samples.every((sample) => sample.allocated >= 100 * samplingInterval);
      const heapSamples = samples.map((sample) => sample.heapDeltaPerCall).filter((value) => value !== null);
      cells.push({
        id: `${runtimeName}-${tier}-${entry}-allocation`,
        status: allocationQualified ? (stop === "maximum-samples" ? "unresolved" : "measured") : "unmeasurable",
        parameters: { operation, entry, tier, runtime: runtimeName, size, workload, calls, samplingInterval, workers: Number(parameters.workers ?? 1) },
        result: {
          allocatedPerCall: measured(samples.map((sample) => sample.allocatedPerCall), "bytes/call"),
          heapDeltaCrossCheck: heapSamples.length === samples.length ? measured(heapSamples, "bytes/call") : null,
          rssLinearMemoryProxy: measured(samples.map((sample) => sample.rssProxyPerCall), "bytes/call"),
          gcEvents: measured(samples.map((sample) => sample.gcCount), "events/sample"),
        },
        sampling: { initial: minimum, reached: samples.length, maximum, stop, elapsedMs: performance.now() - started },
        blocked: allocationQualified ? undefined : { reason: "allocation-span-below-profiler-resolution", needed: `At least ${100 * samplingInterval} sampled bytes per span.` },
      });
      runtime.free();
    }
  }

  for (const cell of cells) { cell.assumptions = assumptions; cell.limits = limits; }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    instrument: 7,
    subject: "per-call allocation",
    axes: [11],
    mode: parameters.smoke ? "smoke" : "measure",
    parameters: { ...parameters, operation, entry, tier, runtime: runtimeName, size, calls, samplingInterval, minimum, maximum, backstopMs, workload },
    cells,
    assumptions,
    limits,
  }, null, 2)}\n`);
}
