import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  admittedOptimizations,
  buildOptimizationKeys,
  optimizationKeys,
  resolveOptimizationConfig,
  selectedBuildOptimizations,
} from "../../hypertok-js/src/optimization-config.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const automatic = resolveOptimizationConfig();
assert.deepEqual(automatic.decode, {
  assembly: true,
  borrowedOutput: true,
  utf16Output: false,
  hotStrings: false,
  table: true,
  byteTable: false,
  mixedRuns: true,
  runCache: true,
  nativeLatin1: false,
  portableLatin1: false,
  fusedValidation: true,
  leanDispatch: false,
  cleanUnroll: false,
  directScratch: true,
  memo: true,
  dirtyRunBatch: true,
  stringBuiltins: false,
  raw: false,
});
assert.deepEqual(automatic.admitted, admittedOptimizations);
assert.deepEqual(automatic.overrides, []);

const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
    cwd: repository,
    encoding: "utf8",
  }),
);
const rootPackage = metadata.packages.find(({ manifest_path: manifestPath }) =>
  path.resolve(manifestPath) === path.join(repository, "Cargo.toml")
);
assert.ok(rootPackage, "Cargo metadata omitted the root package");
for (const feature of automatic.artifactFeatures) {
  assert.ok(Object.hasOwn(rootPackage.features, feature), `artifact feature is undeclared: ${feature}`);
}
assert.ok(
  selectedBuildOptimizations.every((key) => buildOptimizationKeys.includes(key)),
  "the selected artifact uses an unknown build-time optimization",
);

let buildRefusals = 0;
for (const key of buildOptimizationKeys) {
  for (const state of ["auto", "off"]) {
    assert.throws(
      () => resolveOptimizationConfig({ [key]: state }),
      new RegExp(`${key} is fixed when the WebAssembly artifact is built`),
    );
    buildRefusals += 1;
  }
}

let runtimeChecks = 0;
for (const key of optimizationKeys) {
  const resolved = resolveOptimizationConfig({ [key]: "off" });
  assert.equal(resolved.states[key], "off");
  assert.deepEqual(resolved.overrides, [
    { path: `hypertok.optimizations.${key}`, value: "off" },
  ]);
  assert.deepEqual(
    resolved.artifactFeatures,
    automatic.artifactFeatures,
    `${key} must not rewrite compile-time artifact facts`,
  );
  assert.equal(resolved.artifactKey, automatic.artifactKey);
  assert.throws(() => resolveOptimizationConfig({ [key]: true }), TypeError);
  runtimeChecks += 1;
}

const tableOff = resolveOptimizationConfig({ decodeTable: "off" });
assert.deepEqual(tableOff.decode, {
  assembly: true,
  borrowedOutput: true,
  utf16Output: false,
  hotStrings: false,
  table: false,
  byteTable: false,
  mixedRuns: false,
  runCache: false,
  nativeLatin1: false,
  portableLatin1: false,
  fusedValidation: false,
  leanDispatch: false,
  cleanUnroll: false,
  directScratch: false,
  memo: true,
  dirtyRunBatch: false,
  stringBuiltins: false,
  raw: false,
});
const assemblyOff = resolveOptimizationConfig({ decodeAssembly: "off" });
assert.deepEqual(assemblyOff.decode, {
  assembly: false,
  borrowedOutput: false,
  utf16Output: false,
  hotStrings: false,
  table: false,
  byteTable: false,
  mixedRuns: false,
  runCache: false,
  nativeLatin1: false,
  portableLatin1: false,
  fusedValidation: false,
  leanDispatch: false,
  cleanUnroll: false,
  directScratch: false,
  memo: true,
  dirtyRunBatch: false,
  stringBuiltins: false,
  raw: true,
});

const byteTableOn = resolveOptimizationConfig({ decodeByteTable: "on" });
assert.equal(byteTableOn.states.decodeByteTable, "on");
assert.equal(byteTableOn.decode.byteTable, true);
assert.deepEqual(byteTableOn.overrides, [
  { path: "hypertok.optimizations.decodeByteTable", value: "on" },
]);
assert.throws(() => resolveOptimizationConfig({ decodeAssembly: "on" }), /auto or off/);

const borrowedOutputOn = resolveOptimizationConfig({ decodeBorrowedOutput: "on" });
assert.equal(borrowedOutputOn.states.decodeBorrowedOutput, "on");
assert.equal(borrowedOutputOn.decode.borrowedOutput, true);
assert.deepEqual(borrowedOutputOn.overrides, [
  { path: "hypertok.optimizations.decodeBorrowedOutput", value: "on" },
]);

const utf16OutputOn = resolveOptimizationConfig({ decodeUtf16Output: "on" });
assert.equal(utf16OutputOn.states.decodeUtf16Output, "on");
assert.equal(utf16OutputOn.decode.utf16Output, true);
assert.deepEqual(utf16OutputOn.overrides, [
  { path: "hypertok.optimizations.decodeUtf16Output", value: "on" },
]);

const mixedRunsOn = resolveOptimizationConfig({ decodeMixedRuns: "on" });
assert.equal(mixedRunsOn.states.decodeMixedRuns, "on");
assert.equal(mixedRunsOn.decode.mixedRuns, true);
assert.deepEqual(mixedRunsOn.overrides, [
  { path: "hypertok.optimizations.decodeMixedRuns", value: "on" },
]);
const runCacheOn = resolveOptimizationConfig({ decodeRunCache: "on" });
assert.equal(runCacheOn.states.decodeRunCache, "on");
assert.equal(runCacheOn.decode.runCache, true);
assert.deepEqual(runCacheOn.overrides, [
  { path: "hypertok.optimizations.decodeRunCache", value: "on" },
]);
const nativeLatin1On = resolveOptimizationConfig({ decodeLatin1Native: "on" });
assert.equal(nativeLatin1On.states.decodeLatin1Native, "on");
assert.equal(nativeLatin1On.decode.nativeLatin1, true);
assert.deepEqual(nativeLatin1On.overrides, [
  { path: "hypertok.optimizations.decodeLatin1Native", value: "on" },
]);
const portableLatin1On = resolveOptimizationConfig({ decodeLatin1Portable: "on" });
assert.equal(portableLatin1On.states.decodeLatin1Portable, "on");
assert.equal(portableLatin1On.decode.portableLatin1, true);
assert.deepEqual(portableLatin1On.overrides, [
  { path: "hypertok.optimizations.decodeLatin1Portable", value: "on" },
]);
const fusedValidationOn = resolveOptimizationConfig({ decodeFusedValidation: "on" });
assert.equal(fusedValidationOn.states.decodeFusedValidation, "on");
assert.equal(fusedValidationOn.decode.fusedValidation, true);
assert.deepEqual(fusedValidationOn.overrides, [
  { path: "hypertok.optimizations.decodeFusedValidation", value: "on" },
]);
const leanDispatchOn = resolveOptimizationConfig({ decodeLeanDispatch: "on" });
assert.equal(leanDispatchOn.states.decodeLeanDispatch, "on");
assert.equal(leanDispatchOn.decode.leanDispatch, true);
assert.deepEqual(leanDispatchOn.overrides, [
  { path: "hypertok.optimizations.decodeLeanDispatch", value: "on" },
]);
const cleanUnrollOn = resolveOptimizationConfig({ decodeCleanUnroll: "on" });
assert.equal(cleanUnrollOn.states.decodeCleanUnroll, "on");
assert.equal(cleanUnrollOn.decode.cleanUnroll, true);
assert.deepEqual(cleanUnrollOn.overrides, [
  { path: "hypertok.optimizations.decodeCleanUnroll", value: "on" },
]);
const directScratchOn = resolveOptimizationConfig({ decodeDirectScratch: "on" });
assert.equal(directScratchOn.states.decodeDirectScratch, "on");
assert.equal(directScratchOn.decode.directScratch, true);
assert.deepEqual(directScratchOn.overrides, [
  { path: "hypertok.optimizations.decodeDirectScratch", value: "on" },
]);
const memoOn = resolveOptimizationConfig({ decodeMemo: "on" });
assert.equal(memoOn.states.decodeMemo, "on");
assert.equal(memoOn.decode.memo, true);
assert.deepEqual(memoOn.overrides, [
  { path: "hypertok.optimizations.decodeMemo", value: "on" },
]);
const dirtyRunBatchOn = resolveOptimizationConfig({ decodeDirtyRunBatch: "on" });
assert.equal(dirtyRunBatchOn.states.decodeDirtyRunBatch, "on");
assert.equal(dirtyRunBatchOn.decode.dirtyRunBatch, true);
assert.deepEqual(dirtyRunBatchOn.overrides, [
  { path: "hypertok.optimizations.decodeDirtyRunBatch", value: "on" },
]);
assert.throws(
  () => resolveOptimizationConfig({ decodeByteTable: "on", decodeMixedRuns: "on" }),
  /cannot both be on/,
);
assert.throws(
  () => resolveOptimizationConfig({ decodeBorrowedOutput: "on", decodeUtf16Output: "on" }),
  /cannot both be on/,
);

const allOff = resolveOptimizationConfig(
  Object.fromEntries(optimizationKeys.map((key) => [key, "off"])),
);
assert.deepEqual(allOff.artifactFeatures, automatic.artifactFeatures);
assert.equal(allOff.artifactKey, automatic.artifactKey);
assert.equal(allOff.overrides.length, optimizationKeys.length);
assert.equal(allOff.decode.raw, true);

let mutationRed = false;
try {
  assert.deepEqual({ ...tableOff.decode, table: true }, tableOff.decode);
} catch {
  mutationRed = true;
}
assert.equal(mutationRed, true, "decode-table behavior mutation did not go RED");

let generalRefusals = 0;
for (const invalid of [null, [], "auto"]) {
  assert.throws(() => resolveOptimizationConfig(invalid), TypeError);
  generalRefusals += 1;
}
assert.throws(() => resolveOptimizationConfig({ unknownOptimization: "auto" }), TypeError);
generalRefusals += 1;

console.log(
  `configuration behavior PASS: runtime=${runtimeChecks} build_refusals=${buildRefusals} fixed_artifact_features=${automatic.artifactFeatures.length} decode_mutation_red=1`,
);
console.log(`configuration refusals PASS (${generalRefusals}/${generalRefusals})`);
