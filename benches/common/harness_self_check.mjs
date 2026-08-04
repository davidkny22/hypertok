import { axisNames, measureAxes, measureOperation, spinFor, summarize } from "./timing.mjs";

const virtualDurations = Object.freeze({
  transfer: 1,
  decompression: 2,
  materialisation: 3,
  encode: 4,
});

function assertExactStatistics() {
  const result = summarize([1, 2, 3, 4, 5]);
  if (result.n !== 5 || result.median !== 3 || result.p95 !== 5 || result.variance !== 2) {
    throw new Error(`Statistics self-check failed: ${JSON.stringify(result)}`);
  }
  return result;
}

function createVirtualClock() {
  let value = 0;
  return {
    now: () => value,
    advance: (amount) => {
      value += amount;
    },
  };
}

function assertAxisMedians(measurements) {
  for (const name of axisNames) {
    if (measurements[name].statistics.median !== virtualDurations[name]) {
      throw new Error(
        `${name} median ${measurements[name].statistics.median} != ${virtualDurations[name]}`,
      );
    }
  }
}

async function timerMutationGoesRed() {
  const readings = [2, 1];
  try {
    await measureOperation(() => {}, {
      n: 1,
      warmup: 0,
      clock: { now: () => readings.shift() },
    });
  } catch (error) {
    if (/Clock moved backward/.test(error.message)) return "RED";
    throw error;
  }
  throw new Error("Backward-clock mutation stayed green");
}

function axisMutationGoesRed(measurements) {
  const mutated = {
    ...measurements,
    transfer: measurements.decompression,
  };
  try {
    assertAxisMedians(mutated);
  } catch (error) {
    if (/transfer median/.test(error.message)) return "RED";
    throw error;
  }
  throw new Error("Cross-axis label mutation stayed green");
}

export async function runHarnessSelfCheck() {
  const exactStatistics = assertExactStatistics();

  const noOp = await measureOperation(() => {}, { n: 31, warmup: 5 });
  const injectedDelay = await measureOperation(() => spinFor(2), { n: 15, warmup: 3 });
  if (injectedDelay.statistics.median < noOp.statistics.median + 1) {
    throw new Error(
      `Injected delay was not resolved: ${injectedDelay.statistics.median} vs ${noOp.statistics.median}`,
    );
  }

  const virtualClock = createVirtualClock();
  const virtualOperations = Object.fromEntries(
    axisNames.map((name) => [name, () => virtualClock.advance(virtualDurations[name])]),
  );
  const axes = await measureAxes(virtualOperations, {
    n: 7,
    warmup: 2,
    clock: virtualClock,
  });
  assertAxisMedians(axes);

  return Object.freeze({
    exactStatistics,
    noOp: noOp.statistics,
    injectedDelay: injectedDelay.statistics,
    axes: Object.fromEntries(
      axisNames.map((name) => [name, axes[name].statistics]),
    ),
    mutations: {
      backwardClock: await timerMutationGoesRed(),
      crossAxisLabel: axisMutationGoesRed(axes),
    },
  });
}
