import { createTierRuntime } from "./tier-runtime.mjs";
import { createComposedDecoder } from "./decode-composed.mjs";
import { resolveOptimizationConfig } from "./optimization-config.mjs";
import { registerShimRuntime } from "./shim-runtime.mjs";

const singleModuleUrl = new URL("../wasm/single/hypertok_wasm_core.js", import.meta.url);
const sharedModuleUrl = new URL("../wasm/shared/hypertok_wasm_core.js", import.meta.url);
const textEncoder = new TextEncoder();

function vocabularyBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError("fromBytes input must be a Uint8Array or ArrayBuffer");
}

async function localWasmSource(moduleUrl) {
  if (moduleUrl.protocol !== "file:") return undefined;
  const moduleName = "node:fs/promises";
  const { readFile } = await import(/* webpackIgnore: true */ /* @vite-ignore */ moduleName);
  return readFile(new URL("hypertok_wasm_core_bg.wasm", moduleUrl));
}

function textBytes(input) {
  if (typeof input !== "string") throw new TypeError("encode input must be a string");
  return textEncoder.encode(input);
}

function destinationIds(input) {
  if (!(input instanceof Uint32Array)) {
    throw new TypeError("encodeInto destination must be a Uint32Array");
  }
  return input;
}

function copyIdsInto(destination, ids) {
  if (ids.length > destination.length) {
    throw new RangeError(
      `encodeInto destination has capacity ${destination.length}, but ${ids.length} ids are required`,
    );
  }
  destination.set(ids);
  return ids.length;
}

function reservedSelection(value, defaultAll, field) {
  if (value === undefined) return { all: defaultAll, names: [] };
  if (value === "all") return { all: true, names: [] };
  if (Array.isArray(value) && value.every((name) => typeof name === "string")) {
    return { all: false, names: [...new Set(value)] };
  }
  throw new TypeError(`${field} must be "all" or an array of reserved-token names`);
}

function reservedPolicy(policy) {
  if (policy === undefined) policy = {};
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("reserved policy must be an object");
  }
  return {
    matched: reservedSelection(policy.match, true, "reserved.match"),
    refused: reservedSelection(policy.refuse, false, "reserved.refuse"),
  };
}

async function sentencePieceRuntime(bytes, options, moduleSource) {
  if (options.workers !== undefined && (!Number.isInteger(options.workers) || options.workers < 1)) {
    throw new TypeError("workers must be a positive integer");
  }
  if (options.tier !== undefined && options.tier !== "single") {
    throw new Error(`the ${options.tier} tier is unavailable for sentencepiece vocabularies`);
  }
  const module = await import(/* webpackIgnore: true */ /* @vite-ignore */ singleModuleUrl.href);
  await module.default(
    moduleSource === undefined ? undefined : { module_or_path: moduleSource },
  );
  const tokenizer = module.WasmSentencePieceTokenizer.fromHtk(bytes);
  const decodeConfiguration = resolveOptimizationConfig(options.optimizations).decode;
  // SentencePiece decode must interpret its metaspace marker as text structure. The generic
  // byte-BPE assembly and table paths would emit that marker's bytes instead of exact spaces.
  const decoder = createComposedDecoder(tokenizer, {
    ...decodeConfiguration,
    assembly: false,
    boundary: false,
    hotStrings: false,
    table: false,
    byteTable: false,
    mixedRuns: false,
    runCache: false,
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
      JSON.stringify(normalized.refused.names),
    );
    try {
      return Object.freeze({
        ids: encoded.ids(),
        starts: encoded.starts(),
        reservedFound: Object.freeze(JSON.parse(encoded.foundJson())),
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
    encode: async (input, callOptions) =>
      callOptions?.reserved === undefined
        ? encodePlain(input)
        : encodeReserved(input, callOptions.reserved).ids,
    encodeSync: (input, callOptions) =>
      callOptions?.reserved === undefined
        ? encodePlain(input)
        : encodeReserved(input, callOptions.reserved).ids,
    async encodeInto(input, destination, callOptions) {
      const output = destinationIds(destination);
      const ids = callOptions?.reserved === undefined
        ? encodePlain(input)
        : encodeReserved(input, callOptions.reserved).ids;
      return copyIdsInto(output, ids);
    },
    async encodeDetailed(input, callOptions) {
      if (callOptions?.reserved !== undefined) {
        return encodeReserved(input, callOptions.reserved);
      }
      const inputBuffer = textBytes(input);
      const ids = tokenizer.encode(inputBuffer);
      return Object.freeze({
        ids,
        starts: tokenizer.tokenStarts(inputBuffer, ids),
        reservedFound: Object.freeze(JSON.parse(tokenizer.reservedFoundJson(inputBuffer))),
      });
    },
    decode(ids) {
      ensureOpen();
      return decoder.decode(ids);
    },
    tokenBytes(id) {
      ensureOpen();
      if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) {
        throw new TypeError("token id must be a u32 value");
      }
      return tokenizer.tokenBytes(id);
    },
    close() {
      if (closed) return;
      closed = true;
      tokenizer.free();
    },
  });
}

function readMetadata(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint16(8, true);
  const structuralClass = view.getUint8(10) === 0 ? "byte_bpe" : "sentencepiece_bpe";
  const vocabSize = view.getUint32(16, true);
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
    vocabSize,
    prefixMarker: Uint32Array.from(prefix),
    suffixMarker: Uint32Array.from(suffix),
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
    },
  });
  return registerShimRuntime(handle, runtime);
}

export async function fromBytes(input, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("load options must be an object");
  }
  const bytes = vocabularyBytes(input);
  const unthreadedModuleSource = await localWasmSource(singleModuleUrl);
  const runtime = bytes.length > 10 && bytes[10] === 1
    ? await sentencePieceRuntime(bytes, options, unthreadedModuleSource)
    : await createTierRuntime({
        unthreadedModuleUrl: singleModuleUrl.href,
        unthreadedModuleSource,
        threadedModuleUrl: sharedModuleUrl.href,
        vocabulary: bytes,
        format: "htk",
        tier: options.tier,
        workerCount: options.workers,
        optimizations: options.optimizations,
      });
  return publicHandle(runtime, readMetadata(bytes));
}
