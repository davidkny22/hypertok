// hypertok-js/src/optimization-config.mjs
var buildDefinitions = Object.freeze([
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
  Object.freeze(["compactRanks", "opt-compact-ranks"])
]);
var runtimeDefinitions = Object.freeze([
  Object.freeze(["decodeAssembly", true, "auto"]),
  Object.freeze(["decodeBoundary", false, "auto"]),
  Object.freeze(["decodeHotStrings", false, "auto"]),
  Object.freeze(["decodeTable", true, "auto"]),
  Object.freeze(["decodeByteTable", false, "off"]),
  Object.freeze(["decodeMixedRuns", true, "auto"]),
  Object.freeze(["decodeRunCache", true, "auto"]),
  Object.freeze(["decodeLatin1Native", false, "off"]),
  Object.freeze(["decodeLatin1Portable", false, "off"]),
  Object.freeze(["decodeFusedValidation", true, "auto"]),
  Object.freeze(["decodeLeanDispatch", false, "off"]),
  Object.freeze(["decodeMemo", true, "auto"])
]);
var buildOptimizationKeys = Object.freeze(buildDefinitions.map(([key]) => key));
var optimizationKeys = Object.freeze(runtimeDefinitions.map(([key]) => key));
var admittedOptimizations = Object.freeze(
  runtimeDefinitions.filter(([, admitted]) => admitted).map(([key]) => key)
);
var selectedBuildOptimizations = Object.freeze([
  "marshalling",
  "chunkPrescan",
  "scanTwoPhase",
  "levelSelect",
  "coldDiet",
  "fusedPairRanks",
  "compactRanks"
]);
var buildFeatures = Object.freeze([
  ...buildDefinitions.filter(([key]) => selectedBuildOptimizations.includes(key)).map(([, feature]) => feature),
  "opt-decode-assembly"
]);
function configurationObject(value) {
  if (value === void 0) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("optimizations must be an object");
  }
  return value;
}
function resolveOptimizationConfig(value) {
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
    const candidate = key === "decodeByteTable" || key === "decodeMixedRuns" || key === "decodeRunCache" || key === "decodeLatin1Native" || key === "decodeLatin1Portable" || key === "decodeFusedValidation" || key === "decodeLeanDispatch" || key === "decodeMemo";
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
  const byteTable = assembly && (states.decodeByteTable === "on" || admitted("decodeByteTable"));
  const mixedRuns = assembly && !byteTable && (states.decodeMixedRuns === "on" || admitted("decodeMixedRuns"));
  const decode = Object.freeze({
    assembly,
    boundary: assembly && admitted("decodeBoundary"),
    hotStrings: assembly && admitted("decodeHotStrings"),
    table: assembly && admitted("decodeTable"),
    byteTable: byteTable && admitted("decodeTable"),
    mixedRuns: mixedRuns && admitted("decodeTable"),
    runCache: mixedRuns && admitted("decodeTable") && (states.decodeRunCache === "on" || admitted("decodeRunCache")),
    nativeLatin1: assembly && admitted("decodeTable") && (states.decodeLatin1Native === "on" || admitted("decodeLatin1Native")),
    portableLatin1: assembly && admitted("decodeTable") && (states.decodeLatin1Portable === "on" || admitted("decodeLatin1Portable")),
    fusedValidation: assembly && admitted("decodeTable") && (states.decodeFusedValidation === "on" || admitted("decodeFusedValidation")),
    leanDispatch: states.decodeLeanDispatch === "on" || admitted("decodeLeanDispatch"),
    memo: states.decodeMemo === "on" || admitted("decodeMemo"),
    raw: !assembly
  });
  return Object.freeze({
    states: Object.freeze(states),
    admitted: admittedOptimizations,
    artifactFeatures: buildFeatures,
    artifactKey: buildFeatures.join(","),
    overrides: Object.freeze(overrides),
    decode
  });
}

// hypertok-js/src/decode-assembly.mjs
function tokenIds(input) {
  if (input instanceof Uint32Array) return input;
  if (Array.isArray(input) && input.every(
    (value) => Number.isInteger(value) && value >= 0 && value <= 4294967295
  )) {
    return Uint32Array.from(input);
  }
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}
function createAssemblyDecoder(core) {
  if (core === null || typeof core !== "object" || typeof core.decodeAssemblyBytes !== "function") {
    throw new TypeError("assembly core must provide decodeAssemblyBytes");
  }
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let calls = 0;
  function decode(input) {
    const bytes = core.decodeAssemblyBytes(tokenIds(input));
    calls += 1;
    return decoder.decode(bytes);
  }
  return Object.freeze({
    decode,
    stats: () => Object.freeze({ decoderCalls: calls })
  });
}

// hypertok-js/src/decode-boundary.mjs
function tokenIds2(input) {
  if (input instanceof Uint32Array) return input;
  if (Array.isArray(input) && input.every(
    (value) => Number.isInteger(value) && value >= 0 && value <= 4294967295
  )) {
    return Uint32Array.from(input);
  }
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}
var METHODS = [
  "decodeBoundaryBytes",
  "growResidentDecodeIds",
  "residentDecodeIdsCapacity",
  "residentDecodeIdsHighWater",
  "residentDecodeIdsView"
];
function createBoundaryDecoder(core) {
  if (core === null || typeof core !== "object" || METHODS.some((method) => typeof core[method] !== "function")) {
    throw new TypeError("boundary core must provide the resident decode id seam");
  }
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let capacity2 = core.residentDecodeIdsCapacity();
  let decoderCalls = 0;
  let growCalls = 0;
  let highWater = core.residentDecodeIdsHighWater();
  let view = null;
  let viewAcquisitions = 0;
  let viewWrites = 0;
  function decode(input) {
    const ids = tokenIds2(input);
    while (capacity2 < ids.length) {
      view = null;
      core.growResidentDecodeIds();
      capacity2 *= 2;
      highWater = Math.max(highWater, capacity2);
      growCalls += 1;
    }
    if (view === null || view.byteLength === 0) {
      view = core.residentDecodeIdsView();
      viewAcquisitions += 1;
    }
    if (view.length < ids.length) {
      throw new Error("resident decode id view is shorter than its reported capacity");
    }
    view.subarray(0, ids.length).set(ids);
    viewWrites += 1;
    const shrinks = highWater > 1048576 && ids.length < highWater / 4;
    const bytes = core.decodeBoundaryBytes(ids.length);
    if (shrinks) {
      capacity2 = 1048576;
      highWater = 1048576;
      view = null;
    }
    decoderCalls += 1;
    return decoder.decode(bytes);
  }
  return Object.freeze({
    decode,
    stats: () => Object.freeze({
      decoderCalls,
      growCalls,
      highWaterIds: highWater,
      viewAcquisitions,
      viewWrites
    })
  });
}

// hypertok-js/src/decode-hotstrings.mjs
var DEFAULT_MAX_ENTRIES = 8192;
var DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
var DEFAULT_MAX_INDEX_BYTES = 1024 * 1024;
var DEFAULT_MIN_COVERAGE = 0.9;
function positiveInteger(value, fallback, name) {
  if (value === void 0) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
function tokenIds3(input) {
  if (input instanceof Uint32Array) return input;
  if (Array.isArray(input) && input.every(
    (value) => Number.isInteger(value) && value >= 0 && value <= 4294967295
  )) {
    return Uint32Array.from(input);
  }
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}
function assertCore(core) {
  if (core === null || typeof core !== "object" || typeof core.decode !== "function" || typeof core.tokenBytes !== "function") {
    throw new TypeError("decode core must provide decode and tokenBytes functions");
  }
}
function vocabSize(core) {
  const value = typeof core.vocabSize === "function" ? core.vocabSize() : core.vocabSize;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function createHotStringDecoder(core, options = {}) {
  assertCore(core);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("hot-string options must be an object");
  }
  const maxEntries = positiveInteger(
    options.maxEntries,
    DEFAULT_MAX_ENTRIES,
    "maxEntries"
  );
  const maxPayloadBytes = positiveInteger(
    options.maxPayloadBytes,
    DEFAULT_MAX_PAYLOAD_BYTES,
    "maxPayloadBytes"
  );
  const maxIndexBytes = positiveInteger(
    options.maxIndexBytes,
    DEFAULT_MAX_INDEX_BYTES,
    "maxIndexBytes"
  );
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;
  if (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) {
    throw new TypeError("minCoverage must be between zero and one");
  }
  const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
  const size = vocabSize(core);
  let directIndex = size !== null && size * 4 <= maxIndexBytes ? new Int32Array(size) : null;
  const cachedStrings = [];
  const sparseCache = directIndex === null ? /* @__PURE__ */ new Map() : null;
  let initialized = false;
  let active = false;
  let observedTokens = 0;
  let observedDistinct = 0;
  let coveredTokens = 0;
  let payloadBytes = 0;
  const cacheSize = () => active ? coveredDistinct : 0;
  let coveredDistinct = 0;
  function cachedString(id) {
    if (directIndex === null) return sparseCache.get(id);
    const slot = directIndex[id];
    return slot === 0 ? void 0 : cachedStrings[slot - 1];
  }
  function initialize(ids) {
    if (initialized || ids.length === 0) return;
    let frequency;
    let selected;
    if (directIndex !== null) {
      const counts = new Uint32Array(directIndex.length);
      for (const id of ids) {
        if (id >= counts.length) {
          core.tokenBytes(id);
          throw new Error(`token id ${id} exceeds vocabSize`);
        }
        if (counts[id] === 0) observedDistinct += 1;
        counts[id] += 1;
      }
      frequency = (id) => counts[id];
      const capacity2 = Math.min(maxEntries, observedDistinct);
      const heapIds = new Uint32Array(capacity2);
      const heapCounts = new Uint32Array(capacity2);
      let heapSize = 0;
      const worse = (leftCount, leftId, rightCount, rightId) => leftCount < rightCount || leftCount === rightCount && leftId > rightId;
      const swap = (left, right) => {
        [heapIds[left], heapIds[right]] = [heapIds[right], heapIds[left]];
        [heapCounts[left], heapCounts[right]] = [heapCounts[right], heapCounts[left]];
      };
      const push = (id, count) => {
        let index = heapSize;
        heapSize += 1;
        heapIds[index] = id;
        heapCounts[index] = count;
        while (index !== 0) {
          const parent = Math.floor((index - 1) / 2);
          if (!worse(heapCounts[index], heapIds[index], heapCounts[parent], heapIds[parent])) break;
          swap(index, parent);
          index = parent;
        }
      };
      const replaceWorst = (id, count) => {
        heapIds[0] = id;
        heapCounts[0] = count;
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          if (left >= heapSize) break;
          const right = left + 1;
          let child = left;
          if (right < heapSize && worse(heapCounts[right], heapIds[right], heapCounts[left], heapIds[left])) {
            child = right;
          }
          if (!worse(heapCounts[child], heapIds[child], heapCounts[index], heapIds[index])) break;
          swap(index, child);
          index = child;
        }
      };
      for (let id = 0; id < counts.length; id += 1) {
        const count = counts[id];
        if (count === 0) continue;
        if (heapSize < capacity2) push(id, count);
        else if (worse(heapCounts[0], heapIds[0], count, id)) replaceWorst(id, count);
      }
      selected = heapIds;
    } else {
      const counts = /* @__PURE__ */ new Map();
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      selected = [...counts.keys()];
      observedDistinct = selected.length;
      frequency = (id) => counts.get(id);
      selected.sort(
        (leftId, rightId) => frequency(rightId) - frequency(leftId) || leftId - rightId
      );
      selected.length = Math.min(selected.length, maxEntries);
    }
    observedTokens = ids.length;
    for (const id of selected) {
      if (coveredDistinct === maxEntries) break;
      const bytes = core.tokenBytes(id);
      let text;
      try {
        text = fatalDecoder.decode(bytes);
      } catch (error) {
        if (error instanceof TypeError) continue;
        throw error;
      }
      const retainedBytes = text.length * 2;
      if (payloadBytes + retainedBytes > maxPayloadBytes) continue;
      if (directIndex === null) sparseCache.set(id, text);
      else {
        cachedStrings.push(text);
        directIndex[id] = cachedStrings.length;
      }
      coveredDistinct += 1;
      payloadBytes += retainedBytes;
      coveredTokens += frequency(id);
    }
    const coverage = coveredTokens / observedTokens;
    const repeatedSingleUnits = observedTokens >= 65536 && coverage === 1 && observedDistinct <= 2 && coveredDistinct !== 0 && payloadBytes / coveredDistinct <= 2;
    active = coverage >= minCoverage && !repeatedSingleUnits;
    if (!active) {
      cachedStrings.length = 0;
      sparseCache?.clear();
      directIndex = null;
      coveredDistinct = 0;
      payloadBytes = 0;
    }
    initialized = true;
  }
  function decode(input) {
    const ids = tokenIds3(input);
    if (ids.length === 0) return core.decode(ids);
    initialize(ids);
    if (!active) return core.decode(ids);
    let output = "";
    let index = 0;
    while (index < ids.length) {
      const cached = cachedString(ids[index]);
      if (cached !== void 0) {
        output += cached;
        index += 1;
        continue;
      }
      const start = index;
      do {
        index += 1;
      } while (index < ids.length && cachedString(ids[index]) === void 0);
      output += core.decode(ids.subarray(start, index));
    }
    return output;
  }
  function stats() {
    return Object.freeze({
      initialized,
      active,
      entries: cacheSize(),
      maxEntries,
      payloadBytes,
      maxPayloadBytes,
      indexKind: initialized && !active ? "none" : directIndex === null ? "sparse" : "direct",
      indexBytes: directIndex === null ? 0 : directIndex.byteLength,
      maxIndexBytes,
      minCoverage,
      observedTokens,
      observedDistinct,
      coveredTokens,
      observedCoverage: observedTokens === 0 ? 0 : coveredTokens / observedTokens
    });
  }
  function tokenString(id) {
    return active ? cachedString(id) : void 0;
  }
  return Object.freeze({ decode, stats, tokenString });
}

// hypertok-js/src/decode-memo.mjs
var DEFAULT_MAX_ENTRIES2 = 512;
var DEFAULT_MAX_IDS = 4096;
var DEFAULT_MAX_OUTPUT_CODE_UNITS = 8192;
var PROBE_ENTRIES = 8;
var PENDING = Object.freeze({ state: "pending" });
var UNCACHEABLE = Object.freeze({ state: "uncacheable" });
function positiveInteger2(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}
function nonSharedUint32Array(input) {
  if (!(input instanceof Uint32Array) || Object.getPrototypeOf(input) !== Uint32Array.prototype) {
    return false;
  }
  return !(typeof SharedArrayBuffer === "function" && input.buffer instanceof SharedArrayBuffer);
}
function memoContainer(input) {
  if (Array.isArray(input)) {
    return Object.getPrototypeOf(input) === Array.prototype;
  }
  return nonSharedUint32Array(input);
}
function plainDenseArray(input) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    return false;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (lengthDescriptor === void 0 || lengthDescriptor.get !== void 0 || lengthDescriptor.set !== void 0 || lengthDescriptor.value !== input.length || lengthDescriptor.writable !== true) {
    return false;
  }
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === void 0 || descriptor.get !== void 0 || descriptor.set !== void 0 || descriptor.enumerable !== true || descriptor.configurable !== true || descriptor.writable !== true) {
      return false;
    }
  }
  return true;
}
function snapshot(input, maxIds) {
  if (input.length === 0 || input.length > maxIds) return null;
  if (!nonSharedUint32Array(input) && !plainDenseArray(input)) return null;
  const output = new Uint32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (typeof value !== "number" || value >>> 0 !== value) return null;
    output[index] = value;
  }
  return output;
}
function sameContents(input, expected) {
  if (input.length !== expected.length) return false;
  if (!nonSharedUint32Array(input) && !Array.isArray(input)) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (input[index] !== expected[index]) return false;
  }
  return true;
}
function createDecodeMemo(decoder, options = {}) {
  if (decoder === null || typeof decoder !== "object" || typeof decoder.decode !== "function") {
    throw new TypeError("decode memo requires a decoder");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("decode memo options must be an object");
  }
  const maxEntries = positiveInteger2(options.maxEntries, DEFAULT_MAX_ENTRIES2, "maxEntries");
  const maxIds = positiveInteger2(options.maxIds, DEFAULT_MAX_IDS, "maxIds");
  const maxOutputCodeUnits = positiveInteger2(
    options.maxOutputCodeUnits,
    DEFAULT_MAX_OUTPUT_CODE_UNITS,
    "maxOutputCodeUnits"
  );
  const records = /* @__PURE__ */ new WeakMap();
  const slots = new Array(maxEntries);
  let nextSlot = 0;
  let entries = 0;
  let snapshotBytes = 0;
  let outputCodeUnits = 0;
  let hits = 0;
  let misses = 0;
  let mismatches = 0;
  let uncacheable = 0;
  let evictions = 0;
  let tracking = false;
  const probes = new Array(PROBE_ENTRIES);
  let probeCount = 0;
  function removeRecord(record) {
    const key = record.key.deref();
    if (key !== void 0 && records.get(key) === record) records.delete(key);
    snapshotBytes -= record.snapshot.byteLength;
    outputCodeUnits -= record.output.length;
    entries -= 1;
  }
  function store(input, value) {
    if (typeof value !== "string" || value.length > maxOutputCodeUnits) {
      uncacheable += 1;
      records.set(input, UNCACHEABLE);
      return false;
    }
    const inputSnapshot = snapshot(input, maxIds);
    if (inputSnapshot === null) {
      uncacheable += 1;
      records.set(input, UNCACHEABLE);
      return false;
    }
    const existing = records.get(input);
    if (existing !== void 0 && existing !== PENDING && existing !== UNCACHEABLE) {
      snapshotBytes += inputSnapshot.byteLength - existing.snapshot.byteLength;
      outputCodeUnits += value.length - existing.output.length;
      existing.snapshot = inputSnapshot;
      existing.output = value;
      return true;
    }
    const displaced = slots[nextSlot];
    if (displaced !== void 0) {
      removeRecord(displaced);
      evictions += 1;
    }
    const record = {
      key: new WeakRef(input),
      snapshot: inputSnapshot,
      output: value
    };
    slots[nextSlot] = record;
    nextSlot = (nextSlot + 1) % maxEntries;
    records.set(input, record);
    snapshotBytes += inputSnapshot.byteLength;
    outputCodeUnits += value.length;
    entries += 1;
    return true;
  }
  function prime(input, value) {
    if (typeof value !== "string" || value.length > maxOutputCodeUnits || input.length === 0 || input.length > maxIds) {
      uncacheable += 1;
      records.set(input, UNCACHEABLE);
      return;
    }
    records.set(input, PENDING);
  }
  function decode(input) {
    if (!tracking) {
      let repeatedProbe = false;
      for (let index = 0; index < probeCount; index += 1) {
        if (input === probes[index]) {
          repeatedProbe = true;
          break;
        }
      }
      misses += 1;
      const output2 = decoder.decode(input);
      if (repeatedProbe) {
        tracking = store(input, output2);
        probes.fill(void 0);
        probeCount = 0;
      } else if (probeCount < PROBE_ENTRIES && memoContainer(input) && typeof output2 === "string" && output2.length <= maxOutputCodeUnits && input.length > 0 && input.length <= maxIds) {
        probes[probeCount] = input;
        probeCount += 1;
      }
      return output2;
    }
    const eligible = memoContainer(input);
    const record = eligible ? records.get(input) : void 0;
    if (record !== void 0 && record !== PENDING && record !== UNCACHEABLE) {
      if (sameContents(input, record.snapshot)) {
        hits += 1;
        return record.output;
      }
      mismatches += 1;
    }
    misses += 1;
    const output = decoder.decode(input);
    if (record === UNCACHEABLE) {
      uncacheable += 1;
    } else if (record === void 0 && eligible) {
      prime(input, output);
    } else {
      store(input, output);
    }
    return output;
  }
  function stats() {
    return Object.freeze({
      maxEntries,
      maxIds,
      maxOutputCodeUnits,
      tracking,
      probeEntries: probeCount,
      entries,
      snapshotBytes,
      outputCodeUnits,
      hits,
      misses,
      mismatches,
      uncacheable,
      evictions
    });
  }
  return Object.freeze({ decode, stats });
}

// hypertok-js/src/decode-run-cache.mjs
var DEFAULT_CAPACITY = 8;
function capacity(value) {
  if (value === void 0) return DEFAULT_CAPACITY;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("capacity must be a positive safe integer");
  }
  return value;
}
function keyFor(ids, start, end) {
  let key = "";
  for (let index = start; index < end; index += 1) {
    const id = ids[index];
    key += String.fromCharCode(id >>> 16, id & 65535);
  }
  return key;
}
function createMaximalRunCache(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("maximal-run cache options must be an object");
  }
  const limit = capacity(options.capacity);
  const entries = /* @__PURE__ */ new Map();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let keyCodeUnits = 0;
  let outputCodeUnits = 0;
  function decode(ids, start, end, canonical) {
    const key = keyFor(ids, start, end);
    if (entries.has(key)) {
      const output2 = entries.get(key);
      entries.delete(key);
      entries.set(key, output2);
      hits += 1;
      return output2;
    }
    misses += 1;
    const output = canonical();
    if (typeof output !== "string") {
      throw new TypeError("canonical maximal-run decoder must return a string");
    }
    if (entries.size === limit) {
      const oldest = entries.keys().next().value;
      const evicted = entries.get(oldest);
      entries.delete(oldest);
      keyCodeUnits -= oldest.length;
      outputCodeUnits -= evicted.length;
      evictions += 1;
    }
    entries.set(key, output);
    keyCodeUnits += key.length;
    outputCodeUnits += output.length;
    return output;
  }
  function stats() {
    return Object.freeze({
      capacity: limit,
      entries: entries.size,
      hits,
      misses,
      evictions,
      keyCodeUnits,
      outputCodeUnits
    });
  }
  return Object.freeze({ decode, stats });
}

// hypertok-js/src/decode-latin1.mjs
function validTokenId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 4294967295;
}
function tokenContainer(input) {
  if (input instanceof Uint32Array || Array.isArray(input)) return input;
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}
function vocabSize2(core) {
  const value = typeof core.vocabSize === "function" ? core.vocabSize() : core.vocabSize;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Latin-1 decode core must provide a positive vocabSize");
  }
  return value;
}
function byteString(bytes) {
  let output = "";
  for (let start = 0; start < bytes.length; start += 4096) {
    output += String.fromCharCode(...bytes.subarray(start, start + 4096));
  }
  return output;
}
function defaultNativeUnmap(value) {
  const buffer = globalThis.Buffer;
  return typeof buffer?.from === "function" ? buffer.from(value, "latin1") : null;
}
function createNativeLatin1Decoder(core, options = {}) {
  if (core === null || typeof core !== "object" || typeof core.tokenBytes !== "function") {
    throw new TypeError("Latin-1 decode core must provide tokenBytes");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Latin-1 decode options must be an object");
  }
  const size = vocabSize2(core);
  const now = options.now ?? (() => performance.now());
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const nativeUnmap = options.nativeUnmap === void 0 ? defaultNativeUnmap : options.nativeUnmap;
  if (nativeUnmap !== null && typeof nativeUnmap !== "function") {
    throw new TypeError("nativeUnmap must be a function or null");
  }
  const portable = options.portable ?? false;
  if (typeof portable !== "boolean") throw new TypeError("portable must be a boolean");
  const available = nativeUnmap !== null && nativeUnmap("") !== null;
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const strings = new Array(size);
  const present = new Uint8Array(size);
  let initialized = false;
  let known = 0;
  let payloadCodeUnits = 0;
  let buildMilliseconds = 0;
  let decoderCalls = 0;
  let bytesConverted = 0;
  let portableDecoderCalls = 0;
  let portableBytesConverted = 0;
  let portableScratch = new Uint8Array(0);
  function initialize() {
    if (initialized || !available && !portable) return;
    const started = now();
    for (let id = 0; id < size; id += 1) {
      try {
        const bytes = core.tokenBytes(id);
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError("tokenBytes must return a Uint8Array");
        }
        strings[id] = byteString(bytes);
        present[id] = 1;
        known += 1;
        payloadCodeUnits += bytes.length;
      } catch (error) {
        if (error instanceof TypeError && /tokenBytes must return/.test(error.message)) throw error;
      }
    }
    initialized = true;
    buildMilliseconds = now() - started;
  }
  function binaryFor(input) {
    const ids = tokenContainer(input);
    initialize();
    let binary = "";
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (!(ids instanceof Uint32Array) && !validTokenId(id)) {
        throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
      }
      if (id >= size || present[id] === 0) throw new RangeError(`unknown token id ${id}`);
      binary += strings[id];
    }
    return binary;
  }
  function decode(input) {
    if (!available) throw new Error("native Latin-1 decode is unavailable");
    const binary = binaryFor(input);
    const bytes = nativeUnmap(binary);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("nativeUnmap must return a Uint8Array");
    }
    decoderCalls += 1;
    bytesConverted += bytes.length;
    return decoder.decode(bytes);
  }
  function decodePortable(input) {
    if (!portable) throw new Error("portable Latin-1 decode is unavailable");
    const binary = binaryFor(input);
    if (portableScratch.length < binary.length) {
      let capacity2 = Math.max(256, portableScratch.length);
      while (capacity2 < binary.length) capacity2 *= 2;
      portableScratch = new Uint8Array(capacity2);
    }
    for (let index = 0; index < binary.length; index += 1) {
      portableScratch[index] = binary.charCodeAt(index);
    }
    portableDecoderCalls += 1;
    portableBytesConverted += binary.length;
    return decoder.decode(portableScratch.subarray(0, binary.length));
  }
  function stats() {
    return Object.freeze({
      available,
      portable,
      initialized,
      known,
      payloadCodeUnits,
      presentBytes: present.byteLength,
      buildMilliseconds,
      decoderCalls,
      bytesConverted,
      portableDecoderCalls,
      portableBytesConverted,
      portableScratchBytes: portableScratch.byteLength
    });
  }
  return Object.freeze({ available, portable, decode, decodePortable, stats });
}

// hypertok-js/src/decode-table.mjs
var DEFAULT_SEED_ENTRIES = 8192;
var DEFAULT_MAX_TABLE_IDS = 256 * 1024;
var DEFAULT_MAX_DIRTY_DENSITY = 0;
var DEFAULT_MIXED_RUN_PENALTY = 1;
var DIRTY = 0;
var UNTOUCHED = 1;
var MISSING = 2;
function nonnegativeInteger(value, fallback, name) {
  if (value === void 0) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}
function density(value, fallback) {
  if (value === void 0) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("maxDirtyDensity must be between zero and one");
  }
  return value;
}
function nonnegativeNumber(value, fallback, name) {
  if (value === void 0) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative finite number`);
  }
  return value;
}
function seedIds(value, size, limit) {
  if (value === void 0) {
    return Uint32Array.from({ length: limit }, (_, id) => id);
  }
  const ids = strictTokenIds(value);
  if (ids.length > limit) {
    throw new RangeError("seedIds cannot contain more entries than seedEntries");
  }
  const seen = /* @__PURE__ */ new Set();
  for (const id of ids) {
    if (id >= size) throw new RangeError(`seedIds contains unknown token id ${id}`);
    if (seen.has(id)) throw new RangeError(`seedIds contains duplicate token id ${id}`);
    seen.add(id);
  }
  return ids;
}
function validTokenId2(value) {
  return Number.isInteger(value) && value >= 0 && value <= 4294967295;
}
function validTokenIdFast(value) {
  return typeof value === "number" && value >>> 0 === value;
}
function strictTokenIds(input) {
  if (input instanceof Uint32Array) return input;
  if (Array.isArray(input) && input.every(validTokenId2)) return input;
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}
function tokenContainer2(input) {
  if (input instanceof Uint32Array || Array.isArray(input)) return input;
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}
function fromCodeUnits(units) {
  let text = "";
  for (let start = 0; start < units.length; start += 4096) {
    text += String.fromCharCode(...units.slice(start, start + 4096));
  }
  return text;
}
function decodeValidUtf8(bytes) {
  let ascii = true;
  for (const byte of bytes) {
    if (byte > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) return { text: fromCodeUnits(bytes), oneByte: true };
  const units = [];
  let oneByte = true;
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index];
    let codepoint;
    if (first <= 127) {
      codepoint = first;
      index += 1;
    } else if ((first & 224) === 192) {
      codepoint = (first & 31) << 6 | bytes[index + 1] & 63;
      index += 2;
    } else if ((first & 240) === 224) {
      codepoint = (first & 15) << 12 | (bytes[index + 1] & 63) << 6 | bytes[index + 2] & 63;
      index += 3;
    } else {
      codepoint = (first & 7) << 18 | (bytes[index + 1] & 63) << 12 | (bytes[index + 2] & 63) << 6 | bytes[index + 3] & 63;
      index += 4;
    }
    if (codepoint <= 65535) {
      units.push(codepoint);
      if (codepoint > 255) oneByte = false;
    } else {
      const adjusted = codepoint - 65536;
      units.push(55296 + (adjusted >>> 10), 56320 + (adjusted & 1023));
      oneByte = false;
    }
  }
  return { text: fromCodeUnits(units), oneByte };
}
function vocabSize3(core) {
  const value = typeof core.vocabSize === "function" ? core.vocabSize() : core.vocabSize;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("decode table core must provide a positive vocabSize");
  }
  return value;
}
function isValidUtf8(bytes) {
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index];
    if (first <= 127) {
      index += 1;
      continue;
    }
    let continuation;
    let codepoint;
    if ((first & 224) === 192) {
      if (first < 194) return false;
      continuation = 1;
      codepoint = first & 31;
    } else if ((first & 240) === 224) {
      continuation = 2;
      codepoint = first & 15;
    } else if ((first & 248) === 240) {
      if (first > 244) return false;
      continuation = 3;
      codepoint = first & 7;
    } else {
      return false;
    }
    if (index + continuation >= bytes.length) return false;
    for (let offset = 1; offset <= continuation; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 192) !== 128) return false;
      codepoint = codepoint << 6 | next & 63;
    }
    if (continuation === 2 && codepoint < 2048) return false;
    if (continuation === 3 && codepoint < 65536) return false;
    if (codepoint >= 55296 && codepoint <= 57343) return false;
    if (codepoint > 1114111) return false;
    index += continuation + 1;
  }
  return true;
}
function createTokenByteDecoder(core, size, now, wholeSegments) {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const dirtyStrings = new Array(size);
  let initialized = false;
  let arena = null;
  let offsets = null;
  let present = null;
  let scratch = new Uint8Array(0);
  let known = 0;
  let dirty = 0;
  let dirtyPayloadBytes = 0;
  let buildMilliseconds = 0;
  let decoderCalls = 0;
  let bytesCopied = 0;
  let runDecoderCalls = 0;
  let runBytesCopied = 0;
  function initialize() {
    if (initialized) return;
    const started = now();
    const pieces = wholeSegments ? new Array(size) : null;
    if (wholeSegments) {
      offsets = new Uint32Array(size + 1);
      present = new Uint8Array(size);
    }
    let total = 0;
    for (let id = 0; id < size; id += 1) {
      try {
        const bytes = Uint8Array.from(core.tokenBytes(id));
        if (wholeSegments) {
          pieces[id] = bytes;
          present[id] = 1;
          total += bytes.length;
        }
        if (!isValidUtf8(bytes)) {
          dirtyStrings[id] = fromCodeUnits(bytes);
          dirty += 1;
          dirtyPayloadBytes += bytes.length;
        }
        known += 1;
      } catch {
        if (wholeSegments) pieces[id] = null;
      }
      if (wholeSegments) offsets[id + 1] = total;
    }
    if (wholeSegments) {
      arena = new Uint8Array(total);
      for (let id = 0; id < size; id += 1) {
        const bytes = pieces[id];
        if (bytes !== null) arena.set(bytes, offsets[id]);
      }
    }
    initialized = true;
    buildMilliseconds = now() - started;
  }
  function ensureScratch(length) {
    if (scratch.length >= length) return;
    let capacity2 = Math.max(256, scratch.length);
    while (capacity2 < length) capacity2 *= 2;
    scratch = new Uint8Array(capacity2);
  }
  function decode(input) {
    if (!wholeSegments) throw new Error("whole-segment byte decode is disabled");
    const ids = strictTokenIds(input);
    initialize();
    let length = 0;
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id >= size || present[id] === 0) throw new RangeError(`unknown token id ${id}`);
      length += offsets[id + 1] - offsets[id];
    }
    ensureScratch(length);
    let cursor = 0;
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const start = offsets[id];
      const end = offsets[id + 1];
      scratch.set(arena.subarray(start, end), cursor);
      cursor += end - start;
    }
    decoderCalls += 1;
    bytesCopied += length;
    return decoder.decode(scratch.subarray(0, length));
  }
  function byteString2(id) {
    initialize();
    return dirtyStrings[id];
  }
  function decodeByteString(value) {
    ensureScratch(value.length);
    for (let index = 0; index < value.length; index += 1) {
      scratch[index] = value.charCodeAt(index);
    }
    runDecoderCalls += 1;
    runBytesCopied += value.length;
    return decoder.decode(scratch.subarray(0, value.length));
  }
  function stats() {
    return Object.freeze({
      initialized,
      known,
      dirty,
      dirtyPayloadBytes,
      buildMilliseconds,
      decoderCalls,
      bytesCopied,
      runDecoderCalls,
      runBytesCopied,
      arenaBytes: arena?.byteLength ?? 0,
      offsetsBytes: offsets?.byteLength ?? 0,
      presentBytes: present?.byteLength ?? 0,
      scratchBytes: scratch.byteLength
    });
  }
  return Object.freeze({ decode, byteString: byteString2, decodeByteString, stats });
}
function createDecodeTable(core, options = {}) {
  if (core === null || typeof core !== "object" || typeof core.decode !== "function" || typeof core.tokenBytes !== "function") {
    throw new TypeError("decode table core must provide decode and tokenBytes functions");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("decode table options must be an object");
  }
  const size = vocabSize3(core);
  const seedEntries = Math.min(
    nonnegativeInteger(options.seedEntries, DEFAULT_SEED_ENTRIES, "seedEntries"),
    size
  );
  const seeds = seedIds(options.seedIds, size, seedEntries);
  const maxTableIds = nonnegativeInteger(
    options.maxTableIds,
    DEFAULT_MAX_TABLE_IDS,
    "maxTableIds"
  );
  const maxDirtyDensity = density(options.maxDirtyDensity, DEFAULT_MAX_DIRTY_DENSITY);
  const useByteTable = options.byteTable ?? false;
  if (typeof useByteTable !== "boolean") throw new TypeError("byteTable must be a boolean");
  const useMixedRuns = options.mixedRuns ?? false;
  if (typeof useMixedRuns !== "boolean") throw new TypeError("mixedRuns must be a boolean");
  const useRunCache = options.runCache ?? false;
  if (typeof useRunCache !== "boolean") throw new TypeError("runCache must be a boolean");
  if (useRunCache && !useMixedRuns) {
    throw new TypeError("maximal-run cache requires mixed-run decode");
  }
  const useNativeLatin1 = options.nativeLatin1 ?? false;
  if (typeof useNativeLatin1 !== "boolean") {
    throw new TypeError("nativeLatin1 must be a boolean");
  }
  const usePortableLatin1 = options.portableLatin1 ?? false;
  if (typeof usePortableLatin1 !== "boolean") {
    throw new TypeError("portableLatin1 must be a boolean");
  }
  const useFusedValidation = options.fusedValidation ?? false;
  if (typeof useFusedValidation !== "boolean") {
    throw new TypeError("fusedValidation must be a boolean");
  }
  const useLeanDispatch = options.leanDispatch ?? false;
  if (typeof useLeanDispatch !== "boolean") {
    throw new TypeError("leanDispatch must be a boolean");
  }
  const validateTokenId = useLeanDispatch ? validTokenIdFast : validTokenId2;
  const maxMixedDirtyDensity = density(options.maxMixedDirtyDensity, 0.5);
  const mixedRunPenalty = nonnegativeNumber(
    options.mixedRunPenalty,
    DEFAULT_MIXED_RUN_PENALTY,
    "mixedRunPenalty"
  );
  const now = options.now ?? (() => performance.now());
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const table = new Array(size).fill(UNTOUCHED);
  const status = new Uint8Array(size);
  const lengths = new Uint32Array(size);
  let initialized = false;
  let seeded = 0;
  let materialized = 0;
  let metadataKnown = 0;
  let dirtyKnown = 0;
  let missingKnown = 0;
  let stringPayloadBytes = 0;
  let firstUseMilliseconds = 0;
  let tableCalls = 0;
  let fallbackCalls = 0;
  let mixedCalls = 0;
  let dirtyRunCalls = 0;
  let largeFallbackCalls = 0;
  let dirtyFallbackCalls = 0;
  let unknownFallbackCalls = 0;
  let sampledFallbackCalls = 0;
  let byteTableCalls = 0;
  let mixedDensityFallbackCalls = 0;
  let mixedRunFallbackCalls = 0;
  const byteTable = useByteTable || useMixedRuns ? createTokenByteDecoder(core, size, now, useByteTable) : null;
  const runCache = useRunCache ? createMaximalRunCache(options.runCacheOptions) : null;
  const latin1 = useNativeLatin1 || usePortableLatin1 ? createNativeLatin1Decoder(core, {
    ...options.nativeLatin1Options,
    portable: usePortableLatin1
  }) : null;
  function inspect(id) {
    if (id >= size) return 3;
    if (status[id] !== 0) return status[id];
    let bytes;
    try {
      bytes = core.tokenBytes(id);
    } catch {
      status[id] = 3;
      table[id] = MISSING;
      missingKnown += 1;
      return 3;
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("tokenBytes must return a Uint8Array");
    }
    lengths[id] = bytes.length;
    status[id] = isValidUtf8(bytes) ? 1 : 2;
    metadataKnown += 1;
    if (status[id] === 2) {
      table[id] = DIRTY;
      dirtyKnown += 1;
    }
    return status[id];
  }
  function materialize(id) {
    const current = table[id];
    if (typeof current === "string") return current;
    if (inspect(id) !== 1) return void 0;
    const { text, oneByte } = decodeValidUtf8(core.tokenBytes(id));
    table[id] = text;
    materialized += 1;
    stringPayloadBytes += text.length * (oneByte ? 1 : 2);
    return text;
  }
  function initialize() {
    if (initialized) return;
    const started = now();
    for (const id of seeds) {
      if (inspect(id) !== 1) continue;
      materialize(id);
      seeded += 1;
    }
    initialized = true;
    firstUseMilliseconds = now() - started;
  }
  function fallback(input) {
    fallbackCalls += 1;
    return core.decode(input);
  }
  function decodeBytesInJs(input) {
    byteTableCalls += 1;
    return byteTable.decode(input);
  }
  function decodeNativeLatin1(input) {
    return latin1.decode(input);
  }
  function decodePortableLatin1(input) {
    return latin1.decodePortable(input);
  }
  function decodeLatin1(input) {
    if (useNativeLatin1 && latin1.available) return decodeNativeLatin1(input);
    if (usePortableLatin1) return decodePortableLatin1(input);
    return void 0;
  }
  function joinKnownClean(ids) {
    const packed = table;
    let output = "";
    if (ids instanceof Uint32Array) {
      for (let index = 0; index < ids.length; index += 1) {
        const value = packed[ids[index]];
        if (typeof value !== "string") return index;
        output += value;
      }
    } else {
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        if (!validateTokenId(id)) return index;
        const value = packed[id];
        if (typeof value !== "string") return index;
        output += value;
      }
    }
    return output;
  }
  function fusedTokenIds(input, firstMiss) {
    if (input instanceof Uint32Array) return { ids: input, firstMiss: 0 };
    const ids = new Uint32Array(input.length);
    let earliestMiss = firstMiss;
    for (let index = 0; index < input.length; index += 1) {
      const id = input[index];
      if (!validateTokenId(id)) {
        throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
      }
      ids[index] = id;
      if (index < earliestMiss && typeof table[id] !== "string") earliestMiss = index;
    }
    return { ids, firstMiss: earliestMiss };
  }
  function decodeCareful(input, firstMiss) {
    const prepared = useFusedValidation ? fusedTokenIds(input, firstMiss) : { ids: strictTokenIds(input), firstMiss: 0 };
    const { ids } = prepared;
    const sampleCount = Math.min(32, ids.length);
    let sampledDirty = 0;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const id = ids[Math.floor(sample * ids.length / sampleCount)];
      const state = inspect(id);
      if (state === 3) {
        unknownFallbackCalls += 1;
        return fallback(ids);
      }
      if (state === 2) sampledDirty += 1;
    }
    if (useMixedRuns && sampledDirty / sampleCount > maxMixedDirtyDensity) {
      dirtyFallbackCalls += 1;
      sampledFallbackCalls += 1;
      mixedDensityFallbackCalls += 1;
      if (useNativeLatin1 && latin1?.available || usePortableLatin1) {
        return decodeLatin1(ids);
      }
      return fallback(ids);
    }
    if (!useMixedRuns && sampledDirty / sampleCount > maxDirtyDensity) {
      dirtyFallbackCalls += 1;
      sampledFallbackCalls += 1;
      if (useNativeLatin1 && latin1?.available || usePortableLatin1) return decodeLatin1(ids);
      return byteTable === null ? fallback(ids) : decodeBytesInJs(ids);
    }
    let dirtyIds = 0;
    let dirtyRuns = 0;
    let previousDirty = false;
    for (let index2 = prepared.firstMiss; index2 < ids.length; index2 += 1) {
      const id = ids[index2];
      const state = inspect(id);
      if (state === 3) {
        unknownFallbackCalls += 1;
        if (useNativeLatin1 && latin1?.available || usePortableLatin1) {
          return decodeLatin1(ids);
        }
        return fallback(ids);
      }
      if (state === 1) {
        materialize(id);
        previousDirty = false;
        continue;
      }
      dirtyIds += 1;
      if (!previousDirty) dirtyRuns += 1;
      previousDirty = true;
      const dirtyDensity = dirtyIds / ids.length;
      const mixedRouteScore = (dirtyIds + dirtyRuns * mixedRunPenalty) / ids.length;
      if (useMixedRuns && mixedRouteScore > maxMixedDirtyDensity) {
        dirtyFallbackCalls += 1;
        if (dirtyDensity > maxMixedDirtyDensity) {
          mixedDensityFallbackCalls += 1;
        } else {
          mixedRunFallbackCalls += 1;
        }
        return fallback(ids);
      }
      if (!useMixedRuns && dirtyIds / ids.length > maxDirtyDensity) {
        dirtyFallbackCalls += 1;
        if (useNativeLatin1 && latin1?.available || usePortableLatin1) return decodeLatin1(ids);
        return byteTable === null ? fallback(ids) : decodeBytesInJs(ids);
      }
    }
    if (dirtyIds === 0) {
      const output2 = joinKnownClean(ids);
      if (typeof output2 !== "string") throw new Error("decode table restart did not converge");
      tableCalls += 1;
      return output2;
    }
    let output = "";
    let index = 0;
    while (index < ids.length) {
      const value = table[ids[index]];
      if (typeof value === "string") {
        output += value;
        index += 1;
        continue;
      }
      const start = index;
      do {
        const value2 = byteTable?.byteString(ids[index]);
        if (useMixedRuns && typeof value2 !== "string") {
          throw new Error("dirty byte-string table did not converge");
        }
        index += 1;
      } while (index < ids.length && table[ids[index]] === DIRTY);
      if (useMixedRuns) {
        const decodeRun = () => {
          let bytes = "";
          for (let cursor = start; cursor < index; cursor += 1) {
            bytes += byteTable.byteString(ids[cursor]);
          }
          return byteTable.decodeByteString(bytes);
        };
        output += runCache === null ? decodeRun() : runCache.decode(ids, start, index, decodeRun);
      } else {
        const run = ids instanceof Uint32Array ? ids.subarray(start, index) : ids.slice(start, index);
        output += core.decode(run);
      }
      dirtyRunCalls += 1;
    }
    tableCalls += 1;
    if (dirtyIds !== 0) mixedCalls += 1;
    return output;
  }
  function decode(input) {
    const ids = tokenContainer2(input);
    initialize();
    if (ids.length === 0) {
      tableCalls += 1;
      return "";
    }
    if (ids.length > maxTableIds) {
      strictTokenIds(ids);
      largeFallbackCalls += 1;
      return fallback(ids);
    }
    const output = joinKnownClean(ids);
    if (typeof output === "string") {
      tableCalls += 1;
      return output;
    }
    return decodeCareful(ids, output);
  }
  function tokenString(id) {
    if (!Number.isInteger(id) || id < 0 || id >= size) return void 0;
    const value = table[id];
    return typeof value === "string" ? value : void 0;
  }
  function stats() {
    return Object.freeze({
      initialized,
      seedEntries,
      seeded,
      materialized,
      metadataKnown,
      dirtyKnown,
      missingKnown,
      firstUseMilliseconds,
      maxTableIds,
      maxDirtyDensity,
      mixedRunsEnabled: useMixedRuns,
      runCacheEnabled: useRunCache,
      runCacheState: runCache?.stats() ?? null,
      nativeLatin1Enabled: useNativeLatin1,
      nativeLatin1State: useNativeLatin1 ? latin1?.stats() ?? null : null,
      portableLatin1Enabled: usePortableLatin1,
      portableLatin1State: usePortableLatin1 ? latin1?.stats() ?? null : null,
      fusedValidationEnabled: useFusedValidation,
      leanDispatchEnabled: useLeanDispatch,
      maxMixedDirtyDensity,
      mixedRunPenalty,
      mixedDensityFallbackCalls,
      mixedRunFallbackCalls,
      byteTableEnabled: byteTable !== null,
      byteTableCalls,
      byteTableState: byteTable?.stats() ?? null,
      tableCalls,
      fallbackCalls,
      mixedCalls,
      dirtyRunCalls,
      largeFallbackCalls,
      dirtyFallbackCalls,
      unknownFallbackCalls,
      sampledFallbackCalls,
      typedResidentBytes: status.byteLength + lengths.byteLength,
      stringPayloadBytes
    });
  }
  return Object.freeze({ decode, tokenString, stats });
}

// hypertok-js/src/decode-composed.mjs
function requiredCore(core) {
  if (core === null || typeof core !== "object" || typeof core.decode !== "function" || typeof core.tokenBytes !== "function" || typeof core.vocabSize !== "function") {
    throw new TypeError("composed decode core must provide decode, tokenBytes, and vocabSize");
  }
}
function tokenIds4(input) {
  if (input instanceof Uint32Array) return input;
  if (Array.isArray(input) && input.every(
    (value) => Number.isInteger(value) && value >= 0 && value <= 4294967295
  )) {
    return Uint32Array.from(input);
  }
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}
function gatherTokenBytes(core, input) {
  const ids = tokenIds4(input);
  const pieces = Array.from(ids, (id) => core.tokenBytes(id));
  const length = pieces.reduce((total, bytes) => total + bytes.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const bytes of pieces) {
    output.set(bytes, offset);
    offset += bytes.length;
  }
  return output;
}
function createComposedDecoder(core, options = {}) {
  requiredCore(core);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("composed decode options must be an object");
  }
  const useAssembly = options.assembly !== false;
  const useBoundary = options.boundary === true;
  const useTable = options.table === true;
  const useByteTable = options.byteTable === true;
  const useMixedRuns = options.mixedRuns === true;
  const useRunCache = options.runCache === true;
  const useNativeLatin1 = options.nativeLatin1 === true;
  const usePortableLatin1 = options.portableLatin1 === true;
  const useFusedValidation = options.fusedValidation === true;
  const useLeanDispatch = options.leanDispatch === true;
  const useMemo = options.memo === true;
  const useHotStrings = options.hotStrings === true;
  if (useBoundary && !useAssembly) {
    throw new TypeError("boundary decode requires assembly decode");
  }
  if (useByteTable && !useTable) {
    throw new TypeError("byte-table decode requires table decode");
  }
  if (useMixedRuns && !useTable) {
    throw new TypeError("mixed-run decode requires table decode");
  }
  if (useRunCache && !useMixedRuns) {
    throw new TypeError("maximal-run cache requires mixed-run decode");
  }
  if (useNativeLatin1 && !useTable) {
    throw new TypeError("native Latin-1 decode requires table decode");
  }
  if (usePortableLatin1 && !useTable) {
    throw new TypeError("portable Latin-1 decode requires table decode");
  }
  const raw = Object.freeze({
    decode: (ids) => core.decode(tokenIds4(ids)),
    stats: () => Object.freeze({ decoderCalls: 0 })
  });
  const assembly = useAssembly ? useBoundary ? createBoundaryDecoder(core) : createAssemblyDecoder(core) : raw;
  let active = assembly;
  let table = null;
  let hotStrings = null;
  let memo = null;
  const facade = (decoder) => ({
    vocabSize: () => core.vocabSize(),
    tokenBytes: (id) => core.tokenBytes(id),
    decode: (ids) => decoder.decode(ids)
  });
  if (useTable) {
    table = createDecodeTable(facade(active), {
      ...options.tableOptions,
      byteTable: useByteTable,
      mixedRuns: useMixedRuns,
      runCache: useRunCache,
      nativeLatin1: useNativeLatin1,
      portableLatin1: usePortableLatin1,
      fusedValidation: useFusedValidation,
      leanDispatch: useLeanDispatch
    });
    active = table;
  }
  if (useHotStrings) {
    hotStrings = createHotStringDecoder(facade(active), options.hotStringOptions);
    active = hotStrings;
  }
  if (useMemo) {
    memo = createDecodeMemo(active, options.memoOptions);
    active = memo;
  }
  function tokenString(id) {
    return hotStrings?.tokenString(id) ?? table?.tokenString(id);
  }
  function stats() {
    return Object.freeze({
      assemblyEnabled: useAssembly,
      boundary: useBoundary,
      table: useTable,
      byteTable: useByteTable,
      mixedRuns: useMixedRuns,
      runCache: useRunCache,
      nativeLatin1: useNativeLatin1,
      portableLatin1: usePortableLatin1,
      fusedValidation: useFusedValidation,
      leanDispatch: useLeanDispatch,
      memo: useMemo,
      hotStrings: useHotStrings,
      assembly: assembly.stats(),
      tableState: table?.stats() ?? null,
      hotStringState: hotStrings?.stats() ?? null,
      memoState: memo?.stats() ?? null
    });
  }
  return Object.freeze({
    decode: useLeanDispatch ? active.decode : (ids) => active.decode(ids),
    decodeBytes: (ids) => useAssembly ? core.decodeAssemblyBytes(tokenIds4(ids)) : gatherTokenBytes(core, ids),
    tokenString,
    stats
  });
}

// hypertok-js/src/tier-runtime.mjs
var textEncoder = new TextEncoder();
function inputBytes(input) {
  if (typeof input === "string") return textEncoder.encode(input);
  if (input instanceof Uint8Array) return input;
  throw new TypeError("encode input must be a string or Uint8Array");
}
function encodeResidentString(tokenizer, input) {
  let remaining = input;
  let written = 0;
  while (remaining.length !== 0) {
    const view = tokenizer.residentInputView();
    const encoded = textEncoder.encodeInto(remaining, view.subarray(written));
    written += encoded.written;
    if (encoded.read === remaining.length) break;
    remaining = remaining.slice(encoded.read);
    tokenizer.growResidentInput();
  }
  return tokenizer.encodeResidentInput(written);
}
function encodeSingle(tokenizer, input) {
  if (typeof input === "string" && typeof tokenizer.residentInputView === "function") {
    return encodeResidentString(tokenizer, input);
  }
  return tokenizer.encode(inputBytes(input));
}
function destinationIds(destination) {
  if (!(destination instanceof Uint32Array)) {
    throw new TypeError("encodeInto destination must be a Uint32Array");
  }
  return destination;
}
function copyIdsInto(destination, ids) {
  if (ids.length > destination.length) {
    throw new RangeError(
      `encodeInto destination has capacity ${destination.length}, but ${ids.length} ids are required`
    );
  }
  destination.set(ids);
  return ids.length;
}
function encodeResidentStringInto(tokenizer, input, destination) {
  let remaining = input;
  let written = 0;
  while (remaining.length !== 0) {
    const view = tokenizer.residentInputView();
    const encoded = textEncoder.encodeInto(remaining, view.subarray(written));
    written += encoded.written;
    if (encoded.read === remaining.length) break;
    remaining = remaining.slice(encoded.read);
    tokenizer.growResidentInput();
  }
  const idCount = typeof tokenizer.encodeChunkedResidentInputIntoOutput === "function" ? tokenizer.encodeChunkedResidentInputIntoOutput(written, tokenizer.defaultChunkSize()) : tokenizer.encodeResidentInputIntoOutput(written);
  if (idCount > destination.length) {
    throw new RangeError(
      `encodeInto destination has capacity ${destination.length}, but ${idCount} ids are required`
    );
  }
  destination.set(tokenizer.residentOutputView().subarray(0, idCount));
  return idCount;
}
function reservedSelection(value, defaultAll, field) {
  if (value === void 0) return { all: defaultAll, names: [] };
  if (value === "all") return { all: true, names: [] };
  if (Array.isArray(value) && value.every((name) => typeof name === "string")) {
    return { all: false, names: [...new Set(value)] };
  }
  throw new TypeError(`${field} must be "all" or an array of reserved-token names`);
}
function normalizeReservedPolicy(policy) {
  if (policy === void 0) policy = {};
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("reserved policy must be an object");
  }
  return {
    matched: reservedSelection(policy.match, true, "reserved.match"),
    refused: reservedSelection(policy.refuse, false, "reserved.refuse")
  };
}
function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function browserCapabilities(scope = globalThis) {
  return Object.freeze({
    isolated: scope.crossOriginIsolated === true,
    sharedArrayBuffer: typeof scope.SharedArrayBuffer === "function",
    worker: typeof scope.Worker === "function"
  });
}
function selectTier(requested, capabilities, hasThreadedArtifact = true) {
  const tier = requested ?? "auto";
  const shared = capabilities.isolated && capabilities.sharedArrayBuffer && capabilities.worker && hasThreadedArtifact;
  const worker = !capabilities.isolated && capabilities.worker;
  if (tier === "auto") {
    if (shared) return "shared";
    if (worker) return "worker";
    return "single";
  }
  if (tier === "shared") {
    if (!shared) throw new Error("shared tier is unavailable in this environment");
    return tier;
  }
  if (tier === "worker") {
    if (!worker) throw new Error("worker tier is unavailable in this environment");
    return tier;
  }
  if (tier === "single") return tier;
  throw new TypeError(`unknown execution tier ${tier}`);
}
var RpcWorker = class {
  constructor(worker) {
    this.worker = worker;
    this.nextId = 0;
    this.pending = /* @__PURE__ */ new Map();
    worker.addEventListener("message", ({ data }) => {
      const pending = this.pending.get(data.id);
      if (pending === void 0) return;
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new Error(data.error));
    });
    worker.addEventListener("error", (event) => {
      const location = event.filename ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}` : "";
      const error = new Error(
        [event.message, location].filter((part) => part).join(" at ") || "execution worker failed"
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }
  call(operation, value = {}, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, operation, ...value }, transfer);
    });
  }
  close() {
    this.worker.terminate();
    this.pending.clear();
  }
};
var IndependentWorkerPool = class {
  constructor(workers) {
    this.workers = workers;
    this.nextWorker = 0;
    this.active = /* @__PURE__ */ new Set();
    this.tasks = 0;
  }
  resetTelemetry() {
    this.active.clear();
    this.tasks = 0;
  }
  async encodeBatch(entries) {
    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    const totalBytes = entries.reduce((sum, bytes) => sum + bytes.length, 0);
    const input = new Uint8Array(totalBytes);
    const ranges = new Uint32Array(entries.length * 2);
    let inputOffset = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const bytes = entries[index];
      input.set(bytes, inputOffset);
      ranges[index * 2] = inputOffset;
      inputOffset += bytes.length;
      ranges[index * 2 + 1] = inputOffset;
    }
    const result = await worker.call(
      "encodePretokens",
      { input: input.buffer, ranges: ranges.buffer },
      [input.buffer, ranges.buffer]
    );
    this.active.add(result.workerId);
    this.tasks += entries.length;
    const encoded = [];
    let offset = 0;
    for (const length of result.lengths) {
      encoded.push(result.flatIds.slice(offset, offset + length));
      offset += length;
    }
    if (offset !== result.flatIds.length || encoded.length !== entries.length) {
      throw new Error("worker result lengths do not match the encoded batch");
    }
    return encoded;
  }
  async encode(bytes) {
    const [ids] = await this.encodeBatch([bytes]);
    return ids;
  }
  async close() {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
};
function flattenIds(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const flat = new Uint32Array(total);
  let offset = 0;
  for (const part of parts) {
    flat.set(part, offset);
    offset += part.length;
  }
  return flat;
}
async function loadSingle(moduleUrl, moduleSource, vocabulary, scheme, format) {
  const module = await import(
    /* webpackIgnore: true */
    /* @vite-ignore */
    moduleUrl
  );
  await module.default(
    moduleSource === void 0 ? void 0 : { module_or_path: moduleSource }
  );
  if (format === "htk") return module.WasmTokenizer.fromHtk(vocabulary);
  if (format === "huggingface") return module.WasmTokenizer.fromHuggingFace(vocabulary);
  return module.WasmTokenizer.fromTiktoken(vocabulary, scheme);
}
function createIndependentWorker() {
  return new Worker(new URL("./tier-worker.mjs", import.meta.url), { type: "module" });
}
function createSharedController() {
  return new Worker(new URL("./shared-controller.mjs", import.meta.url), { type: "module" });
}
async function initializeWorkerPool(count, moduleUrl, vocabulary, scheme, format, workerImage, sourceDigest) {
  const workers = Array.from({ length: count }, () => new RpcWorker(createIndependentWorker()));
  try {
    const initialized = await Promise.all(
      workers.map((worker, workerId) => {
        const copy = format === "htk" ? workerImage.slice() : vocabulary.slice();
        const value = format === "htk" ? {
          moduleUrl,
          format,
          workerImage: copy.buffer,
          sourceDigest: sourceDigest.slice().buffer,
          workerId
        } : { moduleUrl, vocabulary: copy.buffer, scheme, format, workerId };
        const initialized2 = worker.call(
          "initialize",
          value,
          [copy.buffer]
        );
        const detached = copy.byteLength === 0;
        return initialized2.then((result) => ({ ...result, detached }));
      })
    );
    if (format === "htk" && initialized.some(
      (entry) => !entry.imported || !equalBytes(entry.sourceDigest, sourceDigest)
    )) {
      throw new Error("worker model identity does not match the resident vocabulary");
    }
    const pool = new IndependentWorkerPool(workers);
    pool.initialized = initialized;
    return pool;
  } catch (error) {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    throw error;
  }
}
async function encodeLongPretoken(single, pool, pretoken, chunkSize) {
  const reconciliation = single.beginOverlap(pretoken, chunkSize);
  try {
    const flatRanges = reconciliation.initialRanges();
    const tasks = [];
    for (let index = 0; index < flatRanges.length; index += 2) {
      tasks.push(pool.encode(pretoken.subarray(flatRanges[index], flatRanges[index + 1])));
    }
    const initial = await Promise.all(tasks);
    const lengths = Uint32Array.from(initial, (ids) => ids.length);
    let requested = reconciliation.acceptInitial(flattenIds(initial), lengths);
    let enlargements = 0;
    while (requested.length !== 0) {
      const ids = await pool.encode(pretoken.subarray(requested[0], requested[1]));
      requested = reconciliation.acceptEnlargement(ids);
      enlargements += 1;
    }
    return {
      ids: reconciliation.takeIds(),
      initialChunks: flatRanges.length / 2,
      enlargements
    };
  } finally {
    reconciliation.free();
  }
}
async function encodeWithWorkers(single, pool, input) {
  const ranges = single.pretokenRanges(input);
  const chunkSize = single.defaultChunkSize();
  pool.resetTelemetry();
  const tasks = [];
  let shortBatch = [];
  const flushShortBatch = () => {
    if (shortBatch.length === 0) return;
    const batch = shortBatch;
    shortBatch = [];
    const encoded2 = pool.encodeBatch(batch);
    for (let index = 0; index < batch.length; index += 1) {
      tasks.push(
        encoded2.then((results) => ({
          ids: results[index],
          initialChunks: 1,
          enlargements: 0
        }))
      );
    }
  };
  for (let index = 0; index < ranges.length; index += 2) {
    const pretoken = input.subarray(ranges[index], ranges[index + 1]);
    if (pretoken.length > chunkSize) {
      flushShortBatch();
      tasks.push(encodeLongPretoken(single, pool, pretoken, chunkSize));
    } else {
      shortBatch.push(pretoken);
      if (shortBatch.length === 1024) flushShortBatch();
    }
  }
  flushShortBatch();
  const encoded = await Promise.all(tasks);
  return {
    ids: flattenIds(encoded.map((result) => result.ids)),
    telemetry: Object.freeze({
      pretokens: ranges.length / 2,
      tasks: pool.tasks,
      initialChunks: encoded.reduce((sum, result) => sum + result.initialChunks, 0),
      enlargements: encoded.reduce((sum, result) => sum + result.enlargements, 0),
      activeWorkers: pool.active.size
    })
  };
}
async function createTierRuntime(options) {
  const {
    unthreadedModuleUrl,
    unthreadedModuleSource,
    threadedModuleUrl,
    vocabulary,
    scheme,
    format = "tiktoken",
    workerCount = Math.max(1, Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1))
  } = options;
  if (!(vocabulary instanceof Uint8Array)) {
    throw new TypeError("vocabulary must be a Uint8Array");
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new TypeError("workerCount must be a positive integer");
  }
  const capabilities = options.capabilities ?? browserCapabilities();
  const optimizationConfiguration = resolveOptimizationConfig(options.optimizations);
  const initialTier = selectTier(options.tier, capabilities, threadedModuleUrl !== void 0);
  if (format !== "tiktoken" && format !== "huggingface" && format !== "htk") {
    throw new TypeError(`unknown vocabulary format ${format}`);
  }
  const single = await loadSingle(
    unthreadedModuleUrl,
    unthreadedModuleSource,
    vocabulary,
    scheme,
    format
  );
  const decodeConfiguration = optimizationConfiguration.decode.assembly && typeof single.decodeAssemblyBytes !== "function" ? Object.freeze({
    assembly: false,
    boundary: false,
    hotStrings: false,
    table: false,
    byteTable: false,
    mixedRuns: false,
    runCache: false,
    nativeLatin1: false,
    portableLatin1: false,
    fusedValidation: false,
    leanDispatch: false,
    memo: optimizationConfiguration.decode.memo,
    raw: true
  }) : optimizationConfiguration.decode;
  const composedDecoder = createComposedDecoder(single, decodeConfiguration);
  const reservedTokens = Object.freeze(
    typeof single.reservedNamesJson === "function" ? JSON.parse(single.reservedNamesJson()) : []
  );
  let sourceDigest;
  let workerImage;
  let workerImageError;
  if (format === "htk") {
    try {
      sourceDigest = single.vocabularyDigest();
      workerImage = single.exportWorkerImage();
    } catch (error) {
      workerImageError = error;
    }
  }
  let workerPool;
  let sharedController;
  let workerInitialization;
  let sharedInitialization;
  let closed = false;
  let lastTelemetry = Object.freeze({ tier: "single", fallback: false });
  const lifecycle = {
    singleLoads: 1,
    workerImageExports: workerImage === void 0 ? 0 : 1,
    workerPoolInitializations: 0,
    workerImports: 0,
    workerSourceRebuilds: 0,
    sharedInitializations: 0,
    sharedImports: 0,
    sharedSourceRebuilds: 0,
    detachedTransfers: 0,
    targetReuses: 0,
    residentSingleIdentity: 1
  };
  const ensureOpen = () => {
    if (closed) throw new Error("execution-tier session is closed");
  };
  const ensureTier = async (requested) => {
    ensureOpen();
    const tier = selectTier(requested, capabilities, threadedModuleUrl !== void 0);
    if (tier === "single") {
      lifecycle.targetReuses += 1;
      return tier;
    }
    if (workerImageError !== void 0) throw workerImageError;
    if (tier === "worker") {
      if (workerPool !== void 0) {
        lifecycle.targetReuses += 1;
        return tier;
      }
      if (workerInitialization === void 0) {
        workerInitialization = initializeWorkerPool(
          workerCount,
          unthreadedModuleUrl,
          vocabulary,
          scheme,
          format,
          workerImage,
          sourceDigest
        );
      }
      try {
        workerPool = await workerInitialization;
      } catch (error) {
        workerInitialization = void 0;
        throw error;
      }
      lifecycle.workerPoolInitializations += 1;
      lifecycle.workerImports += workerPool.initialized.filter((entry) => entry.imported).length;
      lifecycle.workerSourceRebuilds += workerPool.initialized.filter(
        (entry) => !entry.imported
      ).length;
      lifecycle.detachedTransfers += workerPool.initialized.filter(
        (entry) => entry.detached
      ).length;
      return tier;
    }
    if (sharedController !== void 0 && sharedInitialization !== void 0) {
      await sharedInitialization;
      lifecycle.targetReuses += 1;
      return tier;
    }
    if (sharedInitialization === void 0) {
      sharedController = new RpcWorker(createSharedController());
      const sourceCopy = format === "htk" ? void 0 : vocabulary.slice();
      const transferred = format === "htk" ? workerImage.slice() : sourceCopy;
      const pending = sharedController.call(
        "initialize",
        {
          moduleUrl: threadedModuleUrl,
          vocabulary: sourceCopy?.buffer,
          scheme,
          format,
          workerImage: format === "htk" ? transferred.buffer : void 0,
          sourceDigest: format === "htk" ? sourceDigest.slice().buffer : void 0,
          workerCount
        },
        [transferred.buffer]
      );
      const detached = transferred.byteLength === 0;
      sharedInitialization = pending.then((result) => ({ ...result, detached }));
    }
    let initialized;
    try {
      initialized = await sharedInitialization;
      if (format === "htk" && (!initialized.imported || !equalBytes(initialized.sourceDigest, sourceDigest))) {
        throw new Error("shared model identity does not match the resident vocabulary");
      }
    } catch (error) {
      sharedInitialization = void 0;
      sharedController.close();
      sharedController = void 0;
      throw error;
    }
    lifecycle.sharedInitializations += 1;
    lifecycle.sharedImports += initialized.imported ? 1 : 0;
    lifecycle.sharedSourceRebuilds += initialized.imported ? 0 : 1;
    lifecycle.detachedTransfers += initialized.detached ? 1 : 0;
    return tier;
  };
  const encodeForTier = async (tier, value) => {
    ensureOpen();
    if (tier === "single") {
      const ids = encodeSingle(single, value);
      lastTelemetry = Object.freeze({ tier, fallback: false });
      return ids;
    }
    const bytes = inputBytes(value);
    if (format === "htk" && !single.workerInputSupported(bytes)) {
      const ids = single.encode(bytes);
      lastTelemetry = Object.freeze({ tier, fallback: true, cause: "resident-single-policy" });
      return ids;
    }
    try {
      if (tier === "worker") {
        const result2 = await encodeWithWorkers(single, workerPool, bytes);
        lastTelemetry = Object.freeze({ tier, fallback: false, ...result2.telemetry });
        return result2.ids;
      }
      const copy = bytes.slice();
      const result = await sharedController.call(
        "encode",
        { input: copy.buffer },
        [copy.buffer]
      );
      const telemetry = Array.from(result.telemetry);
      lastTelemetry = Object.freeze({
        tier,
        fallback: false,
        pretokens: telemetry[0],
        tasks: telemetry[1],
        initialChunks: telemetry[2],
        enlargements: telemetry[3],
        activeWorkers: telemetry[4]
      });
      return result.ids;
    } catch (error) {
      const ids = single.encode(bytes);
      lastTelemetry = Object.freeze({ tier, fallback: true, cause: error.message });
      return ids;
    }
  };
  const encodeReservedSync = (tier, value, policy) => {
    ensureOpen();
    const bytes = inputBytes(value);
    const normalized = normalizeReservedPolicy(policy);
    const encoded = single.encodeReserved(
      bytes,
      normalized.matched.all,
      JSON.stringify(normalized.matched.names),
      normalized.refused.all,
      JSON.stringify(normalized.refused.names)
    );
    try {
      const result = Object.freeze({
        ids: encoded.ids(),
        starts: encoded.starts(),
        reservedFound: Object.freeze(JSON.parse(encoded.foundJson()))
      });
      lastTelemetry = Object.freeze({ tier, fallback: tier !== "single", cause: "reserved-policy" });
      return result;
    } finally {
      encoded.free();
    }
  };
  const encodeReserved = async (tier, value, policy) => encodeReservedSync(tier, value, policy);
  const close = async () => {
    if (closed) return;
    closed = true;
    await workerPool?.close();
    await sharedController?.close();
    single.free();
  };
  const makeHandle = (tier) => {
    const decode = decodeConfiguration.leanDispatch ? (ids) => {
      if (closed) throw new Error("execution-tier session is closed");
      return composedDecoder.decode(ids);
    } : void 0;
    const runtime = {
      tier,
      encode: async (value, options2) => {
        if (options2?.reserved !== void 0) {
          return (await encodeReserved(tier, value, options2.reserved)).ids;
        }
        return encodeForTier(tier, value);
      },
      async encodeInto(value, destination, options2) {
        ensureOpen();
        const output = destinationIds(destination);
        if (tier === "single" && typeof value === "string" && options2?.reserved === void 0 && typeof single.encodeResidentInputIntoOutput === "function") {
          const written = encodeResidentStringInto(single, value, output);
          lastTelemetry = Object.freeze({ tier, fallback: false });
          return written;
        }
        const ids = options2?.reserved === void 0 ? await encodeForTier(tier, value) : (await encodeReserved(tier, value, options2.reserved)).ids;
        return copyIdsInto(output, ids);
      },
      encodeReserved: (value, policy) => encodeReserved(tier, value, policy),
      async encodeDetailed(value, options2) {
        ensureOpen();
        if (format !== "htk") {
          throw new Error("detailed encoding requires an .htk vocabulary");
        }
        if (options2?.reserved !== void 0) {
          return encodeReserved(tier, value, options2.reserved);
        }
        const bytes = inputBytes(value);
        const ids = await encodeForTier(tier, value);
        const starts = single.tokenStarts(bytes, ids);
        const reservedFound = Object.freeze(JSON.parse(single.reservedFoundJson(bytes)));
        return Object.freeze({ ids, starts, reservedFound });
      },
      reservedTokens: () => reservedTokens,
      decode: decode ?? ((ids) => {
        ensureOpen();
        return composedDecoder.decode(ids);
      }),
      decodeBytes(ids) {
        ensureOpen();
        return composedDecoder.decodeBytes(ids);
      },
      decodeStats() {
        ensureOpen();
        return composedDecoder.stats();
      },
      vocabSize() {
        ensureOpen();
        return single.vocabSize();
      },
      tokenBytes(id) {
        ensureOpen();
        if (!Number.isInteger(id) || id < 0 || id > 4294967295) {
          throw new TypeError("token id must be a u32 value");
        }
        return single.tokenBytes(id);
      },
      telemetry: () => lastTelemetry,
      optimizations: () => optimizationConfiguration,
      lifecycle: () => Object.freeze({
        ...lifecycle,
        currentTier: tier,
        closed,
        workerImageBytes: workerImage?.byteLength ?? 0,
        workerImageRetained: workerImage === void 0 || workerImage.byteLength !== 0,
        sourceDigest: sourceDigest === void 0 ? [] : Array.from(sourceDigest)
      }),
      async switchTier(requested) {
        const nextTier = await ensureTier(requested);
        return makeHandle(nextTier);
      },
      close
    };
    if (tier === "single") {
      runtime.encodeReservedSync = (value, policy) => encodeReservedSync(tier, value, policy);
      runtime.encodeSync = (value, options2) => {
        ensureOpen();
        if (options2?.reserved !== void 0) {
          return encodeReservedSync(tier, value, options2.reserved).ids;
        }
        return encodeSingle(single, value);
      };
    }
    return Object.freeze(runtime);
  };
  let activeTier = initialTier;
  try {
    await ensureTier(initialTier);
  } catch (error) {
    if (options.tier !== void 0 && options.tier !== "auto") {
      await close();
      throw error;
    }
    activeTier = "single";
    const cause = error instanceof Error ? error.message : String(error);
    lastTelemetry = Object.freeze({
      tier: "single",
      fallback: true,
      cause: `${initialTier}-initialization: ${cause}`
    });
  }
  lifecycle.targetReuses = 0;
  return makeHandle(activeTier);
}

// hypertok-js/src/shim-runtime.mjs
var runtimes = /* @__PURE__ */ new WeakMap();
function registerShimRuntime(handle, runtime) {
  if (typeof handle !== "object" && typeof handle !== "function" || handle === null || typeof runtime !== "object" && typeof runtime !== "function" || runtime === null) {
    throw new TypeError("shim runtime registration requires object handles");
  }
  runtimes.set(handle, runtime);
  return handle;
}

// hypertok-js/src/index.mjs
var singleModuleUrl = new URL("../wasm/single/hypertok_wasm_core.js", import.meta.url);
var sharedModuleUrl = new URL("../wasm/shared/hypertok_wasm_core.js", import.meta.url);
var textEncoder2 = new TextEncoder();
function vocabularyBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError("fromBytes input must be a Uint8Array or ArrayBuffer");
}
async function localWasmSource(moduleUrl) {
  if (moduleUrl.protocol !== "file:") return void 0;
  const moduleName = "node:fs/promises";
  const { readFile } = await import(
    /* webpackIgnore: true */
    /* @vite-ignore */
    moduleName
  );
  return readFile(new URL("hypertok_wasm_core_bg.wasm", moduleUrl));
}
function textBytes(input) {
  if (typeof input !== "string") throw new TypeError("encode input must be a string");
  return textEncoder2.encode(input);
}
function destinationIds2(input) {
  if (!(input instanceof Uint32Array)) {
    throw new TypeError("encodeInto destination must be a Uint32Array");
  }
  return input;
}
function copyIdsInto2(destination, ids) {
  if (ids.length > destination.length) {
    throw new RangeError(
      `encodeInto destination has capacity ${destination.length}, but ${ids.length} ids are required`
    );
  }
  destination.set(ids);
  return ids.length;
}
function reservedSelection2(value, defaultAll, field) {
  if (value === void 0) return { all: defaultAll, names: [] };
  if (value === "all") return { all: true, names: [] };
  if (Array.isArray(value) && value.every((name) => typeof name === "string")) {
    return { all: false, names: [...new Set(value)] };
  }
  throw new TypeError(`${field} must be "all" or an array of reserved-token names`);
}
function reservedPolicy(policy) {
  if (policy === void 0) policy = {};
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("reserved policy must be an object");
  }
  return {
    matched: reservedSelection2(policy.match, true, "reserved.match"),
    refused: reservedSelection2(policy.refuse, false, "reserved.refuse")
  };
}
async function sentencePieceRuntime(bytes, options, moduleSource) {
  if (options.workers !== void 0 && (!Number.isInteger(options.workers) || options.workers < 1)) {
    throw new TypeError("workers must be a positive integer");
  }
  if (options.tier !== void 0 && options.tier !== "single") {
    throw new Error(`the ${options.tier} tier is unavailable for sentencepiece vocabularies`);
  }
  const module = await import(
    /* webpackIgnore: true */
    /* @vite-ignore */
    singleModuleUrl.href
  );
  await module.default(
    moduleSource === void 0 ? void 0 : { module_or_path: moduleSource }
  );
  const tokenizer = module.WasmSentencePieceTokenizer.fromHtk(bytes);
  const decodeConfiguration = resolveOptimizationConfig(options.optimizations).decode;
  const decoder = createComposedDecoder(tokenizer, {
    ...decodeConfiguration,
    assembly: false,
    boundary: false,
    hotStrings: false,
    table: false,
    byteTable: false,
    mixedRuns: false,
    runCache: false
  });
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error("tokenizer is closed");
  };
  const encodeReserved = (input, policy) => {
    ensureOpen();
    const normalized = reservedPolicy(policy);
    const encoded = tokenizer.encodeReserved(
      textBytes(input),
      normalized.matched.all,
      JSON.stringify(normalized.matched.names),
      normalized.refused.all,
      JSON.stringify(normalized.refused.names)
    );
    try {
      return Object.freeze({
        ids: encoded.ids(),
        starts: encoded.starts(),
        reservedFound: Object.freeze(JSON.parse(encoded.foundJson()))
      });
    } finally {
      encoded.free();
    }
  };
  const encodePlain = (input) => {
    ensureOpen();
    return tokenizer.encode(textBytes(input));
  };
  return Object.freeze({
    tier: "single",
    encode: async (input, callOptions) => callOptions?.reserved === void 0 ? encodePlain(input) : encodeReserved(input, callOptions.reserved).ids,
    encodeSync: (input, callOptions) => callOptions?.reserved === void 0 ? encodePlain(input) : encodeReserved(input, callOptions.reserved).ids,
    async encodeInto(input, destination, callOptions) {
      const output = destinationIds2(destination);
      const ids = callOptions?.reserved === void 0 ? encodePlain(input) : encodeReserved(input, callOptions.reserved).ids;
      return copyIdsInto2(output, ids);
    },
    async encodeDetailed(input, callOptions) {
      if (callOptions?.reserved !== void 0) {
        return encodeReserved(input, callOptions.reserved);
      }
      const inputBuffer = textBytes(input);
      const ids = tokenizer.encode(inputBuffer);
      return Object.freeze({
        ids,
        starts: tokenizer.tokenStarts(inputBuffer, ids),
        reservedFound: Object.freeze(JSON.parse(tokenizer.reservedFoundJson(inputBuffer)))
      });
    },
    decode(ids) {
      ensureOpen();
      return decoder.decode(ids);
    },
    tokenBytes(id) {
      ensureOpen();
      if (!Number.isInteger(id) || id < 0 || id > 4294967295) {
        throw new TypeError("token id must be a u32 value");
      }
      return tokenizer.tokenBytes(id);
    },
    close() {
      if (closed) return;
      closed = true;
      tokenizer.free();
    }
  });
}
function readMetadata(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint16(8, true);
  const structuralClass = view.getUint8(10) === 0 ? "byte_bpe" : "sentencepiece_bpe";
  const vocabSize4 = view.getUint32(16, true);
  const sectionCount = view.getUint32(24, true);
  const sectionTableOffset = view.getUint32(28, true);
  const prefix = [];
  const suffix = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = sectionTableOffset + index * 16;
    if (view.getUint32(entry, true) !== 8) continue;
    const offset = view.getUint32(entry + 4, true);
    const count = view.getUint32(offset, true);
    for (let postIndex = 0; postIndex < count; postIndex += 1) {
      const post = offset + 4 + postIndex * 5;
      const position = view.getUint8(post);
      const id = view.getUint32(post + 1, true);
      (position === 0 ? prefix : suffix).push(id);
    }
  }
  return Object.freeze({
    formatVersion,
    structuralClass,
    vocabSize: vocabSize4,
    prefixMarker: Uint32Array.from(prefix),
    suffixMarker: Uint32Array.from(suffix)
  });
}
function publicHandle(runtime, metadata) {
  const leanDispatch = runtime.optimizations?.().decode.leanDispatch === true;
  const handle = Object.freeze({
    vocabSize: metadata.vocabSize,
    structuralClass: metadata.structuralClass,
    tier: runtime.tier,
    formatVersion: metadata.formatVersion,
    prefixMarker: metadata.prefixMarker,
    suffixMarker: metadata.suffixMarker,
    encode: (text, options) => runtime.encode(text, options),
    encodeInto: (text, destination, options) => runtime.encodeInto(text, destination, options),
    encodeSync(text, options) {
      if (typeof runtime.encodeSync !== "function") {
        throw new Error(`encodeSync is unavailable on the ${runtime.tier} tier`);
      }
      return runtime.encodeSync(text, options);
    },
    encodeDetailed: (text, options) => runtime.encodeDetailed(text, options),
    decode: leanDispatch ? runtime.decode : (ids) => runtime.decode(ids),
    tokenBytes: (id) => runtime.tokenBytes(id),
    free() {
      void runtime.close();
    }
  });
  return registerShimRuntime(handle, runtime);
}
async function fromBytes(input, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("load options must be an object");
  }
  const bytes = vocabularyBytes(input);
  const unthreadedModuleSource = await localWasmSource(singleModuleUrl);
  const runtime = bytes.length > 10 && bytes[10] === 1 ? await sentencePieceRuntime(bytes, options, unthreadedModuleSource) : await createTierRuntime({
    unthreadedModuleUrl: singleModuleUrl.href,
    unthreadedModuleSource,
    threadedModuleUrl: sharedModuleUrl.href,
    vocabulary: bytes,
    format: "htk",
    tier: options.tier,
    workerCount: options.workers,
    optimizations: options.optimizations
  });
  return publicHandle(runtime, readMetadata(bytes));
}
export {
  fromBytes
};
