const axes = new Set([
  "transfer",
  "decompression",
  "materialisation",
  "encode",
  "decode",
  "memory",
]);

export function benchmarkRow(input) {
  if (!axes.has(input.axis)) throw new Error(`Unknown benchmark axis: ${input.axis}`);
  if (!["measured", "unavailable"].includes(input.status)) {
    throw new Error(`Unknown benchmark row status: ${input.status}`);
  }
  const required = [
    "profile",
    "mode",
    "vocabulary",
    "workload",
    "reference",
    "environment",
    "commit",
    "agreementKey",
  ];
  for (const name of required) {
    if (typeof input[name] !== "string" || input[name].length === 0) {
      throw new Error(`Benchmark row requires ${name}`);
    }
  }
  if (
    input.axis === "decode" &&
    !["repeated", "fresh"].includes(input.containerRegime)
  ) {
    throw new Error("Decode benchmark row requires a repeated or fresh containerRegime");
  }
  if (input.status === "unavailable") {
    if (!input.reason) throw new Error("Unavailable benchmark row requires a reason");
    return Object.freeze({ ...input });
  }
  if (!["identical", "different"].includes(input.comparisonStatus)) {
    throw new Error("Measured benchmark row requires an agreement status");
  }
  for (const name of ["n", "median", "p95", "variance"]) {
    if (!Number.isFinite(input[name])) throw new Error(`Benchmark row requires finite ${name}`);
  }
  if (!Number.isInteger(input.n) || input.n < 1) {
    throw new Error("Benchmark row n must be a positive integer");
  }
  if (!Number.isFinite(input.relativeNoise) || input.relativeNoise < 0) {
    throw new Error("Measured benchmark row requires finite non-negative relativeNoise");
  }
  if (
    input.sampling === null ||
    typeof input.sampling !== "object" ||
    !Number.isInteger(input.sampling.initialN) ||
    !Number.isInteger(input.sampling.finalN) ||
    input.sampling.initialN < 1 ||
    input.sampling.finalN !== input.n ||
    typeof input.sampling.escalated !== "boolean" ||
    (input.sampling.escalated
      ? input.sampling.finalN <= input.sampling.initialN
      : input.sampling.finalN !== input.sampling.initialN)
  ) {
    throw new Error("Measured benchmark row requires a consistent sampling receipt");
  }
  if (input.comparisonStatus === "identical" && !Number.isFinite(input.ratio)) {
    throw new Error("Comparable benchmark row requires a finite ratio");
  }
  if (
    input.comparisonStatus === "identical" &&
    (
      input.comparisonNoise === null ||
      typeof input.comparisonNoise !== "object" ||
      [
        "subjectNoise",
        "referenceNoise",
        "combinedNoise",
        "ratio",
        "logGap",
        "threshold",
      ].some((name) =>
        !Number.isFinite(input.comparisonNoise[name]) || input.comparisonNoise[name] < 0
      ) ||
      typeof input.comparisonNoise.resolved !== "boolean" ||
      input.comparisonNoise.ratio !== input.ratio
    )
  ) {
    throw new Error("Comparable benchmark row requires its finite comparison noise receipt");
  }
  if (input.comparisonStatus === "different" && input.ratio !== null) {
    throw new Error("Different-output benchmark row cannot carry a ratio");
  }
  if (input.comparisonStatus === "different" && input.comparisonNoise !== null) {
    throw new Error("Different-output benchmark row cannot carry comparison noise");
  }
  if (input.workload === "openwebtext-slice") {
    if (
      input.stability === null ||
      typeof input.stability !== "object" ||
      ["minimum", "maximum", "relativeRange", "relativeStandardDeviation"].some(
        (name) => !Number.isFinite(input.stability[name]) || input.stability[name] < 0,
      )
    ) {
      throw new Error("OpenWebText benchmark row requires finite per-run stability");
    }
  } else if (input.stability !== null) {
    throw new Error("Only OpenWebText rows carry the large-corpus stability receipt");
  }
  if (
    input.median < 0 ||
    input.p95 < 0 ||
    input.variance < 0 ||
    (input.ratio !== null && input.ratio < 0)
  ) {
    throw new Error("Benchmark row statistics must be non-negative");
  }
  return Object.freeze({ ...input });
}
