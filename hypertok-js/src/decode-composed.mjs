import { createAssemblyDecoder } from "./decode-assembly.mjs";
import { createBoundaryDecoder } from "./decode-boundary.mjs";
import { createHotStringDecoder } from "./decode-hotstrings.mjs";
import { createDecodeMemo } from "./decode-memo.mjs";
import { createDecodeTable } from "./decode-table.mjs";

function requiredCore(core) {
  if (
    core === null ||
    typeof core !== "object" ||
    typeof core.decode !== "function" ||
    typeof core.tokenBytes !== "function" ||
    typeof core.vocabSize !== "function"
  ) {
    throw new TypeError("composed decode core must provide decode, tokenBytes, and vocabSize");
  }
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

function gatherTokenBytes(core, input) {
  const ids = tokenIds(input);
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

export function createComposedDecoder(core, options = {}) {
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
    decode: (ids) => core.decode(tokenIds(ids)),
    stats: () => Object.freeze({ decoderCalls: 0 }),
  });
  const assembly = useAssembly
    ? (useBoundary ? createBoundaryDecoder(core) : createAssemblyDecoder(core))
    : raw;
  let active = assembly;
  let table = null;
  let hotStrings = null;
  let memo = null;
  const facade = (decoder) => ({
    vocabSize: () => core.vocabSize(),
    tokenBytes: (id) => core.tokenBytes(id),
    decode: (ids) => decoder.decode(ids),
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
      leanDispatch: useLeanDispatch,
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
      memoState: memo?.stats() ?? null,
    });
  }

  return Object.freeze({
    decode: useLeanDispatch ? active.decode : (ids) => active.decode(ids),
    decodeBytes: (ids) =>
      useAssembly
        ? core.decodeAssemblyBytes(tokenIds(ids))
        : gatherTokenBytes(core, ids),
    tokenString,
    stats,
  });
}
