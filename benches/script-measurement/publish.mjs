import fs from "node:fs";
import { identityDigest } from "../common/identity.mjs";
import { writeRunResult } from "../common/output.mjs";
import { buildShippingRunIdentity } from "../common/shipping_identity.mjs";

const [
  reportPath,
  scalarWasmPath,
  simdWasmPath,
  hostScalarPath,
  hostSimdPath,
  referencePath,
  sourcePath,
  htkPath,
] = process.argv.slice(2);
const inputs = [
  reportPath,
  scalarWasmPath,
  simdWasmPath,
  hostScalarPath,
  hostSimdPath,
  referencePath,
  sourcePath,
  htkPath,
];
if (inputs.some((input) => typeof input !== "string" || !fs.existsSync(input))) {
  throw new Error("script decomposition publisher requires every report and artifact input");
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8").replace(/^\uFEFF/, ""));
const mode = process.env.HYPERTOK_BENCH_MODE ?? "full";
const environment = "local-decomposition";
const runIdentity = buildShippingRunIdentity({
  environment,
  commit: report.commit,
  artifacts: [
    { label: "wasm-scalar", filePath: scalarWasmPath },
    { label: "wasm-simd128", filePath: simdWasmPath },
    { label: "host-scalar", filePath: hostScalarPath },
    { label: "host-vector", filePath: hostSimdPath },
    { label: "gigatoken", filePath: referencePath },
    { label: "htk", filePath: htkPath },
  ],
});
const artifactSha256 = runIdentity.artifactSha256;
const agreementKey = identityDigest({
  runIdentityKey: runIdentity.runKey,
  agreement: report.agreement,
});
const result = {
  ...report,
  profile: "shipping",
  mode,
  environment,
  runIdentity,
  agreementKey,
  rows: report.rows.map((row) => ({
    ...row,
    profile: "shipping",
    mode,
    reference: row.reference ?? "hypertok",
    referenceVersion: row.referenceVersion ?? "0.10.0",
    ratio: null,
    agreementKey,
    artifactSha256,
    corpusSha256: runIdentity.corpusSha256,
    modelSha256: runIdentity.modelSha256,
  })),
};
const publicOutput = writeRunResult({
  runIdentity,
  mode,
  axis: "encode-decomposition",
  result,
});
fs.writeFileSync(reportPath, `${JSON.stringify(publicOutput.result, null, 2)}\n`);
console.log(publicOutput.resultPath);
