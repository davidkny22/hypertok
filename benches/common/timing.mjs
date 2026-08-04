export const axisNames = Object.freeze([
  "transfer",
  "decompression",
  "materialisation",
  "encode",
]);

export function summarize(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("Timing samples must be a non-empty array");
  }
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("Timing samples must be finite and non-negative");
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const variance =
    samples.reduce((sum, sample) => sum + (sample - mean) ** 2, 0) / samples.length;
  return Object.freeze({ n: samples.length, median, p95, variance });
}

export async function measureOperation(
  operation,
  { n = 31, warmup = 5, clock = performance } = {},
) {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(warmup) || warmup < 0) {
    throw new Error("Timing counts must be non-negative integers with n at least one");
  }
  for (let index = 0; index < warmup; index += 1) await operation();

  const samples = [];
  for (let index = 0; index < n; index += 1) {
    const started = clock.now();
    await operation();
    const elapsed = clock.now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      throw new Error(`Clock moved backward or returned an invalid duration: ${elapsed}`);
    }
    samples.push(elapsed);
  }
  return Object.freeze({ samples: Object.freeze(samples), statistics: summarize(samples) });
}

export async function measureAxes(operations, options = {}) {
  const keys = Object.keys(operations);
  if (keys.length !== axisNames.length || keys.some((key, index) => key !== axisNames[index])) {
    throw new Error(`Axis order must be exactly: ${axisNames.join(", ")}`);
  }

  const measurements = {};
  for (const name of axisNames) {
    measurements[name] = await measureOperation(operations[name], options);
  }
  return Object.freeze(measurements);
}

export function spinFor(milliseconds, clock = performance) {
  const started = clock.now();
  while (clock.now() - started < milliseconds) {
    // Intentional empty body: this is a timer sensitivity probe.
  }
}
