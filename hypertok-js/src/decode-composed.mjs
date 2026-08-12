import { createAssemblyDecoder } from "./decode-assembly.mjs";
import { createBorrowedAssemblyDecoder } from "./decode-borrowed.mjs";
import { createHotStringDecoder } from "./decode-hotstrings.mjs";
import { createDecodeMemo } from "./decode-memo.mjs";
import { createDecodeTable } from "./decode-table.mjs";
import { createUtf16AssemblyDecoder } from "./decode-utf16.mjs";
import { createStringBuiltinsDecoder } from "./decode-string-builtins.mjs";

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
  const useBorrowedOutput = options.borrowedOutput === true;
  const useUtf16Output = options.utf16Output === true;
  const useTable = options.table === true;
  const useByteTable = options.byteTable === true;
  const useMixedRuns = options.mixedRuns === true;
  const useRunCache = options.runCache === true;
  const useNativeLatin1 = options.nativeLatin1 === true;
  const usePortableLatin1 = options.portableLatin1 === true;
  const useFusedValidation = options.fusedValidation === true;
  const useLeanDispatch = options.leanDispatch === true;
  const useCleanUnroll = options.cleanUnroll === true;
  const useDirectScratch = options.directScratch === true;
  const useMemo = options.memo === true;
  const useDirtyRunBatch = options.dirtyRunBatch === true;
  const useStringBuiltins = options.stringBuiltins === true;
  const useHotStrings = options.hotStrings === true;
  if (useBorrowedOutput && !useAssembly) {
    throw new TypeError("borrowed output decode requires assembly decode");
  }
  if (useUtf16Output && !useAssembly) {
    throw new TypeError("UTF-16 output decode requires assembly decode");
  }
  if (useBorrowedOutput && useUtf16Output) {
    throw new TypeError("borrowed output and UTF-16 output decode cannot both be on");
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
  if (useStringBuiltins && (useBorrowedOutput || useUtf16Output)) {
    throw new TypeError("string builtins require the dedicated assembly endpoint");
  }
  if (useDirtyRunBatch && !useMixedRuns) {
    throw new TypeError("dirty-run batching requires mixed-run decode");
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
    ? useStringBuiltins
      ? createStringBuiltinsDecoder(core)
      : useUtf16Output
      ? createUtf16AssemblyDecoder(core)
      : useBorrowedOutput
      ? createBorrowedAssemblyDecoder(core)
      : createAssemblyDecoder(core)
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
      cleanUnroll: useCleanUnroll,
      directScratch: useDirectScratch,
      dirtyRunBatch: useDirtyRunBatch,
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
      borrowedOutput: useBorrowedOutput,
      utf16Output: useUtf16Output,
      table: useTable,
      byteTable: useByteTable,
      mixedRuns: useMixedRuns,
      runCache: useRunCache,
      nativeLatin1: useNativeLatin1,
      portableLatin1: usePortableLatin1,
      fusedValidation: useFusedValidation,
      leanDispatch: useLeanDispatch,
      cleanUnroll: useCleanUnroll,
      directScratch: useDirectScratch,
      memo: useMemo,
      dirtyRunBatch: useDirtyRunBatch,
      stringBuiltins: useStringBuiltins,
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
