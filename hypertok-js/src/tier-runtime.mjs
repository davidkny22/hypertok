import { resolveOptimizationConfig } from "./optimization-config.mjs";
import { createComposedDecoder } from "./decode-composed.mjs";
import { registerShimRuntime } from "./shim-runtime.mjs";

const textEncoder = new TextEncoder();

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
      `encodeInto destination has capacity ${destination.length}, but ${ids.length} ids are required`,
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
  const idCount = typeof tokenizer.encodeChunkedResidentInputIntoOutput === "function"
    ? tokenizer.encodeChunkedResidentInputIntoOutput(written, tokenizer.defaultChunkSize())
    : tokenizer.encodeResidentInputIntoOutput(written);
  if (idCount > destination.length) {
    throw new RangeError(
      `encodeInto destination has capacity ${destination.length}, but ${idCount} ids are required`,
    );
  }
  destination.set(tokenizer.residentOutputView().subarray(0, idCount));
  return idCount;
}

function reservedSelection(value, defaultAll, field) {
  if (value === undefined) return { all: defaultAll, names: [] };
  if (value === "all") return { all: true, names: [] };
  if (Array.isArray(value) && value.every((name) => typeof name === "string")) {
    return { all: false, names: [...new Set(value)] };
  }
  throw new TypeError(`${field} must be "all" or an array of reserved-token names`);
}

function normalizeReservedPolicy(policy) {
  if (policy === undefined) policy = {};
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("reserved policy must be an object");
  }
  return {
    matched: reservedSelection(policy.match, true, "reserved.match"),
    refused: reservedSelection(policy.refuse, false, "reserved.refuse"),
  };
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function browserCapabilities(scope = globalThis) {
  return Object.freeze({
    isolated: scope.crossOriginIsolated === true,
    sharedArrayBuffer: typeof scope.SharedArrayBuffer === "function",
    worker: typeof scope.Worker === "function",
  });
}

export function selectTier(requested, capabilities, hasThreadedArtifact = true) {
  const tier = requested ?? "auto";
  const shared =
    capabilities.isolated &&
    capabilities.sharedArrayBuffer &&
    capabilities.worker &&
    hasThreadedArtifact;
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

class RpcWorker {
  constructor(worker) {
    this.worker = worker;
    this.nextId = 0;
    this.pending = new Map();
    this.failure = undefined;
    worker.addEventListener("message", ({ data }) => {
      const pending = this.pending.get(data.id);
      if (pending === undefined) return;
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new Error(data.error));
    });
    worker.addEventListener("error", (event) => {
      const location = event.filename
        ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
        : "";
      const error = new Error(
        [event.message, location].filter((part) => part).join(" at ") || "execution worker failed",
      );
      this.failure = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  call(operation, value = {}, transfer = []) {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, operation, ...value }, transfer);
    });
  }

  close() {
    this.worker.terminate();
    const error = new Error("execution worker closed");
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class IndependentWorkerPool {
  constructor(workers) {
    this.workers = workers;
    this.nextWorker = 0;
    this.active = new Set();
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
      [input.buffer, ranges.buffer],
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
}

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

async function loadSingle(
  moduleUrl,
  moduleSource,
  vocabulary,
  scheme,
  format,
  bundledModule,
  resolverTrusted,
  resolverWarmup,
) {
  const module = bundledModule
    ?? await import(/* webpackIgnore: true */ /* @vite-ignore */ moduleUrl);
  await module.default(
    moduleSource === undefined ? undefined : { module_or_path: moduleSource },
  );
  if (format === "htk") {
    if (resolverTrusted) {
      if (resolverWarmup) {
        if (typeof module.WasmTokenizer.fromResolverTrustedWarmHtk !== "function") {
          throw new Error("the wasm module has no resolver warmup constructor");
        }
        return module.WasmTokenizer.fromResolverTrustedWarmHtk(vocabulary);
      }
      if (typeof module.WasmTokenizer.fromResolverTrustedHtk !== "function") {
        throw new Error("the wasm module has no resolver-provenance constructor");
      }
      return module.WasmTokenizer.fromResolverTrustedHtk(vocabulary);
    }
    return module.WasmTokenizer.fromHtk(vocabulary);
  }
  if (format === "huggingface") return module.WasmTokenizer.fromHuggingFace(vocabulary);
  return module.WasmTokenizer.fromTiktoken(vocabulary, scheme);
}

function createIndependentWorker() {
  return new Worker(new URL("./tier-worker.mjs", import.meta.url), { type: "module" });
}

function createSharedController() {
  return new Worker(new URL("./shared-controller.mjs", import.meta.url), { type: "module" });
}

async function initializeWorkerPool(
  count,
  moduleUrl,
  vocabulary,
  scheme,
  format,
  workerImage,
  sourceDigest,
) {
  const workers = Array.from({ length: count }, () => new RpcWorker(createIndependentWorker()));
  try {
    const initialized = await Promise.all(
      workers.map((worker, workerId) => {
        const copy = format === "htk" ? workerImage.slice() : vocabulary.slice();
        const value =
          format === "htk"
            ? {
                moduleUrl,
                format,
                workerImage: copy.buffer,
                sourceDigest: sourceDigest.slice().buffer,
                workerId,
              }
            : { moduleUrl, vocabulary: copy.buffer, scheme, format, workerId };
        const initialized = worker.call(
          "initialize",
          value,
          [copy.buffer],
        );
        const detached = copy.byteLength === 0;
        return initialized.then((result) => ({ ...result, detached }));
      }),
    );
    if (
      format === "htk" &&
      initialized.some(
        (entry) => !entry.imported || !equalBytes(entry.sourceDigest, sourceDigest),
      )
    ) {
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
      enlargements,
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
    const encoded = pool.encodeBatch(batch);
    for (let index = 0; index < batch.length; index += 1) {
      tasks.push(
        encoded.then((results) => ({
          ids: results[index],
          initialChunks: 1,
          enlargements: 0,
        })),
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
      activeWorkers: pool.active.size,
    }),
  };
}

export async function createTierRuntime(options) {
  const {
    unthreadedModuleUrl,
    unthreadedModule,
    unthreadedModuleSource,
    threadedModuleUrl,
    vocabulary,
    scheme,
    format = "tiktoken",
    workerCount = Math.max(1, Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1)),
    resolverTrusted = false,
    resolverWarmup = false,
  } = options;
  if (!(vocabulary instanceof Uint8Array)) {
    throw new TypeError("vocabulary must be a Uint8Array");
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new TypeError("workerCount must be a positive integer");
  }
  if (resolverWarmup && !resolverTrusted) {
    throw new TypeError("resolver warmup requires resolver provenance");
  }
  const capabilities = options.capabilities ?? browserCapabilities();
  const optimizationConfiguration = resolveOptimizationConfig(options.optimizations);
  const initialTier = selectTier(options.tier, capabilities, threadedModuleUrl !== undefined);
  if (format !== "tiktoken" && format !== "huggingface" && format !== "htk") {
    throw new TypeError(`unknown vocabulary format ${format}`);
  }
  const single = await loadSingle(
    unthreadedModuleUrl,
    unthreadedModuleSource,
    vocabulary,
    scheme,
    format,
    unthreadedModule,
    resolverTrusted,
    resolverWarmup,
  );
  const decodeConfiguration =
    optimizationConfiguration.decode.assembly && typeof single.decodeAssemblyBytes !== "function"
      ? Object.freeze({
          assembly: false,
          boundary: false,
          borrowedOutput: false,
          utf16Output: false,
          hotStrings: false,
          table: false,
          byteTable: false,
          mixedRuns: false,
          runCache: false,
          nativeLatin1: false,
          portableLatin1: false,
          fusedValidation: false,
          leanDispatch: false,
          cleanUnroll: false,
          directScratch: false,
          memo: optimizationConfiguration.decode.memo,
          raw: true,
        })
      : optimizationConfiguration.decode;
  const composedDecoder = createComposedDecoder(single, decodeConfiguration);
  const reservedTokens = Object.freeze(
    typeof single.reservedNamesJson === "function"
      ? JSON.parse(single.reservedNamesJson())
      : [],
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
    workerImageExports: workerImage === undefined ? 0 : 1,
    workerPoolInitializations: 0,
    workerImports: 0,
    workerSourceRebuilds: 0,
    sharedInitializations: 0,
    sharedImports: 0,
    sharedSourceRebuilds: 0,
    detachedTransfers: 0,
    targetReuses: 0,
    residentSingleIdentity: 1,
  };

  const ensureOpen = () => {
    if (closed) throw new Error("execution-tier session is closed");
  };

  const ensureTier = async (requested) => {
    ensureOpen();
    const tier = selectTier(requested, capabilities, threadedModuleUrl !== undefined);
    if (tier === "single") {
      lifecycle.targetReuses += 1;
      return tier;
    }
    if (workerImageError !== undefined) throw workerImageError;
    if (tier === "worker") {
      if (workerPool !== undefined) {
        lifecycle.targetReuses += 1;
        return tier;
      }
      if (workerInitialization === undefined) {
        workerInitialization = initializeWorkerPool(
          workerCount,
          unthreadedModuleUrl,
          vocabulary,
          scheme,
          format,
          workerImage,
          sourceDigest,
        );
      }
      try {
        workerPool = await workerInitialization;
      } catch (error) {
        workerInitialization = undefined;
        throw error;
      }
      lifecycle.workerPoolInitializations += 1;
      lifecycle.workerImports += workerPool.initialized.filter((entry) => entry.imported).length;
      lifecycle.workerSourceRebuilds += workerPool.initialized.filter(
        (entry) => !entry.imported,
      ).length;
      lifecycle.detachedTransfers += workerPool.initialized.filter(
        (entry) => entry.detached,
      ).length;
      return tier;
    }
    if (sharedController !== undefined && sharedInitialization !== undefined) {
      await sharedInitialization;
      lifecycle.targetReuses += 1;
      return tier;
    }
    if (sharedInitialization === undefined) {
      sharedController = new RpcWorker(createSharedController());
      const sourceCopy = format === "htk" ? undefined : vocabulary.slice();
      const transferred = format === "htk" ? workerImage.slice() : sourceCopy;
      const pending = sharedController.call(
        "initialize",
        {
          moduleUrl: threadedModuleUrl,
          vocabulary: sourceCopy?.buffer,
          scheme,
          format,
          workerImage: format === "htk" ? transferred.buffer : undefined,
          sourceDigest: format === "htk" ? sourceDigest.slice().buffer : undefined,
          workerCount,
        },
        [transferred.buffer],
      );
      const detached = transferred.byteLength === 0;
      sharedInitialization = pending.then((result) => ({ ...result, detached }));
    }
    let initialized;
    try {
      initialized = await sharedInitialization;
      if (
        format === "htk" &&
        (!initialized.imported || !equalBytes(initialized.sourceDigest, sourceDigest))
      ) {
        throw new Error("shared model identity does not match the resident vocabulary");
      }
    } catch (error) {
      sharedInitialization = undefined;
      sharedController.close();
      sharedController = undefined;
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
        const result = await encodeWithWorkers(single, workerPool, bytes);
        lastTelemetry = Object.freeze({ tier, fallback: false, ...result.telemetry });
        return result.ids;
      }
      const copy = bytes.slice();
      const result = await sharedController.call(
        "encode",
        { input: copy.buffer },
        [copy.buffer],
      );
      const telemetry = Array.from(result.telemetry);
      lastTelemetry = Object.freeze({
        tier,
        fallback: false,
        pretokens: telemetry[0],
        tasks: telemetry[1],
        initialChunks: telemetry[2],
        enlargements: telemetry[3],
        activeWorkers: telemetry[4],
      });
      return result.ids;
    } catch (error) {
      if (closed) throw error;
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
      JSON.stringify(normalized.refused.names),
    );
    try {
      const result = Object.freeze({
        ids: encoded.ids(),
        starts: encoded.starts(),
        reservedFound: Object.freeze(JSON.parse(encoded.foundJson())),
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

  let residentSingleHandle;
  const makeHandle = (tier) => {
    const decode = decodeConfiguration.leanDispatch
      ? (ids) => {
          if (closed) throw new Error("execution-tier session is closed");
          return composedDecoder.decode(ids);
        }
      : undefined;
    const runtime = {
      tier,
      encode: async (value, options) => {
        if (options?.reserved !== undefined) {
          return (await encodeReserved(tier, value, options.reserved)).ids;
        }
        return encodeForTier(tier, value);
      },
      async encodeInto(value, destination, options) {
        ensureOpen();
        const output = destinationIds(destination);
        if (
          tier === "single" &&
          typeof value === "string" &&
          options?.reserved === undefined &&
          typeof single.encodeResidentInputIntoOutput === "function"
        ) {
          const written = encodeResidentStringInto(single, value, output);
          lastTelemetry = Object.freeze({ tier, fallback: false });
          return written;
        }
        const ids = options?.reserved === undefined
          ? await encodeForTier(tier, value)
          : (await encodeReserved(tier, value, options.reserved)).ids;
        return copyIdsInto(output, ids);
      },
      encodeReserved: (value, policy) => encodeReserved(tier, value, policy),
      async encodeDetailed(value, options) {
        ensureOpen();
        if (format !== "htk") {
          throw new Error("detailed encoding requires an .htk vocabulary");
        }
        if (options?.reserved !== undefined) {
          return encodeReserved(tier, value, options.reserved);
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
        if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) {
          throw new TypeError("token id must be a u32 value");
        }
        return single.tokenBytes(id);
      },
      telemetry: () => lastTelemetry,
      optimizations: () => optimizationConfiguration,
      lifecycle: () =>
        Object.freeze({
          ...lifecycle,
          currentTier: tier,
          closed,
          workerImageBytes: workerImage?.byteLength ?? 0,
          workerImageRetained: workerImage === undefined || workerImage.byteLength !== 0,
          sourceDigest: sourceDigest === undefined ? [] : Array.from(sourceDigest),
        }),
      async switchTier(requested) {
        const nextTier = await ensureTier(requested);
        return registeredHandle(nextTier);
      },
      close,
    };
    if (tier === "single") {
      runtime.encodeReservedSync = (value, policy) => encodeReservedSync(tier, value, policy);
      runtime.encodeSync = (value, options) => {
        ensureOpen();
        if (options?.reserved !== undefined) {
          return encodeReservedSync(tier, value, options.reserved).ids;
        }
        return encodeSingle(single, value);
      };
    }
    return Object.freeze(runtime);
  };
  const registeredHandle = (tier) => {
    if (tier === "single") return residentSingleHandle;
    return registerShimRuntime(makeHandle(tier), residentSingleHandle);
  };
  residentSingleHandle = makeHandle("single");

  let activeTier = initialTier;
  try {
    await ensureTier(initialTier);
  } catch (error) {
    if (options.tier !== undefined && options.tier !== "auto") {
      await close();
      throw error;
    }
    activeTier = "single";
    const cause = error instanceof Error ? error.message : String(error);
    lastTelemetry = Object.freeze({
      tier: "single",
      fallback: true,
      cause: `${initialTier}-initialization: ${cause}`,
    });
  }
  lifecycle.targetReuses = 0;
  return registeredHandle(activeTier);
}
