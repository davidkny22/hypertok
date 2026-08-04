import crypto from "node:crypto";

function tokenDigest(ids) {
  const bytes = Buffer.allocUnsafe(ids.length * 4);
  ids.forEach((id, index) => bytes.writeUInt32LE(id, index * 4));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function firstMismatch(expected, actual) {
  const limit = Math.min(expected.length, actual.length);
  for (let index = 0; index < limit; index += 1) {
    if (expected[index] !== actual[index]) {
      return { index, expected: expected[index], actual: actual[index] };
    }
  }
  if (expected.length !== actual.length) {
    return {
      index: limit,
      expected: expected[limit] ?? null,
      actual: actual[limit] ?? null,
    };
  }
  return null;
}

export function buildAgreementMatrix(
  workloads,
  adapters,
  unavailableReferences = [],
  { vocabulary = "gpt2", oracleReference = "@huggingface/tokenizers" } = {},
) {
  const oracle = adapters.find(({ id }) => id === oracleReference);
  if (oracle === undefined) throw new Error(`${oracleReference} must be the agreement oracle`);

  const rows = [];
  for (const workload of workloads) {
    const oracleIds = oracle.encode(workload.text);
    for (const current of adapters) {
      const ids = current === oracle ? oracleIds : current.encode(workload.text);
      const mismatch = firstMismatch(oracleIds, ids);
      rows.push({
        vocabulary,
        workload: workload.id,
        workloadBytes: workload.bytes,
        reference: current.id,
        referenceVersion: current.version,
        status: mismatch === null ? "identical" : "different",
        tokenCount: ids.length,
        tokenSha256: tokenDigest(ids),
        mismatch,
        tier: current.tier,
        simdLevel: current.simdLevel,
      });
    }
    for (const current of unavailableReferences) {
      rows.push({
        vocabulary,
        workload: workload.id,
        workloadBytes: workload.bytes,
        reference: current.id,
        referenceVersion: current.version,
        status: "unavailable",
        reason: current.reason,
      });
    }
  }
  return Object.freeze(rows);
}
