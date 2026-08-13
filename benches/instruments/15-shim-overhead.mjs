#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

async function importPublic(specifier) {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) return import(pathToFileURL(path.resolve(specifier)).href);
  return import(specifier);
}

async function pairSample(first, second, batch, reverse) {
  const order = reverse ? [["second", second], ["first", first]] : [["first", first], ["second", second]];
  const elapsed = {};
  for (const [name, call] of order) {
    const begin = performance.now();
    let checksum = 0;
    for (let index = 0; index < batch; index += 1) checksum ^= call() + index;
    elapsed[name] = { ns: ((performance.now() - begin) * 1e6) / batch, checksum };
  }
  return { firstNs: elapsed.first.ns, secondNs: elapsed.second.ns, deltaNs: elapsed.first.ns - elapsed.second.ns };
}

async function adaptivePair(makeSample, minimum, maximum, backstopMs) {
  const samples = [];
  const started = performance.now();
  let target = minimum;
  let previousBand = null;
  let stop = "maximum-samples";
  while (samples.length < target) samples.push(await makeSample(samples.length));
  while (samples.length < maximum) {
    const first = summarize(samples.map((sample) => sample.firstNs));
    const second = summarize(samples.map((sample) => sample.secondNs));
    const gap = Math.abs(median(samples.map((sample) => sample.deltaNs)));
    const combined = Math.hypot(first.mad, second.mad);
    const projected = gap === 0 ? Number.POSITIVE_INFINITY : samples.length * ((2 * combined) / gap) ** 2;
    if (gap > 2 * combined) { stop = "resolved"; break; }
    if (projected > maximum) { stop = "projected-resolution-exceeds-128"; break; }
    const band = summarize(samples.map((sample) => sample.deltaNs)).mad;
    if (previousBand !== null && band >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
    if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
    previousBand = band;
    target = Math.min(maximum, samples.length * 2 + 1);
    while (samples.length < target && performance.now() - started < backstopMs) samples.push(await makeSample(samples.length));
  }
  return { samples, stop, elapsedMs: performance.now() - started };
}

const parameters = parseArgs(process.argv.slice(2));
const packageName = String(parameters.package ?? "hypertok");
const runtimeName = String(parameters.runtime ?? "node");
const text = String(parameters.text ?? "The public shim measures the same semantic encode call.");
const batch = Number(parameters.batch ?? 1000);
const decodeSizes = String(parameters["decode-sizes"] ?? "1,8,32,128,512").split(",").map(Number);
const minimum = Number(parameters.minimum ?? 5);
const maximum = Number(parameters.maximum ?? 128);
const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
const assumptions = [
  "Every shim and native leg is created from the installed package public exports and one resident single-tier public runtime.",
  "The tiktoken ids-only row uses encode_ordinary and compares with public encodeSync carrying the exact semantic reserved policy object: match empty and refuse empty.",
  "The Hugging Face ids-only row uses huggingface-lazy and reads ids only; tokens and attention_mask remain unread.",
  "The Hugging Face setup pins identity postProcess and tokenString closures, which remain inside the measured shim call.",
  "Eager minus lazy is labeled materialization, and the eager row books lazy overhead plus that materialization rather than inventing an independent overhead recipe.",
  "Hugging Face decode compares with public core.decode, then fits fixed dispatch intercept and per-id tokenString, filter, and cleanup work over the stated id-count sweep.",
  "Median absolute deviation is the noise estimator because the governing documents do not name one.",
];
const limits = [
  "Tiktoken decode returns bytes while the public native decode returns a string, so that cell is blocked.",
  "Hugging Face eager encoding always materializes tokens and attention_mask; it cannot serve as an ids-only leg.",
  "All cells are single-tier because the public shims require a resident single runtime.",
  "Sampling starts at five, escalates until paired resolution or futility at 128, and observes a ten-minute backstop.",
];

const cells = [];
if (parameters.smoke) {
  cells.push({ id: "smoke", status: "not-booked", parameters: { packageName, runtime: runtimeName, batch, decodeSizes }, result: null, noise: null });
} else if (runtimeName !== "node") {
  cells.push({ id: `${runtimeName}-shim-overhead`, status: "blocked", parameters: { runtime: runtimeName }, result: null, noise: null, blocked: { reason: "runtime-driver-unavailable", needed: "Run the same installed-package public modules in the named runtime." } });
} else {
  if (!parameters.vocab) throw new Error("--vocab=<path> is required");
  if (batch < 1) throw new Error("--batch must be positive");
  const runtimeModule = await importPublic(packageName);
  const tiktokenModule = await importPublic(`${packageName}/tiktoken`);
  const eagerModule = await importPublic(`${packageName}/huggingface`);
  const lazyModule = await importPublic(`${packageName}/huggingface-lazy`);
  const runtime = await runtimeModule.fromBytes(fs.readFileSync(path.resolve(String(parameters.vocab))), { tier: "single" });
  const decoder = new TextDecoder();
  const tokenString = (id) => {
    try { return decoder.decode(runtime.tokenBytes(id)); } catch { return undefined; }
  };
  const setup = {
    tokenString,
    postProcess(first, second) {
      return { ids: second === null ? Array.from(first) : [...first, ...second] };
    },
    specialTokens: [],
    unknownTokenId: 0,
    cleanUpTokenizationSpaces: true,
  };
  const tiktoken = tiktokenModule.createTiktokenShim(runtime);
  const eager = eagerModule.createHuggingFaceShim(runtime, setup);
  const lazy = lazyModule.createLazyHuggingFaceShim(runtime, setup);
  const nativePolicy = { reserved: { match: [], refuse: [] } };
  try {
    const tiktokenRows = await adaptivePair(
      (round) => pairSample(
        () => tiktoken.encode_ordinary(text).length,
        () => runtime.encodeSync(text, nativePolicy).length,
        batch,
        round % 2 === 1,
      ), minimum, maximum, backstopMs,
    );
    cells.push({
      id: "tiktoken-encode",
      status: tiktokenRows.stop === "resolved" ? "measured" : "unresolved",
      parameters: { module: `${packageName}/tiktoken`, operation: "encode", nativeEntry: "encodeSync", reservedPolicy: nativePolicy.reserved, batch },
      result: {
        shimCost: measured(tiktokenRows.samples.map((sample) => sample.firstNs), "ns/call"),
        nativeCost: measured(tiktokenRows.samples.map((sample) => sample.secondNs), "ns/call"),
        overhead: measured(tiktokenRows.samples.map((sample) => sample.deltaNs), "ns/call"),
      },
      sampling: { initial: minimum, reached: tiktokenRows.samples.length, maximum, stop: tiktokenRows.stop, elapsedMs: tiktokenRows.elapsedMs },
    });

    const lazyRows = await adaptivePair(
      (round) => pairSample(
        () => lazy.encode(text).ids.length,
        () => runtime.encodeSync(text).length,
        batch,
        round % 2 === 1,
      ), minimum, maximum, backstopMs,
    );
    cells.push({
      id: "huggingface-lazy-encode-ids",
      status: lazyRows.stop === "resolved" ? "measured" : "unresolved",
      parameters: { module: `${packageName}/huggingface-lazy`, operation: "encode", read: ["ids"], unread: ["tokens", "attention_mask"], batch },
      result: {
        shimCost: measured(lazyRows.samples.map((sample) => sample.firstNs), "ns/call"),
        nativeCost: measured(lazyRows.samples.map((sample) => sample.secondNs), "ns/call"),
        overhead: measured(lazyRows.samples.map((sample) => sample.deltaNs), "ns/call"),
      },
      sampling: { initial: minimum, reached: lazyRows.samples.length, maximum, stop: lazyRows.stop, elapsedMs: lazyRows.elapsedMs },
    });

    const materializationRows = await adaptivePair(
      (round) => pairSample(
        () => {
          const value = eager.encode(text);
          return value.ids.length + value.tokens.length + value.attention_mask.length;
        },
        () => lazy.encode(text).ids.length,
        batch,
        round % 2 === 1,
      ), minimum, maximum, backstopMs,
    );
    cells.push({
      id: "huggingface-eager-encode",
      status: materializationRows.stop === "resolved" ? "measured" : "unresolved",
      parameters: { module: `${packageName}/huggingface`, operation: "encode", materializes: ["tokens", "attention_mask"], batch },
      result: {
        eagerCost: measured(materializationRows.samples.map((sample) => sample.firstNs), "ns/call"),
        lazyCost: measured(materializationRows.samples.map((sample) => sample.secondNs), "ns/call"),
        materialization: measured(materializationRows.samples.map((sample) => sample.deltaNs), "ns/call"),
        overheadRecipe: "huggingface-lazy overhead plus eager-minus-lazy materialization",
      },
      sampling: { initial: minimum, reached: materializationRows.samples.length, maximum, stop: materializationRows.stop, elapsedMs: materializationRows.elapsedMs },
    });

    const sourceIds = Array.from(runtime.encodeSync(text));
    const decodeSamples = [];
    const started = performance.now();
    let target = minimum;
    let previousBand = null;
    let stop = "maximum-samples";
    const takeDecode = (round) => {
      const points = [];
      for (const count of decodeSizes) {
        const ids = Array.from({ length: count }, (_, index) => sourceIds[index % sourceIds.length]);
        const order = round % 2 ? [["shim", () => eager.decode(ids).length], ["native", () => runtime.decode(ids).length]] : [["native", () => runtime.decode(ids).length], ["shim", () => eager.decode(ids).length]];
        const elapsed = {};
        for (const [name, call] of order) {
          const begin = performance.now();
          let checksum = 0;
          for (let index = 0; index < batch; index += 1) checksum ^= call() + index;
          elapsed[name] = ((performance.now() - begin) * 1e6) / batch;
        }
        points.push({ x: count, y: elapsed.shim - elapsed.native });
      }
      const fit = regression(points);
      return { fixedNs: fit.intercept, perIdNs: fit.slope };
    };
    while (decodeSamples.length < target) decodeSamples.push(takeDecode(decodeSamples.length));
    while (decodeSamples.length < maximum) {
      const band = summarize(decodeSamples.map((sample) => sample.fixedNs)).mad;
      if (previousBand !== null && band >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
      if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
      previousBand = band;
      target = Math.min(maximum, decodeSamples.length * 2 + 1);
      while (decodeSamples.length < target && performance.now() - started < backstopMs) decodeSamples.push(takeDecode(decodeSamples.length));
    }
    cells.push({
      id: "huggingface-decode",
      status: stop === "maximum-samples" ? "unresolved" : "measured",
      parameters: { module: `${packageName}/huggingface`, operation: "decode", nativeEntry: "decode", idCounts: decodeSizes, batch, skipSpecialTokens: false, cleanUpTokenizationSpaces: true },
      result: {
        fixedDispatch: measured(decodeSamples.map((sample) => sample.fixedNs), "ns/call"),
        perIdMappingFilterCleanup: measured(decodeSamples.map((sample) => sample.perIdNs), "ns/id"),
      },
      sampling: { initial: minimum, reached: decodeSamples.length, maximum, stop, elapsedMs: performance.now() - started },
    });
    cells.push({ id: "tiktoken-decode", status: "blocked", parameters: { module: `${packageName}/tiktoken`, operation: "decode" }, result: null, noise: null, blocked: { reason: "return-type-mismatch", needed: "A public bytes-returning native decode leg; the shipped public runtime returns a string." } });
  } finally {
    runtime.free();
  }
}

for (const cell of cells) { cell.assumptions = assumptions; cell.limits = limits; }
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, instrument: 15, subject: "shim overhead", axes: [18], mode: parameters.smoke ? "smoke" : "measure", parameters: { ...parameters, packageName, runtime: runtimeName, batch, decodeSizes, minimum, maximum, backstopMs }, cells, assumptions, limits }, null, 2)}\n`);
