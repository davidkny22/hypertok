import { createTierRuntime } from "./tier-runtime.mjs";
import { createComposedDecoder } from "./decode-composed.mjs";
import { resolveOptimizationConfig } from "./optimization-config.mjs";
import { createPublicRuntime } from "./public-runtime.mjs";
import { isResolvedVocabHandle, resolverOwnedBytes } from "./resolver-provenance.mjs";
import * as singleWasmModule from "../wasm/single/hypertok_wasm_core.js";

const moduleBaseUrl = typeof import.meta.url === "string" ? import.meta.url : undefined;
const singleModuleUrl = moduleBaseUrl === undefined
  ? undefined
  : new URL("../wasm/single/hypertok_wasm_core.js", import.meta.url);
const sharedModuleUrl = moduleBaseUrl === undefined
  ? undefined
  : new URL("../wasm/shared/hypertok_wasm_core.js", import.meta.url);
const textEncoder = new TextEncoder();

function vocabularyBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError("fromBytes input must be a Uint8Array or ArrayBuffer");
}

function vocabularyInput(input, validate) {
  if (isResolvedVocabHandle(input)) {
    return Object.freeze({
      bytes: resolverOwnedBytes(input),
      resolverTrusted: validate !== true,
    });
  }
  return Object.freeze({ bytes: vocabularyBytes(input), resolverTrusted: false });
}

async function defaultWasmSource(moduleUrl) {
  if (moduleUrl === undefined) return undefined;
  if (moduleUrl.protocol !== "file:") {
    return new URL("hypertok_wasm_core_bg.wasm", moduleUrl);
  }
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

async function sentencePieceRuntime(bytes, options, moduleSource, resolverTrusted) {
  if (options.workers !== undefined && (!Number.isInteger(options.workers) || options.workers < 1)) {
    throw new TypeError("workers must be a positive integer");
  }
  if (options.tier !== undefined && options.tier !== "single") {
    throw new Error(`the ${options.tier} tier is unavailable for sentencepiece vocabularies`);
  }
  await singleWasmModule.default(
    moduleSource === undefined ? undefined : { module_or_path: moduleSource },
  );
  const constructor = resolverTrusted
    ? singleWasmModule.WasmSentencePieceTokenizer.fromResolverTrustedHtk
    : singleWasmModule.WasmSentencePieceTokenizer.fromHtk;
  if (typeof constructor !== "function") {
    throw new Error("the wasm module has no resolver-provenance sentencepiece constructor");
  }
  const tokenizer = constructor.call(singleWasmModule.WasmSentencePieceTokenizer, bytes);
  const decodeConfiguration = resolveOptimizationConfig(options.optimizations).decode;
  // SentencePiece decode must interpret its metaspace marker as text structure. The generic
  // byte-BPE assembly and table paths would emit that marker's bytes instead of exact spaces.
  const decoder = createComposedDecoder(tokenizer, {
    ...decodeConfiguration,
    assembly: false,
    borrowedOutput: false,
    utf16Output: false,
    hotStrings: false,
    table: false,
    byteTable: false,
    mixedRuns: false,
    runCache: false,
    dirtyRunBatch: false,
    stringBuiltins: false,
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

export async function fromBytes(input, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("load options must be an object");
  }
  if (options.validate !== undefined && typeof options.validate !== "boolean") {
    throw new TypeError("validate must be a boolean");
  }
  const { bytes, resolverTrusted } = vocabularyInput(input, options.validate);
  const unthreadedModuleSource = options.moduleSource
    ?? await defaultWasmSource(singleModuleUrl);
  const runtime = bytes.length > 10 && bytes[10] === 1
    ? await sentencePieceRuntime(bytes, options, unthreadedModuleSource, resolverTrusted)
    : await createTierRuntime({
        unthreadedModule: singleWasmModule,
        unthreadedModuleUrl: singleModuleUrl?.href,
        unthreadedModuleSource,
        threadedModuleUrl: sharedModuleUrl?.href,
        vocabulary: bytes,
        format: "htk",
        tier: options.tier,
        workerCount: options.workers,
        optimizations: options.optimizations,
        resolverTrusted,
      });
  return createPublicRuntime(runtime, bytes);
}
