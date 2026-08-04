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
  if (input.comparisonStatus === "identical" && !Number.isFinite(input.ratio)) {
    throw new Error("Comparable benchmark row requires a finite ratio");
  }
  if (input.comparisonStatus === "different" && input.ratio !== null) {
    throw new Error("Different-output benchmark row cannot carry a ratio");
  }
  if (!Number.isInteger(input.n) || input.n < 1) {
    throw new Error("Benchmark row n must be a positive integer");
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
