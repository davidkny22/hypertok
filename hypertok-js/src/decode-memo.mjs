const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_IDS = 4_096;
const DEFAULT_MAX_OUTPUT_CODE_UNITS = 8_192;
const PROBE_ENTRIES = 8;
const PENDING = Object.freeze({ state: "pending" });
const UNCACHEABLE = Object.freeze({ state: "uncacheable" });

function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonSharedUint32Array(input) {
  if (
    !(input instanceof Uint32Array) ||
    Object.getPrototypeOf(input) !== Uint32Array.prototype
  ) {
    return false;
  }
  return !(
    typeof SharedArrayBuffer === "function" &&
    input.buffer instanceof SharedArrayBuffer
  );
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
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    lengthDescriptor.value !== input.length ||
    lengthDescriptor.writable !== true
  ) {
    return false;
  }
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true ||
      descriptor.writable !== true
    ) {
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
    if (typeof value !== "number" || (value >>> 0) !== value) return null;
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

export function createDecodeMemo(decoder, options = {}) {
  if (decoder === null || typeof decoder !== "object" || typeof decoder.decode !== "function") {
    throw new TypeError("decode memo requires a decoder");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("decode memo options must be an object");
  }
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
  const maxIds = positiveInteger(options.maxIds, DEFAULT_MAX_IDS, "maxIds");
  const maxOutputCodeUnits = positiveInteger(
    options.maxOutputCodeUnits,
    DEFAULT_MAX_OUTPUT_CODE_UNITS,
    "maxOutputCodeUnits",
  );
  const records = new WeakMap();
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
    if (key !== undefined && records.get(key) === record) records.delete(key);
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
    if (existing !== undefined && existing !== PENDING && existing !== UNCACHEABLE) {
      snapshotBytes += inputSnapshot.byteLength - existing.snapshot.byteLength;
      outputCodeUnits += value.length - existing.output.length;
      existing.snapshot = inputSnapshot;
      existing.output = value;
      return true;
    }
    const displaced = slots[nextSlot];
    if (displaced !== undefined) {
      removeRecord(displaced);
      evictions += 1;
    }
    const record = {
      key: new WeakRef(input),
      snapshot: inputSnapshot,
      output: value,
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
    if (
      typeof value !== "string" ||
      value.length > maxOutputCodeUnits ||
      input.length === 0 ||
      input.length > maxIds
    ) {
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
      const output = decoder.decode(input);
      if (repeatedProbe) {
        tracking = store(input, output);
        probes.fill(undefined);
        probeCount = 0;
      } else if (
        probeCount < PROBE_ENTRIES &&
        memoContainer(input) &&
        typeof output === "string" &&
        output.length <= maxOutputCodeUnits &&
        input.length > 0 &&
        input.length <= maxIds
      ) {
        probes[probeCount] = input;
        probeCount += 1;
      }
      return output;
    }
    const eligible = memoContainer(input);
    const record = eligible ? records.get(input) : undefined;
    if (record !== undefined && record !== PENDING && record !== UNCACHEABLE) {
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
    } else if (record === undefined && eligible) {
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
      evictions,
    });
  }

  return Object.freeze({ decode, stats });
}
