import { summarize } from "./timing.mjs";
import { agreementForRow } from "./agreement_receipt.mjs";

export function benchmarkProfile(environment = process.env) {
  const profile = environment.HYPERTOK_BENCH_PROFILE ?? "arena";
  if (!["arena", "shipping"].includes(profile)) {
    throw new Error(`Unknown benchmark profile: ${profile}`);
  }
  return profile;
}

export function benchmarkMode(environment = process.env) {
  const mode = environment.HYPERTOK_BENCH_MODE ?? "full";
  if (!["smoke", "full"].includes(mode)) {
    throw new Error(`Unknown benchmark mode: ${mode}`);
  }
  return mode;
}

export function benchmarkConfiguration(environment = process.env) {
  const profile = benchmarkProfile(environment);
  const mode = benchmarkMode(environment);
  const n = Number(environment.HYPERTOK_BENCH_N ?? 21);
  const warmup = Number(environment.HYPERTOK_BENCH_WARMUP ?? 2);
  const targetBytesPerSample = Number(
    environment.HYPERTOK_BENCH_TARGET_BYTES ?? 262_144,
  );
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(warmup) || warmup < 0) {
    throw new Error("Benchmark n and warmup must be non-negative integers with n at least one");
  }
  if (!Number.isSafeInteger(targetBytesPerSample) || targetBytesPerSample < 1) {
    throw new Error("Benchmark target bytes must be a positive safe integer");
  }
  return Object.freeze({
    profile,
    mode,
    n,
    warmup,
    targetBytesPerSample,
    decodeContainerRegimes: DECODE_CONTAINER_REGIMES,
  });
}

export function iterationsForWorkload(bytes, targetBytesPerSample) {
  return Math.max(1, Math.min(512, Math.ceil(targetBytesPerSample / bytes)));
}

export async function measureEncodeThroughput(adapter, workload, configuration) {
  const iterations = iterationsForWorkload(
    workload.bytes,
    configuration.targetBytesPerSample,
  );
  let lastIds = new Uint32Array();
  for (let sample = 0; sample < configuration.warmup; sample += 1) {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      lastIds = adapter.encode(workload.text);
    }
  }

  const megabytesPerSecond = [];
  for (let sample = 0; sample < configuration.n; sample += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      lastIds = adapter.encode(workload.text);
    }
    const elapsedMilliseconds = performance.now() - started;
    if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) {
      throw new Error(`Invalid encode duration: ${elapsedMilliseconds}`);
    }
    megabytesPerSecond.push(
      (workload.bytes * iterations) / (elapsedMilliseconds * 1_000),
    );
  }

  return Object.freeze({
    iterationsPerSample: iterations,
    bytesPerSample: workload.bytes * iterations,
    tokenCount: lastIds.length,
    statistics: summarize(megabytesPerSecond),
  });
}

/* Decode ids arrive from the wire in each library's natural container: ordinary
   arrays for the references whose documented input is JSON-shaped, typed arrays
   for the wasm-backed references that take them. Field calls are document
   sized, so the workload is split at character boundaries into segments near
   this byte target and each timed iteration decodes every segment. */
export const DECODE_FIELD_SEGMENT_BYTES = 4_096;
export const DECODE_CONTAINER_REGIMES = Object.freeze(["repeated", "fresh"]);
export const ORDINARY_ID_REFERENCES = Object.freeze([
  "@huggingface/tokenizers",
  "gpt-tokenizer",
  "js-tiktoken",
  "@lenml/tokenizers",
  "hypertok",
]);

export function decodeFieldSegments(text, targetBytes = DECODE_FIELD_SEGMENT_BYTES) {
  const segments = [];
  let current = "";
  let currentBytes = 0;
  for (const scalar of text) {
    const codePoint = scalar.codePointAt(0);
    current += scalar;
    currentBytes +=
      codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (currentBytes >= targetBytes) {
      segments.push(current);
      current = "";
      currentBytes = 0;
    }
  }
  if (current.length !== 0) segments.push(current);
  return segments;
}

function decodeContainerRegime(value) {
  if (!DECODE_CONTAINER_REGIMES.includes(value)) {
    throw new TypeError("decode container regime must be repeated or fresh");
  }
  return value;
}

function cloneTokenIds(ids) {
  return ids.slice();
}

export async function measureDecodeThroughput(
  adapter,
  workload,
  configuration,
  containerRegime = "repeated",
) {
  decodeContainerRegime(containerRegime);
  const ordinary = ORDINARY_ID_REFERENCES.includes(adapter.id);
  const segments = decodeFieldSegments(workload.text).map((segmentText) => {
    const encoded = adapter.encode(segmentText);
    const ids = ordinary ? Array.from(encoded) : encoded;
    const decoded = adapter.decode(ids);
    if (decoded !== segmentText) {
      throw new Error(`${adapter.id} ${workload.id}: decoded text mismatch`);
    }
    return ids;
  });
  const tokenCount = segments.reduce((sum, ids) => sum + ids.length, 0);
  const freshInputs = containerRegime === "fresh"
    ? Array.from(
        { length: configuration.warmup + configuration.n },
        () => segments.map(cloneTokenIds),
      )
    : null;

  let lastText = "";
  for (let sample = 0; sample < configuration.warmup; sample += 1) {
    const inputs = freshInputs === null ? segments : freshInputs[sample];
    for (const ids of inputs) lastText = adapter.decode(ids);
  }

  const megabytesPerSecond = [];
  for (let sample = 0; sample < configuration.n; sample += 1) {
    const inputs = freshInputs === null
      ? segments
      : freshInputs[configuration.warmup + sample];
    const started = performance.now();
    for (const ids of inputs) lastText = adapter.decode(ids);
    const elapsedMilliseconds = performance.now() - started;
    if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) {
      throw new Error(`Invalid decode duration: ${elapsedMilliseconds}`);
    }
    megabytesPerSecond.push(workload.bytes / (elapsedMilliseconds * 1_000));
  }

  if (typeof lastText !== "string" || lastText.length === 0) {
    throw new Error(`${adapter.id} ${workload.id}: timed decode produced no text`);
  }

  return Object.freeze({
    iterationsPerSample: segments.length,
    bytesPerSample: workload.bytes,
    tokenCount,
    containerRegime,
    exact: true,
    statistics: summarize(megabytesPerSecond),
  });
}

export function addHypertokRatios(rows, agreementReceipt) {
  if (agreementReceipt === undefined) {
    throw new Error("Throughput ratios require an agreement receipt");
  }
  const medians = new Map(
    rows
      .filter(({ reference, status }) => reference === "hypertok" && status === "measured")
      .map((row) => [
        `${row.vocabulary}\u0000${row.workload}\u0000${row.containerRegime ?? ""}`,
        row.median,
      ]),
  );
  return rows.map((row) => {
    const agreement = agreementForRow(
      agreementReceipt,
      row.vocabulary,
      row.workload,
      row.reference,
    );
    if (agreement.referenceVersion !== row.referenceVersion) {
      throw new Error(`Agreement version mismatch for ${row.reference}`);
    }
    return {
      ...row,
      agreementKey: agreementReceipt.agreementKey,
      comparisonStatus: agreement.status,
      ratio:
        row.status === "measured" && agreement.status === "identical"
          ? medians.get(
              `${row.vocabulary}\u0000${row.workload}\u0000${row.containerRegime ?? ""}`,
            ) / row.median
          : null,
    };
  });
}
