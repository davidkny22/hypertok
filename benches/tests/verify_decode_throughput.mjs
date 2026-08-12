import assert from "node:assert/strict";
import {
  addHypertokRatios,
  measureDecodeThroughput,
} from "../common/throughput.mjs";
import { measureDecodeRoutes } from "../common/decode_route_pricing.mjs";
import { buildAgreementReceipt } from "../common/agreement_receipt.mjs";
import { buildRunIdentity, identityDigest } from "../common/identity.mjs";

const workload = Object.freeze({
  id: "probe",
  bytes: 23,
  text: "Decode probe: 中文 😀",
});
const configuration = Object.freeze({ n: 3, warmup: 1, targetBytesPerSample: 64 });
const ids = Uint32Array.from([1, 2, 3, 4]);
const exactAdapter = Object.freeze({
  id: "exact",
  encode: () => ids,
  decode: () => workload.text,
});

const measured = await measureDecodeThroughput(exactAdapter, workload, configuration);
assert.equal(measured.exact, true);
assert.equal(measured.containerRegime, "repeated");
assert.equal(measured.statistics.n, 3);
assert.equal(measured.tokenCount, ids.length);
assert.equal(measured.bytesPerSample, workload.bytes * 3);
assert.equal(measured.iterationsPerSample, 3);

const mutatedAdapter = Object.freeze({
  ...exactAdapter,
  id: "mutated",
  decode: () => `${workload.text}!`,
});
await assert.rejects(
  measureDecodeThroughput(mutatedAdapter, workload, configuration),
  /decoded text mismatch/,
);

const ratioRows = [
  { vocabulary: "gpt2", workload: "probe", reference: "hypertok", status: "measured", median: 12 },
  { vocabulary: "gpt2", workload: "probe", reference: "reference", status: "measured", median: 3 },
  { vocabulary: "gpt2", workload: "probe", reference: "different", status: "measured", median: 24 },
  { vocabulary: "o200k_base", workload: "probe", reference: "hypertok", status: "measured", median: 20 },
  { vocabulary: "o200k_base", workload: "probe", reference: "reference", status: "measured", median: 10 },
];
const ratioIdentity = buildRunIdentity({
  profile: "arena",
  environment: "test",
  commit: "a".repeat(40),
  packageLockSha256: "b".repeat(64),
  corpusSha256: "c".repeat(64),
  modelSha256: "d".repeat(64),
  artifactSha256: "e".repeat(64),
  referenceRegistrySha256: identityDigest(["hypertok", "reference"]),
});
const ratioReceipt = buildAgreementReceipt(
  ratioIdentity,
  ratioRows.map((row) => ({
    vocabulary: row.vocabulary,
    workload: row.workload,
    reference: row.reference,
    referenceVersion: undefined,
    status: row.reference === "different" ? "different" : "identical",
    tokenCount: 1,
    tokenSha256: "f".repeat(64),
    mismatch: null,
  })),
);
const ratios = addHypertokRatios(ratioRows, ratioReceipt);
assert.deepEqual(ratios.map(({ ratio }) => ratio), [1, 4, null, 1, 2]);
assert.throws(() => addHypertokRatios(ratioRows), /agreement receipt/);

const regimeRatios = addHypertokRatios([
  { ...ratioRows[0], containerRegime: "repeated", median: 12 },
  { ...ratioRows[1], containerRegime: "repeated", median: 3 },
  { ...ratioRows[0], containerRegime: "fresh", median: 20 },
  { ...ratioRows[1], containerRegime: "fresh", median: 10 },
], ratioReceipt);
assert.deepEqual(regimeRatios.map(({ ratio }) => ratio), [1, 4, 1, 2]);

async function throughputContainers(containerRegime) {
  const seen = [];
  const adapter = Object.freeze({
    id: "hypertok",
    encode: () => ids,
    decode: (input) => {
      seen.push(input);
      return workload.text;
    },
  });
  await measureDecodeThroughput(adapter, workload, configuration, containerRegime);
  return seen;
}

const repeatedThroughputContainers = await throughputContainers("repeated");
assert.equal(new Set(repeatedThroughputContainers).size, 1);
assert.ok(repeatedThroughputContainers.every((input) => input instanceof Uint32Array));
const freshThroughputContainers = await throughputContainers("fresh");
assert.equal(new Set(freshThroughputContainers).size, freshThroughputContainers.length);
assert.ok(freshThroughputContainers.every((input) => input instanceof Uint32Array));
await assert.rejects(
  measureDecodeThroughput(exactAdapter, workload, configuration, "blended"),
  /container regime must be repeated or fresh/,
);

function routeFixture() {
  const seen = [];
  return {
    seen,
    adapter: Object.freeze({
      encodeSync: () => Uint32Array.of(0),
      tokenBytes: () => Uint8Array.of(0x61),
      decode: (input) => {
        seen.push(input);
        return "a";
      },
    }),
  };
}

function routeClock() {
  let tick = 0;
  return () => {
    tick += 1;
    return tick;
  };
}

const repeatedBaseline = routeFixture();
const repeatedCandidate = routeFixture();
const repeated = measureDecodeRoutes({
  baseline: repeatedBaseline.adapter,
  candidate: repeatedCandidate.adapter,
  workloads: [{ id: "repeated", text: "a" }],
  candidateMode: "memo",
  containerRegime: "repeated",
  n: 3,
  warmup: 1,
  targetBytesPerSample: 1,
  now: routeClock(),
});
assert.equal(repeated.containerRegime, "repeated");
assert.equal(new Set(repeatedCandidate.seen).size, 1);
assert.ok(repeatedCandidate.seen.every((input) => input instanceof Uint32Array));
assert.equal(repeated.rows[0].all.pairedRatio.n, 3);
assert.equal(
  repeated.rows[0].pairedCandidateToBaselineTimeRatio,
  repeated.rows[0].all.pairedRatio.median,
);

const freshBaseline = routeFixture();
const freshCandidate = routeFixture();
const fresh = measureDecodeRoutes({
  baseline: freshBaseline.adapter,
  candidate: freshCandidate.adapter,
  workloads: [{ id: "fresh", text: "a" }],
  candidateMode: "memo",
  containerRegime: "fresh",
  n: 3,
  warmup: 1,
  targetBytesPerSample: 1,
  now: routeClock(),
});
assert.equal(fresh.containerRegime, "fresh");
assert.equal(new Set(freshCandidate.seen).size, freshCandidate.seen.length);
assert.ok(freshCandidate.seen.every((input) => input instanceof Uint32Array));
assert.throws(
  () => measureDecodeRoutes({
    baseline: freshBaseline.adapter,
    candidate: freshCandidate.adapter,
    workloads: [],
    containerRegime: "blended",
  }),
  /containerRegime must be repeated or fresh/,
);

const subsetIds = Uint32Array.from({ length: 100 }, (_, index) => (index === 0 ? 1 : 0));
const subsetRuntime = Object.freeze({
  encodeSync: () => subsetIds,
  tokenBytes: (id) => id === 1 ? Uint8Array.of(0xff) : Uint8Array.of(0x61),
  decode: () => "a".repeat(4_096),
});
const subsetPricing = measureDecodeRoutes({
  baseline: subsetRuntime,
  candidate: subsetRuntime,
  workloads: [{ id: "candidate-subset", text: "a".repeat(8_192) }],
  candidateMode: "mixed",
  targetBytesPerSample: 1,
  n: 1,
  warmup: 0,
  now: routeClock(),
});
const subsetRow = subsetPricing.rows[0];
assert.equal(subsetRow.assemblySegments, 2);
assert.equal(subsetRow.candidateAssemblySegments, 0);
assert.equal(subsetRow.candidateAssembly, null);
assert.equal(subsetRow.candidateMillisecondsPerAssemblySegment, null);
assert.equal(subsetRow.candidateMinusAssemblyMillisecondsPerSegment, null);

console.log("decode throughput verifier PASS (exact output, statistics, ratios)");
console.log("decoded-output mutation RED (1/1)");
console.log("decode container regimes PASS (throughput and route pricing kept separate)");
console.log("throughput-preserves-hypertok-typed-decode-input PASS");
console.log("decode-route-pricing-uses-candidate-assembly-subset PASS");
