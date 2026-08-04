import { summarize } from "./timing.mjs";

function fieldSegments(text, targetBytes = 4_096) {
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

function exactIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function elapsed(decode, segments, now) {
  const started = now();
  let output = "";
  for (const segment of segments) output = decode(segment.ids);
  const milliseconds = now() - started;
  if (segments.length !== 0 && output.length === 0) {
    throw new Error("Timed decode returned no text");
  }
  return milliseconds;
}

function measurePair(baseline, candidate, segments, n, warmup, now) {
  for (let sample = 0; sample < warmup; sample += 1) {
    if ((sample & 1) === 0) {
      elapsed(baseline, segments, now);
      elapsed(candidate, segments, now);
    } else {
      elapsed(candidate, segments, now);
      elapsed(baseline, segments, now);
    }
  }

  const baselineSamples = [];
  const candidateSamples = [];
  for (let sample = 0; sample < n; sample += 1) {
    if ((sample & 1) === 0) {
      baselineSamples.push(elapsed(baseline, segments, now));
      candidateSamples.push(elapsed(candidate, segments, now));
    } else {
      candidateSamples.push(elapsed(candidate, segments, now));
      baselineSamples.push(elapsed(baseline, segments, now));
    }
  }
  return Object.freeze({
    baseline: summarize(baselineSamples),
    candidate: summarize(candidateSamples),
  });
}

export function measureDecodeArtifactPair({
  baseline,
  candidate,
  workloads,
  n = 21,
  warmup = 2,
  now = () => performance.now(),
}) {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(warmup) || warmup < 0) {
    throw new TypeError("n must be positive and warmup must be non-negative");
  }
  const encoder = new TextEncoder();
  const rows = [];
  for (const workload of workloads) {
    const segments = fieldSegments(workload.text).map((text) => {
      const baselineIds = Array.from(baseline.encodeSync(text));
      const candidateIds = Array.from(candidate.encodeSync(text));
      if (!exactIds(baselineIds, candidateIds)) {
        throw new Error(`${workload.id}: artifact encode disagreement`);
      }
      if (baseline.decode(baselineIds) !== text) {
        throw new Error(`${workload.id}: baseline decode mismatch`);
      }
      if (candidate.decode(baselineIds) !== text) {
        throw new Error(`${workload.id}: candidate decode mismatch`);
      }
      return Object.freeze({ text, ids: baselineIds });
    });
    const paired = measurePair(
      (ids) => baseline.decode(ids),
      (ids) => candidate.decode(ids),
      segments,
      n,
      warmup,
      now,
    );
    for (const segment of segments) {
      if (baseline.decode(segment.ids) !== segment.text) {
        throw new Error(`${workload.id}: baseline post-timing mismatch`);
      }
      if (candidate.decode(segment.ids) !== segment.text) {
        throw new Error(`${workload.id}: candidate post-timing mismatch`);
      }
    }
    const bytes = encoder.encode(workload.text).length;
    rows.push(Object.freeze({
      workload: workload.id,
      bytes,
      segments: segments.length,
      ids: segments.reduce((sum, segment) => sum + segment.ids.length, 0),
      baseline: paired.baseline,
      candidate: paired.candidate,
      candidateOverBaseline: paired.baseline.median / paired.candidate.median,
      baselineOverCandidate: paired.candidate.median / paired.baseline.median,
    }));
  }
  return Object.freeze({
    n,
    warmup,
    segmentBytes: 4_096,
    order: "alternating baseline and candidate within one session",
    rows: Object.freeze(rows),
  });
}
