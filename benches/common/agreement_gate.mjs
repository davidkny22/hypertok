import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAgreementReceipt } from "./agreement_receipt.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");

export function loadAgreementReceipt(environment, runIdentity) {
  const resultPath = path.join(
    repositoryDirectory,
    "results",
    "harness",
    `${environment}-agreement.json`,
  );
  if (!fs.existsSync(resultPath)) {
    throw new Error(`Agreement must run before throughput: ${resultPath}`);
  }
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8").replace(/^\uFEFF/, ""));
  return assertAgreementReceipt(result.agreementReceipt, runIdentity);
}
