import { summarize } from "./timing.mjs";

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

function decodeFieldSegments(text, targetBytes = 4_096) {
  const segments = [];
  let current = "";
  let currentBytes = 0;
  for (const scalar of text) {
    const codePoint = scalar.codePointAt(0);
    current += scalar;
    currentBytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (currentBytes >= targetBytes) {
      segments.push(current);
      current = "";
      currentBytes = 0;
    }
  }
  if (current.length !== 0) segments.push(current);
  return segments;
}

function tokenIsDirty(bytes) {
  try {
    fatalDecoder.decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function dirtyShape(dirty, mixedRunPenalty = 1) {
  let dirtyIds = 0;
  let dirtyRuns = 0;
  let previousDirty = false;
  for (const value of dirty) {
    if (value) {
      dirtyIds += 1;
      if (!previousDirty) dirtyRuns += 1;
      previousDirty = true;
    } else {
      previousDirty = false;
    }
  }
  return Object.freeze({
    dirtyIds,
    dirtyRuns,
    mixedRouteScore: dirty.length === 0
      ? 0
      : (dirtyIds + dirtyRuns * mixedRunPenalty) / dirty.length,
  });
}

function mixedRoute(dirty, maxDirtyDensity, mixedRunPenalty) {
  const shape = dirtyShape(dirty, mixedRunPenalty);
  if (shape.dirtyIds === 0) return Object.freeze({ route: "table", ...shape });
  const sampleCount = Math.min(dirty.length, 32);
  const step = dirty.length / sampleCount;
  let sampledDirty = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    sampledDirty += dirty[Math.floor(sample * step)] ? 1 : 0;
  }
  if (sampledDirty / sampleCount > maxDirtyDensity) {
    return Object.freeze({ route: "assembly", ...shape });
  }
  return Object.freeze({
    route: shape.mixedRouteScore > maxDirtyDensity ? "assembly" : "mixed",
    ...shape,
  });
}

function elapsed(decode, segments, iterations, now, containerRegime) {
  const freshInputs = containerRegime === "fresh"
    ? Array.from(
        { length: iterations },
        () => segments.map(({ ids }) => Array.from(ids)),
      )
    : null;
  const started = now();
  let output = "";
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let index = 0; index < segments.length; index += 1) {
      output = decode(
        freshInputs === null ? segments[index].ids : freshInputs[iteration][index],
      );
    }
  }
  const milliseconds = now() - started;
  if (segments.length !== 0 && output.length === 0) {
    throw new Error("Timed decode returned no text");
  }
  return milliseconds;
}

function measurePair(left, right, segments, iterations, n, warmup, now, containerRegime) {
  if (segments.length === 0) return null;
  for (let sample = 0; sample < warmup; sample += 1) {
    if ((sample & 1) === 0) {
      elapsed(left, segments, iterations, now, containerRegime);
      elapsed(right, segments, iterations, now, containerRegime);
    } else {
      elapsed(right, segments, iterations, now, containerRegime);
      elapsed(left, segments, iterations, now, containerRegime);
    }
  }
  const leftSamples = [];
  const rightSamples = [];
  for (let sample = 0; sample < n; sample += 1) {
    if ((sample & 1) === 0) {
      leftSamples.push(elapsed(left, segments, iterations, now, containerRegime));
      rightSamples.push(elapsed(right, segments, iterations, now, containerRegime));
    } else {
      rightSamples.push(elapsed(right, segments, iterations, now, containerRegime));
      leftSamples.push(elapsed(left, segments, iterations, now, containerRegime));
    }
  }
  return Object.freeze({
    left: summarize(leftSamples),
    right: summarize(rightSamples),
    pairedRatio: summarize(
      rightSamples.map((milliseconds, index) => milliseconds / leftSamples[index]),
    ),
    samples: Object.freeze({
      left: Object.freeze(leftSamples),
      right: Object.freeze(rightSamples),
    }),
  });
}

export function measureDecodeRoutes({
  baseline,
  candidate,
  baselineStats = () => null,
  candidateStats = () => null,
  workloads,
  candidateMode = "byte",
  containerRegime = "repeated",
  maxMixedDirtyDensity = 0.5,
  mixedRunPenalty = 1,
  targetBytesPerSample = 1_048_576,
  n = 21,
  warmup = 2,
  now = () => performance.now(),
}) {
  if (!new Set(["byte", "mixed", "fused", "lean", "memo", "run-cache", "latin1-native", "latin1-portable", "direct-scratch", "clean-unroll", "borrowed-output", "utf16-output", "direct-borrowed", "cut-direct", "cut-borrowed", "dirty-batch"]).has(candidateMode)) {
    throw new TypeError("candidateMode is not supported by decode route pricing");
  }
  if (!new Set(["repeated", "fresh"]).has(containerRegime)) {
    throw new TypeError("containerRegime must be repeated or fresh");
  }
  if (!Number.isInteger(targetBytesPerSample) || targetBytesPerSample < 1) {
    throw new TypeError("targetBytesPerSample must be a positive integer");
  }
  const rows = [];
  for (const workload of workloads) {
    const workloadBytes = workload.bytes ?? new TextEncoder().encode(workload.text).length;
    const iterations = Math.max(1, Math.ceil(targetBytesPerSample / workloadBytes));
    const segments = decodeFieldSegments(workload.text).map((text) => {
      const ids = Array.from(baseline.encodeSync(text));
      const dirty = ids.map((id) => tokenIsDirty(baseline.tokenBytes(id)));
      const shape = dirtyShape(dirty, mixedRunPenalty);
      const usesMixedRoute =
        candidateMode === "mixed" ||
        candidateMode === "run-cache" ||
        candidateMode === "latin1-native" ||
        candidateMode === "latin1-portable" ||
        candidateMode === "dirty-batch";
      const candidateShape = usesMixedRoute
        ? mixedRoute(dirty, maxMixedDirtyDensity, mixedRunPenalty)
        : null;
      if (baseline.decode(ids) !== text) throw new Error(`${workload.id}: baseline mismatch`);
      if (candidate.decode(ids) !== text) throw new Error(`${workload.id}: candidate mismatch`);
      return Object.freeze({
        ids,
        dirtyIds: shape.dirtyIds,
        dirtyRuns: shape.dirtyRuns,
        mixedRouteScore: shape.mixedRouteScore,
        route: shape.dirtyIds === 0 ? "table" : "assembly",
        candidateRoute: usesMixedRoute
          ? candidateShape.route
          : candidateMode === "byte" && shape.dirtyIds !== 0
            ? "byte"
            : shape.dirtyIds === 0
              ? "table"
              : "assembly",
      });
    });
    const tableSegments = segments.filter(({ route }) => route === "table");
    const assemblySegments = segments.filter(({ route }) => route === "assembly");
    const mixedSegments = segments.filter(({ candidateRoute }) => candidateRoute === "mixed");
    const candidateAssemblySegments = segments.filter(
      ({ candidateRoute }) => candidateRoute === "assembly",
    );
    const all = measurePair(
      (ids) => baseline.decode(ids),
      (ids) => candidate.decode(ids),
      segments,
      iterations,
      n,
      warmup,
      now,
      containerRegime,
    );
    const table = measurePair(
      (ids) => baseline.decode(ids),
      (ids) => candidate.decode(ids),
      tableSegments,
      iterations,
      n,
      warmup,
      now,
      containerRegime,
    );
    const assembly = measurePair(
      (ids) => baseline.decode(ids),
      (ids) => candidate.decode(ids),
      assemblySegments,
      iterations,
      n,
      warmup,
      now,
      containerRegime,
    );
    const mixed = measurePair(
      (ids) => baseline.decode(ids),
      (ids) => candidate.decode(ids),
      mixedSegments,
      iterations,
      n,
      warmup,
      now,
      containerRegime,
    );
    const candidateAssembly = measurePair(
      (ids) => baseline.decode(ids),
      (ids) => candidate.decode(ids),
      candidateAssemblySegments,
      iterations,
      n,
      warmup,
      now,
      containerRegime,
    );
    const tableMilliseconds = table?.left.median ?? 0;
    const assemblyMilliseconds = assembly?.left.median ?? 0;
    const totalRouteMilliseconds = tableMilliseconds + assemblyMilliseconds;
    const dirtyIds = segments.reduce((sum, segment) => sum + segment.dirtyIds, 0);
    const dirtyRuns = segments.reduce((sum, segment) => sum + segment.dirtyRuns, 0);
    const tokenCount = segments.reduce((sum, segment) => sum + segment.ids.length, 0);
    rows.push(Object.freeze({
      workload: workload.id,
      segments: segments.length,
      iterationsPerSample: iterations,
      tableSegments: tableSegments.length,
      assemblySegments: assemblySegments.length,
      mixedSegments: mixedSegments.length,
      candidateAssemblySegments: candidateAssemblySegments.length,
      dirtySegmentFraction: assemblySegments.length / segments.length,
      dirtyIdFraction: dirtyIds / tokenCount,
      dirtyRuns,
      maximumMixedRouteScore: Math.max(...segments.map(({ mixedRouteScore }) => mixedRouteScore)),
      tableTimeFraction: totalRouteMilliseconds === 0 ? 0 : tableMilliseconds / totalRouteMilliseconds,
      assemblyTimeFraction:
        totalRouteMilliseconds === 0 ? 0 : assemblyMilliseconds / totalRouteMilliseconds,
      assemblyMillisecondsPerSegment:
        assemblySegments.length === 0
          ? null
          : assembly.left.median / (assemblySegments.length * iterations),
      byteTableMillisecondsPerSegment:
        assemblySegments.length === 0
          ? null
          : assembly.right.median / (assemblySegments.length * iterations),
      candidateMillisecondsPerAssemblySegment:
        candidateAssemblySegments.length === 0
          ? null
          : candidateAssembly.right.median / (candidateAssemblySegments.length * iterations),
      candidateMinusAssemblyMillisecondsPerSegment:
        candidateAssemblySegments.length === 0
          ? null
          : (candidateAssembly.right.median - candidateAssembly.left.median) /
            (candidateAssemblySegments.length * iterations),
      candidateToBaselineTimeRatio: all.right.median / all.left.median,
      pairedCandidateToBaselineTimeRatio: all.pairedRatio.median,
      candidateMode,
      containerRegime,
      maxMixedDirtyDensity:
        candidateMode === "mixed" || candidateMode === "run-cache" || candidateMode === "dirty-batch"
          ? maxMixedDirtyDensity
          : null,
      mixedRunPenalty:
        candidateMode === "mixed" || candidateMode === "run-cache" || candidateMode === "dirty-batch" ? mixedRunPenalty : null,
      byteTableToAssemblyTimeRatio:
        assembly === null ? null : assembly.right.median / assembly.left.median,
      all,
      table,
      assembly,
      mixed,
      candidateAssembly,
    }));
  }
  return Object.freeze({
    n,
    warmup,
    targetBytesPerSample,
    candidateMode,
    containerRegime,
    maxMixedDirtyDensity:
      candidateMode === "mixed" || candidateMode === "run-cache" || candidateMode === "dirty-batch" ? maxMixedDirtyDensity : null,
    mixedRunPenalty:
      candidateMode === "mixed" || candidateMode === "run-cache" || candidateMode === "dirty-batch" ? mixedRunPenalty : null,
    rows,
    baselineStats: baselineStats(),
    candidateStats: candidateStats(),
  });
}
