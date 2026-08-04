import { assertSameRunIdentity, identityDigest } from "./identity.mjs";

function receiptRow(row) {
  const base = {
    vocabulary: row.vocabulary,
    workload: row.workload,
    reference: row.reference,
    referenceVersion: row.referenceVersion,
    status: row.status,
  };
  if (row.status === "unavailable") return { ...base, reason: row.reason };
  return {
    ...base,
    tokenCount: row.tokenCount,
    tokenSha256: row.tokenSha256,
    mismatch: row.mismatch,
  };
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Agreement receipt requires at least one row");
  }
  const keys = new Set();
  for (const row of rows) {
    if (!["identical", "different", "unavailable"].includes(row.status)) {
      throw new Error(`Invalid agreement status: ${row.status}`);
    }
    if (row.status === "unavailable" && !row.reason) {
      throw new Error(`Unavailable reference lacks a reason: ${row.reference}`);
    }
    if (typeof row.vocabulary !== "string" || row.vocabulary.length === 0) {
      throw new Error("Agreement row requires vocabulary");
    }
    const key = `${row.vocabulary}\u0000${row.workload}\u0000${row.reference}`;
    if (keys.has(key)) throw new Error(`Duplicate agreement row: ${key}`);
    keys.add(key);
  }
}

export function buildAgreementReceipt(runIdentity, rows) {
  validateRows(rows);
  const normalizedRows = rows.map(receiptRow);
  const body = Object.freeze({
    schemaVersion: 1,
    runIdentity,
    rows: Object.freeze(normalizedRows),
  });
  return Object.freeze({ ...body, agreementKey: identityDigest(body) });
}

export function assertAgreementReceipt(receipt, expectedRunIdentity) {
  if (receipt?.schemaVersion !== 1 || receipt?.runIdentity === undefined) {
    throw new Error("Unsupported agreement receipt");
  }
  validateRows(receipt.rows);
  assertSameRunIdentity(expectedRunIdentity, receipt.runIdentity);
  const expectedKey = identityDigest({
    schemaVersion: receipt.schemaVersion,
    runIdentity: receipt.runIdentity,
    rows: receipt.rows.map(receiptRow),
  });
  if (receipt.agreementKey !== expectedKey) {
    throw new Error("Agreement receipt content does not match its key");
  }
  return receipt;
}

export function agreementForRow(receipt, vocabulary, workload, reference) {
  const row = receipt.rows.find(
    (candidate) =>
      candidate.vocabulary === vocabulary &&
      candidate.workload === workload &&
      candidate.reference === reference,
  );
  if (row === undefined) {
    throw new Error(`Agreement receipt lacks ${reference} on ${vocabulary}/${workload}`);
  }
  if (row.status === "unavailable") return row;
  return row;
}

export function requireComparableAgreement(receipt, vocabulary, workload, reference) {
  const row = agreementForRow(receipt, vocabulary, workload, reference);
  if (row.status === "unavailable") return row;
  if (row.status !== "identical") {
    throw new Error(`${reference} disagrees on ${workload}; no ratio may be reported`);
  }
  return row;
}
