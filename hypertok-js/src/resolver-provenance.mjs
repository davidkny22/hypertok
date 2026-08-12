const bytesByHandle = new WeakMap();

function vocabularyBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("vocabulary resolver returned non-byte data");
}

export function createResolvedVocabHandle(value) {
  const ownedBytes = new Uint8Array(vocabularyBytes(value));
  const handle = Object.create(null);
  Object.defineProperty(handle, "bytes", {
    enumerable: true,
    get() {
      return new Uint8Array(resolverOwnedBytes(this));
    },
  });
  bytesByHandle.set(handle, ownedBytes);
  return Object.freeze(handle);
}

export function createResolvedVocabLoader(resolve) {
  if (typeof resolve !== "function") throw new TypeError("resolve must be a function");
  return async function loadResolvedVocab(name, options) {
    const resolved = await resolve(name, options);
    return createResolvedVocabHandle(resolved);
  };
}

export function isResolvedVocabHandle(value) {
  return typeof value === "object" && value !== null && bytesByHandle.has(value);
}

export function resolverOwnedBytes(handle) {
  const bytes = bytesByHandle.get(handle);
  if (bytes === undefined) {
    throw new TypeError("trusted construction requires a resolver-owned vocabulary handle");
  }
  return bytes;
}

export function resolverOwnedWorkerImage(handle) {
  const bytes = resolverOwnedBytes(handle);
  if (bytes.length < 64) throw new RangeError("resolver-owned vocabulary header is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionCount = view.getUint32(24, true);
  const tableOffset = view.getUint32(28, true);
  const tableLength = sectionCount * 16;
  if (!Number.isSafeInteger(tableLength) || tableOffset + tableLength > bytes.length) {
    throw new RangeError("resolver-owned vocabulary section table is out of bounds");
  }
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = tableOffset + index * 16;
    if (view.getUint32(entry, true) !== 1026) continue;
    const sectionOffset = view.getUint32(entry + 4, true);
    const sectionLength = Number(view.getBigUint64(entry + 8, true));
    if (!Number.isSafeInteger(sectionLength) || sectionOffset + sectionLength > bytes.length) {
      throw new RangeError("resolver-owned built-state section is out of bounds");
    }
    if (sectionLength < 64) throw new RangeError("resolver-owned built-state header is truncated");
    const lookupLength = view.getUint32(sectionOffset + 20, true);
    const workerLength = view.getUint32(sectionOffset + 24, true);
    const workerStart = sectionOffset + 64 + lookupLength;
    const workerEnd = workerStart + workerLength;
    if (workerEnd > sectionOffset + sectionLength) {
      throw new RangeError("resolver-owned worker image is out of bounds");
    }
    return bytes.slice(workerStart, workerEnd);
  }
  throw new RangeError("resolver-owned vocabulary has no built-state section");
}
