#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  const seeds = {
    prose: "The tokenizer measures public calls over representative prose. ",
    code: "const token = encode(input);\n",
    CJK: "漢字仮名交じり文。",
    emoji: "🙂🚀🧪",
    mixed: "Text 漢字 🙂 const x = 1; ",
  };
  const seed = seeds[workload] ?? seeds.prose;
  let value = "";
  while (Buffer.byteLength(value) < bytes) value += seed;
  while (Buffer.byteLength(value) > bytes) value = value.slice(0, -1);
  return value;
}

async function subject(payload) {
  const module = await importPublic(payload.package);
  const bytes = fs.readFileSync(payload.vocab);
  if (payload.mode === "construction") {
    process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, payload.leadMs));
    const begin = performance.now();
    const runtime = await module.fromBytes(bytes, { tier: "single" });
    const spanMs = performance.now() - begin;
    process.stdout.write(`${JSON.stringify({ event: "done", spanMs, checksum: runtime.vocabSize })}\n`);
    runtime.free();
    return;
  }
  const runtime = await module.fromBytes(bytes, { tier: "single" });
  const text = textFor(payload.size, payload.workload);
  const encoded = runtime.encodeSync(text);
  const ids = new Uint32Array(payload.size).fill(encoded[0] ?? 0);
  const destination = new Uint32Array(Math.max(encoded.length + 8, 8));
  process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, payload.leadMs));
  const begin = performance.now();
  let output;
  if (payload.entry === "encodeSync") output = runtime.encodeSync(text);
  else if (payload.entry === "encode") output = await runtime.encode(text);
  else if (payload.entry === "encodeInto") output = await runtime.encodeInto(text, destination);
  else if (payload.entry === "encodeDetailed") output = await runtime.encodeDetailed(text);
  else if (payload.entry === "decode") output = runtime.decode(ids);
  else throw new Error(`unsupported entry point: ${payload.entry}`);
  const spanMs = performance.now() - begin;
  const checksum = typeof output === "string" ? output.length : typeof output === "number" ? output : output.ids?.length ?? output.length;
  process.stdout.write(`${JSON.stringify({ event: "done", spanMs, checksum })}\n`);
  runtime.free();
}

const subjectArgument = process.argv.find((argument) => argument.startsWith("--subject="));
if (subjectArgument) {
  try {
    await subject(JSON.parse(Buffer.from(subjectArgument.slice(10), "base64url").toString("utf8")));
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
} else {
  const parameters = parseArgs(process.argv.slice(2));
  const mode = String(parameters.mode ?? "construction");
  const tier = String(parameters.tier ?? "single");
  const runtimeName = String(parameters.runtime ?? "node");
  const intervalMs = Number(parameters["interval-ms"] ?? (process.platform === "win32" ? 100 : 10));
  const minimum = Number(parameters.minimum ?? 5);
  const maximum = Number(parameters.maximum ?? 128);
  const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
  const assumptions = [
    "A sampler process polls the subject process RSS around exactly one public construction or public call.",
    "High-water RSS equals the maximum sampled RSS minus the pre-operation sampled RSS.",
    "The cell books only when the measured operation span is at least one hundred times the stated polling interval.",
    "Construction samples and call samples each use a fresh subject process.",
    "Median absolute deviation is the noise estimator because the governing documents do not name one.",
  ];
  const limits = [
    "RSS sampling is available only on Node-class hosts exposing process RSS.",
    "Browser cells are blocked pending a qualified browser memory seam.",
    "Worker and shared tiers are blocked on the same browser memory seam.",
    "Sub-threshold spans are reported as unmeasurable rather than extrapolated.",
    "Sampling starts at five, escalates to at most 128, stops when noise no longer shrinks, and observes a ten-minute backstop.",
  ];

  function rss(pid) {
    if (process.platform === "linux") {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      return match ? Number(match[1]) * 1024 : null;
    }
    if (process.platform === "darwin") {
      const run = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
      return run.status === 0 ? Number(run.stdout.trim()) * 1024 : null;
    }
    if (process.platform === "win32") {
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`;
      const run = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true });
      return run.status === 0 ? Number(run.stdout.trim()) : null;
    }
    return null;
  }

  function oneSample() {
    return new Promise((resolve, reject) => {
      const payload = {
        package: String(parameters.package ?? "hypertok"),
        vocab: path.resolve(String(parameters.vocab)),
        mode,
        entry: String(parameters.entry ?? "encodeSync"),
        size: Number(parameters.size ?? 1048576),
        workload: String(parameters.workload ?? "prose"),
        leadMs: Math.max(500, intervalMs * 5),
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--subject=${encoded}`], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      let pre = null;
      let peak = 0;
      let done = null;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        for (;;) {
          const newline = stdout.indexOf("\n");
          if (newline === -1) break;
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.event === "ready") {
            pre = rss(child.pid);
            if (pre !== null) peak = Math.max(peak, pre);
          }
          if (event.event === "done") done = event;
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const poll = setInterval(() => {
        const value = rss(child.pid);
        if (value !== null) peak = Math.max(peak, value);
      }, intervalMs);
      child.on("error", reject);
      child.on("close", (code) => {
        clearInterval(poll);
        if (code !== 0 || !done || pre === null) {
          reject(new Error(stderr || "RSS subject failed or exposed no RSS sample"));
          return;
        }
        resolve({ highWaterBytes: Math.max(0, peak - pre), spanMs: done.spanMs, checksum: done.checksum });
      });
    });
  }

  const cells = [];
  if (parameters.smoke) {
    cells.push({ id: "smoke", status: "not-booked", parameters: { mode, tier, runtime: runtimeName, intervalMs }, result: null, noise: null });
  } else if (runtimeName !== "node" || tier !== "single") {
    cells.push({
      id: `${runtimeName}-${tier}-${mode}`,
      status: "blocked",
      parameters: { mode, tier, runtime: runtimeName, intervalMs },
      result: null,
      noise: null,
      blocked: { reason: "browser-memory-seam-unqualified", needed: "A browser process RSS seam for worker, shared, or browser-host cells." },
    });
  } else {
    if (!parameters.vocab) throw new Error("--vocab=<path> is required");
    const samples = [];
    const started = performance.now();
    let target = minimum;
    let previousBand = null;
    let stop = "maximum-samples";
    while (samples.length < target) samples.push(await oneSample());
    while (samples.length < maximum) {
      const band = summarize(samples.map((sample) => sample.highWaterBytes)).mad;
      if (previousBand !== null && band >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
      if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
      previousBand = band;
      target = Math.min(maximum, samples.length * 2 + 1);
      while (samples.length < target && performance.now() - started < backstopMs) samples.push(await oneSample());
    }
    const spanQualified = samples.every((sample) => sample.spanMs >= 100 * intervalMs);
    cells.push({
      id: `node-${mode}-high-water`,
      status: spanQualified ? (stop === "maximum-samples" ? "unresolved" : "measured") : "unmeasurable",
      parameters: { mode, tier, runtime: runtimeName, intervalMs, entry: parameters.entry ?? null, size: Number(parameters.size ?? 1048576), workload: parameters.workload ?? "prose" },
      result: {
        highWater: measured(samples.map((sample) => sample.highWaterBytes), "bytes"),
        operationSpan: measured(samples.map((sample) => sample.spanMs), "ms"),
      },
      sampling: { initial: minimum, reached: samples.length, maximum, stop, elapsedMs: performance.now() - started },
      blocked: spanQualified ? undefined : { reason: "span-below-sampler-resolution", needed: `An operation span of at least ${100 * intervalMs} ms at the stated interval.` },
    });
  }

  for (const cell of cells) { cell.assumptions = assumptions; cell.limits = limits; }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    instrument: 6,
    subject: "high-water RSS",
    axes: [10, 12],
    mode: parameters.smoke ? "smoke" : "measure",
    parameters: { ...parameters, mode, tier, runtime: runtimeName, intervalMs, minimum, maximum, backstopMs },
    cells,
    assumptions,
    limits,
  }, null, 2)}\n`);
}
