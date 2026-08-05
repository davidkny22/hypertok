import assert from "node:assert/strict";
import {
  loadCorpus,
  loadScriptCorpus,
  scriptStressIds,
  scriptWorkloadIds,
  workloadIds,
} from "../common/corpus.mjs";

const workloads = loadCorpus();

assert.deepEqual(
  workloads.map(({ id }) => id),
  workloadIds,
);
assert.equal(new Set(workloads.map(({ path }) => path)).size, workloads.length);
assert.ok(workloads.every(({ bytes }) => Number.isSafeInteger(bytes) && bytes > 0));
assert.ok(
  workloads.every(
    ({ bytes, fullBytes }) =>
      Number.isSafeInteger(fullBytes) && fullBytes >= bytes,
  ),
);
assert.ok(workloads.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256)));
assert.equal(workloads.find(({ id }) => id === "standard-text").source.standard, "Canterbury Corpus");
const openWebText = workloads.find(({ id }) => id === "openwebtext-slice");
assert.equal(openWebText.fullBytes, 50_000_000);
assert.equal(new TextEncoder().encode(openWebText.text).length, openWebText.bytes);

const scriptWorkloads = loadScriptCorpus();
assert.deepEqual(scriptWorkloads.map(({ id }) => id), scriptWorkloadIds);
assert.deepEqual(
  scriptWorkloads.filter(({ role }) => role === "script-stress").map(({ id }) => id),
  scriptStressIds,
);
assert.throws(() => loadCorpus({ roles: ["unknown"] }), /Unsupported corpus roles/);

for (const { id, bytes, sha256 } of workloads) {
  console.log(`${id}: bytes=${bytes}; sha256=${sha256}`);
}
console.log(`corpus verification PASS (${workloads.length}/${workloadIds.length} workloads)`);
console.log(`script corpus verification PASS (${scriptWorkloads.length}/${scriptWorkloadIds.length} workloads)`);
console.log("unknown corpus role mutation RED");
