import { createMaximalRunCache } from "./decode-run-cache.mjs";
import { createNativeLatin1Decoder } from "./decode-latin1.mjs";
import { createValidatedIdScratch } from "./decode-id-scratch.mjs";

const DEFAULT_SEED_ENTRIES = 8192;
const DEFAULT_MAX_TABLE_IDS = 256 * 1024;
const DEFAULT_MAX_DIRTY_DENSITY = 0;
const DEFAULT_MIXED_RUN_PENALTY = 1;
const DIRTY = 0;
const UNTOUCHED = 1;
const MISSING = 2;

function nonnegativeInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function density(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("maxDirtyDensity must be between zero and one");
  }
  return value;
}

function nonnegativeNumber(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative finite number`);
  }
  return value;
}

function seedIds(value, size, limit) {
  if (value === undefined) {
    return Uint32Array.from({ length: limit }, (_, id) => id);
  }
  const ids = strictTokenIds(value);
  if (ids.length > limit) {
    throw new RangeError("seedIds cannot contain more entries than seedEntries");
  }
  const seen = new Set();
  for (const id of ids) {
    if (id >= size) throw new RangeError(`seedIds contains unknown token id ${id}`);
    if (seen.has(id)) throw new RangeError(`seedIds contains duplicate token id ${id}`);
    seen.add(id);
  }
  return ids;
}

function validTokenId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function validTokenIdFast(value) {
  return typeof value === "number" && (value >>> 0) === value;
}

function strictTokenIds(input) {
  if (input instanceof Uint32Array) return input;
  if (Array.isArray(input) && input.every(validTokenId)) return input;
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}

function tokenContainer(input) {
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
    if (byte > 0x7f) {
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
    if (first <= 0x7f) {
      codepoint = first;
      index += 1;
    } else if ((first & 0xe0) === 0xc0) {
      codepoint = ((first & 0x1f) << 6) | (bytes[index + 1] & 0x3f);
      index += 2;
    } else if ((first & 0xf0) === 0xe0) {
      codepoint = ((first & 0x0f) << 12) |
        ((bytes[index + 1] & 0x3f) << 6) |
        (bytes[index + 2] & 0x3f);
      index += 3;
    } else {
      codepoint = ((first & 0x07) << 18) |
        ((bytes[index + 1] & 0x3f) << 12) |
        ((bytes[index + 2] & 0x3f) << 6) |
        (bytes[index + 3] & 0x3f);
      index += 4;
    }
    if (codepoint <= 0xffff) {
      units.push(codepoint);
      if (codepoint > 0xff) oneByte = false;
    } else {
      const adjusted = codepoint - 0x10000;
      units.push(0xd800 + (adjusted >>> 10), 0xdc00 + (adjusted & 0x3ff));
      oneByte = false;
    }
  }
  return { text: fromCodeUnits(units), oneByte };
}

function vocabSize(core) {
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
    if (first <= 0x7f) {
      index += 1;
      continue;
    }
    let continuation;
    let codepoint;
    if ((first & 0xe0) === 0xc0) {
      if (first < 0xc2) return false;
      continuation = 1;
      codepoint = first & 0x1f;
    } else if ((first & 0xf0) === 0xe0) {
      continuation = 2;
      codepoint = first & 0x0f;
    } else if ((first & 0xf8) === 0xf0) {
      if (first > 0xf4) return false;
      continuation = 3;
      codepoint = first & 0x07;
    } else {
      return false;
    }
    if (index + continuation >= bytes.length) return false;
    for (let offset = 1; offset <= continuation; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) return false;
      codepoint = (codepoint << 6) | (next & 0x3f);
    }
    if (continuation === 2 && codepoint < 0x800) return false;
    if (continuation === 3 && codepoint < 0x10000) return false;
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) return false;
    if (codepoint > 0x10ffff) return false;
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
    let capacity = Math.max(256, scratch.length);
    while (capacity < length) capacity *= 2;
    scratch = new Uint8Array(capacity);
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

  function byteString(id) {
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
      scratchBytes: scratch.byteLength,
    });
  }

  return Object.freeze({ decode, byteString, decodeByteString, stats });
}

export function createDecodeTable(core, options = {}) {
  if (
    core === null ||
    typeof core !== "object" ||
    typeof core.decode !== "function" ||
    typeof core.tokenBytes !== "function"
  ) {
    throw new TypeError("decode table core must provide decode and tokenBytes functions");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("decode table options must be an object");
  }
  const size = vocabSize(core);
  const seedEntries = Math.min(
    nonnegativeInteger(options.seedEntries, DEFAULT_SEED_ENTRIES, "seedEntries"),
    size,
  );
  const seeds = seedIds(options.seedIds, size, seedEntries);
  const maxTableIds = nonnegativeInteger(
    options.maxTableIds,
    DEFAULT_MAX_TABLE_IDS,
    "maxTableIds",
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
  const useCleanUnroll = options.cleanUnroll ?? false;
  if (typeof useCleanUnroll !== "boolean") {
    throw new TypeError("cleanUnroll must be a boolean");
  }
  const validateTokenId = useLeanDispatch ? validTokenIdFast : validTokenId;
  const useDirectScratch = options.directScratch ?? false;
  if (typeof useDirectScratch !== "boolean") {
    throw new TypeError("directScratch must be a boolean");
  }
  if (useDirectScratch && !useMixedRuns) {
    throw new TypeError("direct ID scratch requires mixed-run decode");
  }
  const maxMixedDirtyDensity = density(options.maxMixedDirtyDensity, 0.5);
  const mixedRunPenalty = nonnegativeNumber(
    options.mixedRunPenalty,
    DEFAULT_MIXED_RUN_PENALTY,
    "mixedRunPenalty",
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
  const byteTable = useByteTable || useMixedRuns
    ? createTokenByteDecoder(core, size, now, useByteTable)
    : null;
  const runCache = useRunCache ? createMaximalRunCache(options.runCacheOptions) : null;
  const latin1 = useNativeLatin1 || usePortableLatin1
    ? createNativeLatin1Decoder(core, {
        ...options.nativeLatin1Options,
        portable: usePortableLatin1,
      })
    : null;
  const directScratch = useDirectScratch ? createValidatedIdScratch(validateTokenId) : null;
  let directScratchCalls = 0;

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
    if (inspect(id) !== 1) return undefined;
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
    return undefined;
  }

  function joinKnownClean(ids) {
    const packed = table;
    let output = "";
    let index = 0;
    if (ids instanceof Uint32Array) {
      if (useCleanUnroll) {
        const unrolledLength = ids.length - (ids.length % 4);
        for (; index < unrolledLength; index += 4) {
          let value = packed[ids[index]];
          if (typeof value !== "string") return index;
          output += value;
          value = packed[ids[index + 1]];
          if (typeof value !== "string") return index + 1;
          output += value;
          value = packed[ids[index + 2]];
          if (typeof value !== "string") return index + 2;
          output += value;
          value = packed[ids[index + 3]];
          if (typeof value !== "string") return index + 3;
          output += value;
        }
      }
      for (; index < ids.length; index += 1) {
        const value = packed[ids[index]];
        if (typeof value !== "string") return index;
        output += value;
      }
    } else {
      if (useCleanUnroll) {
        const unrolledLength = ids.length - (ids.length % 4);
        for (; index < unrolledLength; index += 4) {
          let id = ids[index];
          if (!validateTokenId(id)) return index;
          let value = packed[id];
          if (typeof value !== "string") return index;
          output += value;
          id = ids[index + 1];
          if (!validateTokenId(id)) return index + 1;
          value = packed[id];
          if (typeof value !== "string") return index + 1;
          output += value;
          id = ids[index + 2];
          if (!validateTokenId(id)) return index + 2;
          value = packed[id];
          if (typeof value !== "string") return index + 2;
          output += value;
          id = ids[index + 3];
          if (!validateTokenId(id)) return index + 3;
          value = packed[id];
          if (typeof value !== "string") return index + 3;
          output += value;
        }
      }
      for (; index < ids.length; index += 1) {
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

  function sampleDirty(ids) {
    const sampleCount = Math.min(32, ids.length);
    let sampledDirty = 0;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const id = ids[Math.floor((sample * ids.length) / sampleCount)];
      const state = inspect(id);
      if (state === 3) return { sampleCount, sampledDirty, unknown: true };
      if (state === 2) sampledDirty += 1;
    }
    return { sampleCount, sampledDirty, unknown: false };
  }

  function decodeCareful(input, firstMiss, sample = null) {
    const prepared = useFusedValidation
      ? fusedTokenIds(input, firstMiss)
      : { ids: strictTokenIds(input), firstMiss: 0 };
    const { ids } = prepared;
    const sampled = sample ?? sampleDirty(ids);
    if (sampled.unknown) {
      unknownFallbackCalls += 1;
      return fallback(ids);
    }
    if (useMixedRuns && sampled.sampledDirty / sampled.sampleCount > maxMixedDirtyDensity) {
      dirtyFallbackCalls += 1;
      sampledFallbackCalls += 1;
      mixedDensityFallbackCalls += 1;
      if ((useNativeLatin1 && latin1?.available) || usePortableLatin1) {
        return decodeLatin1(ids);
      }
      return fallback(ids);
    }
    if (!useMixedRuns && sampled.sampledDirty / sampled.sampleCount > maxDirtyDensity) {
      dirtyFallbackCalls += 1;
      sampledFallbackCalls += 1;
      if ((useNativeLatin1 && latin1?.available) || usePortableLatin1) return decodeLatin1(ids);
      return byteTable === null ? fallback(ids) : decodeBytesInJs(ids);
    }
    let dirtyIds = 0;
    let dirtyRuns = 0;
    let previousDirty = false;
    for (let index = prepared.firstMiss; index < ids.length; index += 1) {
      const id = ids[index];
      const state = inspect(id);
      if (state === 3) {
        unknownFallbackCalls += 1;
        if ((useNativeLatin1 && latin1?.available) || usePortableLatin1) {
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
        if ((useNativeLatin1 && latin1?.available) || usePortableLatin1) return decodeLatin1(ids);
        return byteTable === null ? fallback(ids) : decodeBytesInJs(ids);
      }
    }
    if (dirtyIds === 0) {
      const output = joinKnownClean(ids);
      if (typeof output !== "string") throw new Error("decode table restart did not converge");
      tableCalls += 1;
      return output;
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
        const value = byteTable?.byteString(ids[index]);
        if (useMixedRuns && typeof value !== "string") {
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
        output += runCache === null
          ? decodeRun()
          : runCache.decode(ids, start, index, decodeRun);
      } else {
        const run = ids instanceof Uint32Array
          ? ids.subarray(start, index)
          : ids.slice(start, index);
        output += core.decode(run);
      }
      dirtyRunCalls += 1;
    }
    tableCalls += 1;
    if (dirtyIds !== 0) mixedCalls += 1;
    return output;
  }

  function decodePrepared(ids, preparedByScratch) {
    if (ids.length === 0) {
      tableCalls += 1;
      return "";
    }
    if (ids.length > maxTableIds) {
      strictTokenIds(ids);
      largeFallbackCalls += 1;
      return fallback(ids);
    }
    let sampled = null;
    if (preparedByScratch) {
      sampled = sampleDirty(ids);
      if (sampled.unknown) {
        unknownFallbackCalls += 1;
        directScratchCalls += 1;
        return fallback(ids);
      }
      if (sampled.sampledDirty / sampled.sampleCount > maxMixedDirtyDensity) {
        dirtyFallbackCalls += 1;
        sampledFallbackCalls += 1;
        mixedDensityFallbackCalls += 1;
        directScratchCalls += 1;
        return fallback(ids);
      }
    }
    const output = joinKnownClean(ids);
    if (typeof output === "string") {
      tableCalls += 1;
      return output;
    }
    return decodeCareful(ids, output, sampled);
  }

  function decode(input) {
    const ids = tokenContainer(input);
    initialize();
    if (directScratch !== null && Array.isArray(ids)) {
      return directScratch.withValidated(ids, (prepared) => decodePrepared(prepared, true));
    }
    return decodePrepared(ids, false);
  }

  function tokenString(id) {
    if (!Number.isInteger(id) || id < 0 || id >= size) return undefined;
    const value = table[id];
    return typeof value === "string" ? value : undefined;
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
      cleanUnrollEnabled: useCleanUnroll,
      directScratchEnabled: useDirectScratch,
      directScratchCalls,
      directScratchState: directScratch?.stats() ?? null,
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
      stringPayloadBytes,
    });
  }

  return Object.freeze({ decode, tokenString, stats });
}
