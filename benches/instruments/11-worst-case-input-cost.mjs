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

async function importPublic(specifier) {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) return import(pathToFileURL(path.resolve(specifier)).href);
  return import(specifier);
}

function exactBytes(text, target) {
  let output = text;
  while (Buffer.byteLength(output) < target) output += text;
  while (Buffer.byteLength(output) > target) output = output.slice(0, -1);
  return output;
}

function encodeClasses(bytes) {
  const prose = exactBytes("The public tokenizer processes representative prose with ordinary punctuation. ", bytes);
  const sprinkled = Array.from({ length: Math.max(1, Math.ceil(bytes / 100)) }, (_, index) => index % 2 ? "a".repeat(99) + "漢" : "a".repeat(99) + "🙂").join("");
  return {
    prose,
    "uniform-runs": exactBytes("a", bytes),
    "mixed-script": exactBytes("English 漢字 русский العربية 🙂 code_1; ", bytes),
    "sprinkled-non-ascii": exactBytes(sprinkled, bytes),
    "pathological-whitespace": exactBytes(" \t\n\r\v\f", bytes),
  };
}

function decodeClasses(runtime, count) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const clean = [];
  const dirty = [];
  let longest = { id: 0, bytes: 0 };
  for (let id = 0; id < runtime.vocabSize; id += 1) {
    const bytes = runtime.tokenBytes(id);
    if (bytes.length > longest.bytes) longest = { id, bytes: bytes.length };
    try { decoder.decode(bytes); clean.push(id); } catch { dirty.push(id); }
  }
  const cleanId = clean[0] ?? 0;
  const dirtyId = dirty[0];
  const fill = (id) => new Uint32Array(count).fill(id);
  const classes = {
    prose: Uint32Array.from(Array.from({ length: count }, (_, index) => clean[index % clean.length] ?? cleanId)),
    "uniform-runs": fill(cleanId),
    "max-length-tokens": fill(longest.id),
  };
  if (dirtyId !== undefined) {
    classes["all-dirty-runs"] = fill(dirtyId);
    classes["maximal-alternation"] = Uint32Array.from(Array.from({ length: count }, (_, index) => index % 2 ? dirtyId : cleanId));
  }
  return { classes, dirtyTokenCount: dirty.length, cleanTokenCount: clean.length, longest };
}

const parameters = parseArgs(process.argv.slice(2));
const runtimeName = String(parameters.runtime ?? "node");
const operation = String(parameters.operation ?? "encode");
const entry = String(parameters.entry ?? (operation === "decode" ? "decode" : "encodeSync"));
const tier = String(parameters.tier ?? "single");
const batch = Number(parameters.batch ?? 100);
const bytes = Number(parameters.bytes ?? 1048576);
const idCount = Number(parameters.ids ?? 65536);
const minimum = Number(parameters.minimum ?? 5);
const maximum = Number(parameters.maximum ?? 128);
const backstopMs = Number(parameters["backstop-ms"] ?? 600000);
const assumptions = [
  "Every cell pairs one adversarial class with the prose referent through the same installed-package public entry point in one warmed process.",
  "Encode ratios divide elapsed time by measured UTF-8 input bytes for each class.",
  "Decode holds id count fixed, divides elapsed time by measured decoded output bytes, and reports output bytes beside the ratio.",
  "Decode all-dirty uses ids whose public tokenBytes fail fatal UTF-8 decoding; maximal alternation flips clean and dirty each id.",
  "Uniform decode repeats one clean id, and max-length decode repeats the vocabulary token with the longest public byte payload.",
  "Median absolute deviation is the noise estimator because the governing documents do not name one.",
];
const limits = [
  "Worker and shared cells are blocked because silent calling-thread fallback can reverse the ratio and no public fallback signal exists.",
  "The prose referent and adversarial generators are deterministic fixtures declared by the report, not universal language distributions.",
  "Sampling starts at five and escalates until the paired gap resolves or futility projects above 128, noise stops shrinking, or ten minutes elapse.",
  "A vocabulary with no dirty token blocks the dirty-only decode classes without blocking uniform or max-length classes.",
];

const cells = [];
if (parameters.smoke) {
  cells.push({ id: "smoke", status: "not-booked", parameters: { runtime: runtimeName, operation, entry, tier, batch, bytes, idCount }, result: null, noise: null });
} else if (tier !== "single") {
  cells.push({ id: `${tier}-${operation}`, status: "blocked", parameters: { runtime: runtimeName, operation, entry, tier }, result: null, noise: null, blocked: { reason: "silent-fallback-can-flip-ratio", needed: "A public signal proving off-thread service for every sample." } });
} else if (runtimeName !== "node") {
  cells.push({ id: `${runtimeName}-${operation}`, status: "blocked", parameters: { runtime: runtimeName, operation, entry, tier }, result: null, noise: null, blocked: { reason: "runtime-driver-unavailable", needed: "Run this public-call method under a driver for the named runtime." } });
} else {
  if (!parameters.vocab) throw new Error("--vocab=<path> is required");
  const module = await importPublic(String(parameters.package ?? "hypertok"));
  const runtime = await module.fromBytes(fs.readFileSync(path.resolve(String(parameters.vocab))), { tier: "single" });
  try {
    let classes;
    let decodeMetadata = null;
    if (operation === "encode") classes = encodeClasses(bytes);
    else {
      decodeMetadata = decodeClasses(runtime, idCount);
      classes = decodeMetadata.classes;
    }
    const referent = classes.prose;
    const outputBytes = new Map();
    const destinations = new Map();
    if (entry === "encodeInto") {
      for (const input of Object.values(classes)) {
        destinations.set(input, new Uint32Array(runtime.encodeSync(input).length + 8));
      }
    }
    const call = async (input) => {
      if (entry === "encodeSync") return runtime.encodeSync(input).length;
      if (entry === "encode") return (await runtime.encode(input)).length;
      if (entry === "encodeDetailed") return (await runtime.encodeDetailed(input)).ids.length;
      if (entry === "encodeInto") {
        return runtime.encodeInto(input, destinations.get(input));
      }
      if (entry === "decode") {
        const decoded = runtime.decode(input);
        outputBytes.set(input, Buffer.byteLength(decoded));
        return decoded.length;
      }
      throw new Error(`unsupported entry point: ${entry}`);
    };
    for (const input of Object.values(classes)) await call(input);

    for (const [className, classInput] of Object.entries(classes)) {
      if (className === "prose") continue;
      const samples = [];
      const started = performance.now();
      let target = minimum;
      let previousBand = null;
      let stop = "maximum-samples";
      const take = async (round) => {
        const order = round % 2 ? [[className, classInput], ["prose", referent]] : [["prose", referent], [className, classInput]];
        const times = {};
        for (const [name, input] of order) {
          const begin = performance.now();
          let checksum = 0;
          for (let index = 0; index < batch; index += 1) checksum ^= (await call(input)) + index;
          times[name] = { ms: performance.now() - begin, checksum };
        }
        const classUnits = operation === "encode" ? Buffer.byteLength(classInput) : outputBytes.get(classInput);
        const referenceUnits = operation === "encode" ? Buffer.byteLength(referent) : outputBytes.get(referent);
        const classCost = times[className].ms / classUnits;
        const referenceCost = times.prose.ms / referenceUnits;
        return { ratio: classCost / referenceCost, classMs: times[className].ms, referenceMs: times.prose.ms, classUnits, referenceUnits };
      };
      while (samples.length < target) samples.push(await take(samples.length));
      while (samples.length < maximum) {
        const ratioNoise = summarize(samples.map((sample) => sample.ratio));
        const effect = Math.abs(Math.log(Math.max(Number.MIN_VALUE, ratioNoise.median)));
        const relative = ratioNoise.relativeMad ?? Number.POSITIVE_INFINITY;
        const projected = effect === 0 ? Number.POSITIVE_INFINITY : samples.length * ((2 * relative) / effect) ** 2;
        if (effect > 2 * relative) { stop = "resolved"; break; }
        if (projected > maximum) { stop = "projected-resolution-exceeds-128"; break; }
        if (previousBand !== null && ratioNoise.mad >= previousBand * 0.95) { stop = "noise-stopped-shrinking"; break; }
        if (performance.now() - started >= backstopMs) { stop = "ten-minute-backstop"; break; }
        previousBand = ratioNoise.mad;
        target = Math.min(maximum, samples.length * 2 + 1);
        while (samples.length < target && performance.now() - started < backstopMs) samples.push(await take(samples.length));
      }
      cells.push({
        id: `${runtimeName}-${operation}-${className}`,
        status: stop === "resolved" ? "measured" : "unresolved",
        parameters: {
          runtime: runtimeName, operation, entry, tier, class: className, referent: "prose", batch,
          inputBytes: operation === "encode" ? Buffer.byteLength(classInput) : null,
          idCount: operation === "decode" ? classInput.length : null,
          outputBytes: operation === "decode" ? outputBytes.get(classInput) : null,
          dirtyFraction: operation === "decode" && className === "all-dirty-runs" ? 1 : operation === "decode" && className === "maximal-alternation" ? 0.5 : null,
        },
        result: {
          adversarialOverNominal: measured(samples.map((sample) => sample.ratio), "ratio"),
          adversarialTime: measured(samples.map((sample) => sample.classMs), "ms/batch"),
          nominalTime: measured(samples.map((sample) => sample.referenceMs), "ms/batch"),
        },
        sampling: { initial: minimum, reached: samples.length, maximum, stop, elapsedMs: performance.now() - started },
      });
    }
    if (operation === "decode" && decodeMetadata.dirtyTokenCount === 0) {
      for (const className of ["all-dirty-runs", "maximal-alternation"]) {
        cells.push({ id: `${runtimeName}-decode-${className}`, status: "blocked", parameters: { class: className }, result: null, noise: null, blocked: { reason: "vocabulary-has-no-dirty-token", needed: "At least one token whose public bytes fail fatal UTF-8 decoding." } });
      }
    }
  } finally {
    runtime.free();
  }
}

for (const cell of cells) { cell.assumptions = assumptions; cell.limits = limits; }
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, instrument: 11, subject: "worst-case input cost", axes: [15], mode: parameters.smoke ? "smoke" : "measure", parameters: { ...parameters, runtime: runtimeName, operation, entry, tier, batch, bytes, idCount, minimum, maximum, backstopMs }, cells, assumptions, limits }, null, 2)}\n`);
