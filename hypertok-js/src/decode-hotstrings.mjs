const DEFAULT_MAX_ENTRIES = 8192;
const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_INDEX_BYTES = 1024 * 1024;
const DEFAULT_MIN_COVERAGE = 0.9;

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function tokenIds(input) {
  if (input instanceof Uint32Array) return input;
  if (
    Array.isArray(input) &&
    input.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff,
    )
  ) {
    return Uint32Array.from(input);
  }
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}

function assertCore(core) {
  if (
    core === null ||
    typeof core !== "object" ||
    typeof core.decode !== "function" ||
    typeof core.tokenBytes !== "function"
  ) {
    throw new TypeError("decode core must provide decode and tokenBytes functions");
  }
}

function vocabSize(core) {
  const value = typeof core.vocabSize === "function" ? core.vocabSize() : core.vocabSize;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function createHotStringDecoder(core, options = {}) {
  assertCore(core);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("hot-string options must be an object");
  }
  const maxEntries = positiveInteger(
    options.maxEntries,
    DEFAULT_MAX_ENTRIES,
    "maxEntries",
  );
  const maxPayloadBytes = positiveInteger(
    options.maxPayloadBytes,
    DEFAULT_MAX_PAYLOAD_BYTES,
    "maxPayloadBytes",
  );
  const maxIndexBytes = positiveInteger(
    options.maxIndexBytes,
    DEFAULT_MAX_INDEX_BYTES,
    "maxIndexBytes",
  );
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;
  if (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) {
    throw new TypeError("minCoverage must be between zero and one");
  }
  const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
  const size = vocabSize(core);
  let directIndex = size !== null && size * 4 <= maxIndexBytes ? new Int32Array(size) : null;
  const cachedStrings = [];
  const sparseCache = directIndex === null ? new Map() : null;
  let initialized = false;
  let active = false;
  let observedTokens = 0;
  let observedDistinct = 0;
  let coveredTokens = 0;
  let payloadBytes = 0;

  const cacheSize = () => (active ? coveredDistinct : 0);
  let coveredDistinct = 0;

  function cachedString(id) {
    if (directIndex === null) return sparseCache.get(id);
    const slot = directIndex[id];
    return slot === 0 ? undefined : cachedStrings[slot - 1];
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
      const capacity = Math.min(maxEntries, observedDistinct);
      const heapIds = new Uint32Array(capacity);
      const heapCounts = new Uint32Array(capacity);
      let heapSize = 0;
      const worse = (leftCount, leftId, rightCount, rightId) =>
        leftCount < rightCount || (leftCount === rightCount && leftId > rightId);
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
          if (
            right < heapSize &&
            worse(heapCounts[right], heapIds[right], heapCounts[left], heapIds[left])
          ) {
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
        if (heapSize < capacity) push(id, count);
        else if (worse(heapCounts[0], heapIds[0], count, id)) replaceWorst(id, count);
      }
      selected = heapIds;
    } else {
      const counts = new Map();
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      selected = [...counts.keys()];
      observedDistinct = selected.length;
      frequency = (id) => counts.get(id);
      selected.sort(
        (leftId, rightId) => frequency(rightId) - frequency(leftId) || leftId - rightId,
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
    const repeatedSingleUnits =
      observedTokens >= 65_536 &&
      coverage === 1 &&
      observedDistinct <= 2 &&
      coveredDistinct !== 0 &&
      payloadBytes / coveredDistinct <= 2;
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
    const ids = tokenIds(input);
    if (ids.length === 0) return core.decode(ids);
    initialize(ids);
    if (!active) return core.decode(ids);
    let output = "";
    let index = 0;
    while (index < ids.length) {
      const cached = cachedString(ids[index]);
      if (cached !== undefined) {
        output += cached;
        index += 1;
        continue;
      }
      const start = index;
      do {
        index += 1;
      } while (index < ids.length && cachedString(ids[index]) === undefined);
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
      observedCoverage: observedTokens === 0 ? 0 : coveredTokens / observedTokens,
    });
  }

  function tokenString(id) {
    return active ? cachedString(id) : undefined;
  }

  return Object.freeze({ decode, stats, tokenString });
}
