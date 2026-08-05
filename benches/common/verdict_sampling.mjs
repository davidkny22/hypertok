import { agreementForRow } from "./agreement_receipt.mjs";
import { summarize } from "./timing.mjs";

export const VERDICT_INITIAL_N = 5;
export const VERDICT_MAX_N = 11;
export const OPENWEBTEXT_N = 3;
export const NOISE_MULTIPLIER = 2;
export const OPENWEBTEXT_WORKLOAD = "openwebtext-slice";
export const VERDICT_SAMPLING_POLICY = Object.freeze({
  initialN: VERDICT_INITIAL_N,
  maximumN: VERDICT_MAX_N,
  openWebTextN: OPENWEBTEXT_N,
  noiseMultiplier: NOISE_MULTIPLIER,
  combinedNoise: "root-sum-square relative standard deviation",
  verdictGap: "absolute natural log of throughput ratio",
});

export function sampleCountForWorkload(configuration, workload) {
  if (configuration.mode === "smoke") return configuration.n;
  return workload.id === OPENWEBTEXT_WORKLOAD
    ? configuration.openWebTextN
    : configuration.n;
}

export function relativeNoise(statistics) {
  if (!Number.isFinite(statistics.median) || statistics.median <= 0) return Infinity;
  return Math.sqrt(statistics.variance) / statistics.median;
}

export function comparisonNoise(subject, reference, multiplier = NOISE_MULTIPLIER) {
  const subjectNoise = relativeNoise(subject);
  const referenceNoise = relativeNoise(reference);
  const combinedNoise = Math.hypot(subjectNoise, referenceNoise);
  const ratio = subject.median / reference.median;
  const logGap = Math.abs(Math.log(ratio));
  const threshold = multiplier * combinedNoise;
  return Object.freeze({
    subjectNoise,
    referenceNoise,
    combinedNoise,
    ratio,
    logGap,
    threshold,
    resolved: logGap >= threshold,
  });
}

export function samplingKey(row) {
  return [
    row.vocabulary,
    row.workload,
    row.containerRegime ?? "",
    row.reference,
  ].join("\u0000");
}

function verdictKey(row) {
  return [row.vocabulary, row.workload, row.containerRegime ?? ""].join("\u0000");
}

export function planEscalations(rows, agreementReceipt, maxN = VERDICT_MAX_N) {
  const groups = new Map();
  for (const row of rows) {
    if (row.status !== "measured") continue;
    const key = verdictKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const targets = new Set();
  const decisions = [];
  for (const group of groups.values()) {
    const subject = group.find(({ reference }) => reference === "hypertok");
    if (subject === undefined) throw new Error("Verdict sampling requires a hypertok row");
    const comparable = group.filter((row) =>
      row.reference !== "hypertok" &&
      agreementForRow(
        agreementReceipt,
        row.vocabulary,
        row.workload,
        row.reference,
      ).status === "identical"
    );
    if (comparable.length === 0) continue;
    for (const incumbent of comparable) {
      const noise = comparisonNoise(subject, incumbent);
      const canEscalate =
        subject.workload !== OPENWEBTEXT_WORKLOAD &&
        Math.min(subject.n, incumbent.n) < maxN;
      const escalate = !noise.resolved && canEscalate;
      if (escalate) {
        targets.add(samplingKey(subject));
        targets.add(samplingKey(incumbent));
      }
      decisions.push(Object.freeze({
        vocabulary: subject.vocabulary,
        workload: subject.workload,
        containerRegime: subject.containerRegime ?? null,
        incumbent: incumbent.reference,
        initialSubjectN: subject.n,
        initialIncumbentN: incumbent.n,
        ...noise,
        escalated: escalate,
      }));
    }
  }
  return Object.freeze({ targets, decisions: Object.freeze(decisions) });
}

export function measuredRow({ row, samples, initialN, escalated = false }) {
  const statistics = summarize(samples);
  const stability = row.workload === OPENWEBTEXT_WORKLOAD
    ? Object.freeze({
        minimum: Math.min(...samples),
        maximum: Math.max(...samples),
        relativeRange:
          (Math.max(...samples) - Math.min(...samples)) / statistics.median,
        relativeStandardDeviation: relativeNoise(statistics),
      })
    : null;
  return {
    ...row,
    ...statistics,
    relativeNoise: relativeNoise(statistics),
    sampling: Object.freeze({ initialN, finalN: statistics.n, escalated }),
    stability,
    samples: Object.freeze([...samples]),
  };
}

export function extendMeasuredRow(row, additionalSamples) {
  return measuredRow({
    row,
    samples: [...row.samples, ...additionalSamples],
    initialN: row.sampling.initialN,
    escalated: true,
  });
}

export function publicMeasuredRow(row) {
  const { samples, ...publicRow } = row;
  return publicRow;
}
