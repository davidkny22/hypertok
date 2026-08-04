const DEFAULT_CAPACITY = 8;

function capacity(value) {
  if (value === undefined) return DEFAULT_CAPACITY;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("capacity must be a positive safe integer");
  }
  return value;
}

function keyFor(ids, start, end) {
  let key = "";
  for (let index = start; index < end; index += 1) {
    const id = ids[index];
    key += String.fromCharCode(id >>> 16, id & 0xffff);
  }
  return key;
}

export function createMaximalRunCache(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("maximal-run cache options must be an object");
  }
  const limit = capacity(options.capacity);
  const entries = new Map();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let keyCodeUnits = 0;
  let outputCodeUnits = 0;

  function decode(ids, start, end, canonical) {
    const key = keyFor(ids, start, end);
    if (entries.has(key)) {
      const output = entries.get(key);
      entries.delete(key);
      entries.set(key, output);
      hits += 1;
      return output;
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
      outputCodeUnits,
    });
  }

  return Object.freeze({ decode, stats });
}
