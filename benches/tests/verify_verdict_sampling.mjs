import assert from "node:assert/strict";
import { addHypertokRatios } from "../common/throughput.mjs";
import {
  comparisonNoise,
  extendMeasuredRow,
  measuredRow,
  planEscalations,
  publicMeasuredRow,
  resolveEscalations,
  sampleCountForWorkload,
  samplingKey,
} from "../common/verdict_sampling.mjs";

const configuration = Object.freeze({
  mode: "full",
  n: 5,
  maxN: 11,
  openWebTextN: 3,
});

assert.equal(sampleCountForWorkload(configuration, { id: "english-prose" }), 5);
assert.equal(sampleCountForWorkload(configuration, { id: "openwebtext-slice" }), 3);

function row(reference, workload, samples, containerRegime = undefined) {
  return measuredRow({
    row: {
      vocabulary: "gpt2",
      workload,
      reference,
      referenceVersion: "test",
      status: "measured",
      ...(containerRegime === undefined ? {} : { containerRegime }),
    },
    samples,
    initialN: samples.length,
  });
}

function receipt(workload, statuses) {
  return {
    agreementKey: "test-agreement",
    rows: Object.entries(statuses).map(([reference, status]) => ({
      vocabulary: "gpt2",
      workload,
      reference,
      referenceVersion: "test",
      status,
    })),
  };
}

const clearRows = [
  row("hypertok", "english-prose", [100, 100, 100, 100, 100]),
  row("fast", "english-prose", [60, 60, 60, 60, 60]),
];
const clearPlan = planEscalations(
  clearRows,
  receipt("english-prose", { hypertok: "identical", fast: "identical" }),
);
assert.equal(clearPlan.targets.size, 0);
assert.equal(clearPlan.decisions[0].resolved, true);
assert.equal(clearPlan.decisions[0].escalated, false);
const ratioRows = addHypertokRatios(
  clearRows,
  receipt("english-prose", { hypertok: "identical", fast: "identical" }),
);
assert.equal(ratioRows[0].ratio, 1);
assert.equal(ratioRows[1].ratio, 100 / 60);
assert.ok(ratioRows.every(({ comparisonNoise: noise }) => noise !== null));

const unresolvedRows = [
  row("hypertok", "source-code", [96, 100, 104, 99, 101]),
  row("fast", "source-code", [95, 101, 103, 100, 102]),
  row("slow", "source-code", [50, 50, 50, 50, 50]),
  row("different", "source-code", [200, 200, 200, 200, 200]),
];
const unresolvedReceipt = receipt("source-code", {
  hypertok: "identical",
  fast: "identical",
  slow: "identical",
  different: "different",
});
const unresolvedPlan = planEscalations(unresolvedRows, unresolvedReceipt);
assert.equal(unresolvedPlan.decisions.length, 2);
assert.equal(unresolvedPlan.decisions[0].incumbent, "fast");
assert.equal(unresolvedPlan.decisions[0].resolved, false);
assert.equal(unresolvedPlan.decisions[1].incumbent, "slow");
assert.equal(unresolvedPlan.decisions[1].resolved, true);
assert.deepEqual(
  [...unresolvedPlan.targets].sort(),
  [samplingKey(unresolvedRows[0]), samplingKey(unresolvedRows[1])].sort(),
);

const movingRows = [
  row("hypertok", "standard-text", [100, 100, 100, 100, 100], "fresh"),
  row("incumbent-a", "standard-text", [80, 80, 80, 80, 80], "fresh"),
  row("incumbent-b", "standard-text", [98, 100, 102, 99, 101], "fresh"),
];
const movingReceipt = receipt("standard-text", {
  hypertok: "identical",
  "incumbent-a": "identical",
  "incumbent-b": "identical",
});
const targetRounds = [];
const movingPlan = await resolveEscalations(
  movingRows,
  movingReceipt,
  11,
  async (targets) => {
    targetRounds.push(new Set(targets));
    for (const key of targets) {
      const index = movingRows.findIndex((candidate) => samplingKey(candidate) === key);
      const candidate = movingRows[index];
      const additions = candidate.reference === "hypertok"
        ? [82, 82, 82, 82, 82, 82]
        : candidate.reference === "incumbent-b"
          ? [70, 70, 70, 70, 70, 70]
          : [80, 80, 80, 80, 80, 80];
      movingRows[index] = extendMeasuredRow(candidate, additions);
    }
  },
);
assert.equal(movingPlan.rounds, 2);
assert.deepEqual(
  [...targetRounds[0]].sort(),
  [samplingKey(movingRows[0]), samplingKey(movingRows[2])].sort(),
);
assert.deepEqual([...targetRounds[1]], [samplingKey(movingRows[1])]);
assert.equal(movingRows.every(({ n }) => n === 11), true);
assert.equal(movingPlan.targets.size, 0);

const extended = extendMeasuredRow(
  unresolvedRows[0],
  [98, 99, 100, 101, 102, 103],
);
assert.equal(extended.n, 11);
assert.deepEqual(extended.sampling, { initialN: 5, finalN: 11, escalated: true });
assert.equal("samples" in publicMeasuredRow(extended), false);

const openWebTextRows = [
  row("hypertok", "openwebtext-slice", [90, 100, 110], "fresh"),
  row("fast", "openwebtext-slice", [91, 99, 109], "fresh"),
];
const openWebTextPlan = planEscalations(
  openWebTextRows,
  receipt("openwebtext-slice", { hypertok: "identical", fast: "identical" }),
);
assert.equal(openWebTextPlan.targets.size, 0);
assert.equal(openWebTextPlan.decisions[0].escalated, false);
assert.equal(openWebTextRows[0].stability.minimum, 90);
assert.equal(openWebTextRows[0].stability.maximum, 110);
assert.ok(openWebTextRows[0].stability.relativeRange > 0);
assert.ok(openWebTextRows[0].relativeNoise > 0);

const quietGap = comparisonNoise(
  { median: 100, variance: 0 },
  { median: 99, variance: 0 },
);
const noisyGap = comparisonNoise(
  { median: 100, variance: 16 },
  { median: 99, variance: 16 },
);
assert.equal(quietGap.resolved, true);
assert.equal(noisyGap.resolved, false);

console.log("verdict sampling PASS (n=5 floor, row-local n=11 escalation, OpenWebText n=3)");
console.log("noise decision mutation RED (variance increase flips resolved verdict)");
