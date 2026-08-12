const buildDefinitions = Object.freeze([
  Object.freeze(["forceSplit", "opt-force-split"]),
  Object.freeze(["blockDispatch", "opt-block-dispatch"]),
  Object.freeze(["relaxedSimd", "opt-relaxed-simd"]),
  Object.freeze(["denseGrid", "opt-dense-grid"]),
  Object.freeze(["scratchReuse", "opt-scratch-reuse"]),
  Object.freeze(["marshalling", "opt-marshalling"]),
  Object.freeze(["chunkPrescan", "opt-chunk-prescan"]),
  Object.freeze(["scanTwoPhase", "opt-scan-two-phase"]),
  Object.freeze(["levelSelect", "opt-level-select"]),
  Object.freeze(["residentDiet", "opt-resident-diet"]),
  Object.freeze(["coldDiet", "opt-cold-diet"]),
  Object.freeze(["fusedPairRanks", "opt-fused-pair-ranks"]),
  Object.freeze(["compactRanks", "opt-compact-ranks"]),
]);

const runtimeDefinitions = Object.freeze([
  Object.freeze(["lazyWorkerImage", true, "auto"]),
  Object.freeze(["decodeAssembly", true, "auto"]),
  Object.freeze(["decodeBorrowedOutput", true, "auto"]),
  Object.freeze(["decodeUtf16Output", false, "off"]),
  Object.freeze(["decodeHotStrings", false, "auto"]),
  Object.freeze(["decodeTable", true, "auto"]),
  Object.freeze(["decodeByteTable", false, "off"]),
  Object.freeze(["decodeMixedRuns", true, "auto"]),
  Object.freeze(["decodeRunCache", true, "auto"]),
  Object.freeze(["decodeLatin1Native", false, "off"]),
  Object.freeze(["decodeLatin1Portable", false, "off"]),
  Object.freeze(["decodeFusedValidation", true, "auto"]),
  Object.freeze(["decodeLeanDispatch", false, "off"]),
  Object.freeze(["decodeCleanUnroll", false, "off"]),
  Object.freeze(["decodeDirectScratch", true, "auto"]),
  Object.freeze(["decodeMemo", true, "auto"]),
  Object.freeze(["decodeDirtyRunBatch", false, "off"]),
]);

export const buildOptimizationKeys = Object.freeze(buildDefinitions.map(([key]) => key));
export const optimizationKeys = Object.freeze(runtimeDefinitions.map(([key]) => key));
export const admittedOptimizations = Object.freeze(
  runtimeDefinitions.filter(([, admitted]) => admitted).map(([key]) => key),
);
export const selectedBuildOptimizations = Object.freeze([
  "marshalling",
  "chunkPrescan",
  "scanTwoPhase",
  "levelSelect",
  "coldDiet",
  "fusedPairRanks",
]);
const buildFeatures = Object.freeze([
  ...buildDefinitions
    .filter(([key]) => selectedBuildOptimizations.includes(key))
    .map(([, feature]) => feature),
  "opt-decode-assembly",
  "opt-decode-borrowed-output",
  "opt-decode-utf16-output",
  "opt-resolver-provenance",
]);

const nodeRuntime =
  typeof process === "object" &&
  process !== null &&
  typeof process.versions?.node === "string";

function configurationObject(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("optimizations must be an object");
  }
  return value;
}

export function resolveOptimizationConfig(value) {
  const configuration = configurationObject(value);
  for (const key of Object.keys(configuration)) {
    if (buildOptimizationKeys.includes(key)) {
      throw new TypeError(`${key} is fixed when the WebAssembly artifact is built`);
    }
    if (!optimizationKeys.includes(key)) {
      throw new TypeError(`unknown optimization ${key}`);
    }
  }

  const states = {};
  const overrides = [];
  for (const [key, , defaultState] of runtimeDefinitions) {
    const provided = Object.hasOwn(configuration, key);
    const state = provided ? configuration[key] : defaultState;
    const candidate =
      key === "lazyWorkerImage" ||
      key === "decodeByteTable" ||
      key === "decodeBorrowedOutput" ||
      key === "decodeUtf16Output" ||
      key === "decodeMixedRuns" ||
      key === "decodeRunCache" ||
      key === "decodeLatin1Native" ||
      key === "decodeLatin1Portable" ||
      key === "decodeFusedValidation" ||
      key === "decodeLeanDispatch" ||
      key === "decodeCleanUnroll" ||
      key === "decodeDirectScratch" ||
      key === "decodeMemo" ||
      key === "decodeDirtyRunBatch";
    const explicitlyEnabled = candidate && state === "on";
    if (state !== "auto" && state !== "off" && !explicitlyEnabled) {
      const allowed = candidate ? "auto, on, or off" : "auto or off";
      throw new TypeError(`${key} must be ${allowed}`);
    }
    states[key] = state;
    if (provided && state !== "auto") {
      overrides.push(Object.freeze({ path: `hypertok.optimizations.${key}`, value: state }));
    }
  }

  const admitted = (key) => states[key] === "auto" && admittedOptimizations.includes(key);
  const assembly = admitted("decodeAssembly");
  if (states.decodeByteTable === "on" && states.decodeMixedRuns === "on") {
    throw new TypeError("decodeByteTable and decodeMixedRuns cannot both be on");
  }
  if (states.decodeBorrowedOutput === "on" && states.decodeUtf16Output === "on") {
    throw new TypeError("decodeBorrowedOutput and decodeUtf16Output cannot both be on");
  }
  const byteTable = assembly && (states.decodeByteTable === "on" || admitted("decodeByteTable"));
  const mixedRuns =
    assembly &&
    !byteTable &&
    (states.decodeMixedRuns === "on" || admitted("decodeMixedRuns"));
  const decode = Object.freeze({
    assembly,
    borrowedOutput:
      assembly &&
      (states.decodeBorrowedOutput === "on" || admitted("decodeBorrowedOutput")),
    utf16Output:
      assembly &&
      nodeRuntime &&
      (states.decodeUtf16Output === "on" || admitted("decodeUtf16Output")),
    hotStrings: assembly && admitted("decodeHotStrings"),
    table: assembly && admitted("decodeTable"),
    byteTable: byteTable && admitted("decodeTable"),
    mixedRuns: mixedRuns && admitted("decodeTable"),
    runCache:
      mixedRuns &&
      admitted("decodeTable") &&
      (states.decodeRunCache === "on" || admitted("decodeRunCache")),
    nativeLatin1:
      assembly &&
      admitted("decodeTable") &&
      (states.decodeLatin1Native === "on" || admitted("decodeLatin1Native")),
    portableLatin1:
      assembly &&
      admitted("decodeTable") &&
      (states.decodeLatin1Portable === "on" || admitted("decodeLatin1Portable")),
    fusedValidation:
      assembly &&
      admitted("decodeTable") &&
      (states.decodeFusedValidation === "on" || admitted("decodeFusedValidation")),
    leanDispatch:
      states.decodeLeanDispatch === "on" || admitted("decodeLeanDispatch"),
    cleanUnroll:
      states.decodeCleanUnroll === "on" || admitted("decodeCleanUnroll"),
    directScratch:
      mixedRuns &&
      admitted("decodeTable") &&
      (states.decodeDirectScratch === "on" || admitted("decodeDirectScratch")),
    memo: states.decodeMemo === "on" || admitted("decodeMemo"),
    dirtyRunBatch:
      mixedRuns &&
      admitted("decodeTable") &&
      (states.decodeDirtyRunBatch === "on" || admitted("decodeDirtyRunBatch")),
    raw: !assembly,
  });

  return Object.freeze({
    states: Object.freeze(states),
    admitted: admittedOptimizations,
    artifactFeatures: buildFeatures,
    artifactKey: buildFeatures.join(","),
    overrides: Object.freeze(overrides),
    lazyWorkerImage: states.lazyWorkerImage === "on" || admitted("lazyWorkerImage"),
    decode,
  });
}
