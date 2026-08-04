import assert from "node:assert/strict";
import { measureDecodeArtifactPair } from "../common/decode_artifact_pricing.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const runtime = Object.freeze({
  encodeSync: (text) => Uint32Array.from(encoder.encode(text)),
  decode: (ids) => decoder.decode(Uint8Array.from(ids)),
});
let tick = 0;
const report = measureDecodeArtifactPair({
  baseline: runtime,
  candidate: runtime,
  workloads: [{ id: "fixture", text: "decode artifact pair" }],
  n: 3,
  warmup: 1,
  now: () => ++tick,
});
assert.equal(report.rows.length, 1);
assert.equal(report.rows[0].candidateOverBaseline, 1);
assert.equal(report.rows[0].baselineOverCandidate, 1);
assert.equal(report.rows[0].baseline.n, 3);
assert.equal(report.rows[0].candidate.n, 3);

assert.throws(
  () => measureDecodeArtifactPair({
    baseline: runtime,
    candidate: { ...runtime, decode: () => "wrong" },
    workloads: [{ id: "mutation", text: "red" }],
    n: 1,
    warmup: 0,
  }),
  /candidate decode mismatch/,
);

console.log("decode artifact pricing PASS: rows=1 alternating=1 mutation_red=1");
