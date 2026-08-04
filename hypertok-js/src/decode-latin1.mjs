function validTokenId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function tokenContainer(input) {
  if (input instanceof Uint32Array || Array.isArray(input)) return input;
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}

function vocabSize(core) {
  const value = typeof core.vocabSize === "function" ? core.vocabSize() : core.vocabSize;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Latin-1 decode core must provide a positive vocabSize");
  }
  return value;
}

function byteString(bytes) {
  let output = "";
  for (let start = 0; start < bytes.length; start += 4096) {
    output += String.fromCharCode(...bytes.subarray(start, start + 4096));
  }
  return output;
}

function defaultNativeUnmap(value) {
  const buffer = globalThis.Buffer;
  return typeof buffer?.from === "function" ? buffer.from(value, "latin1") : null;
}

export function createNativeLatin1Decoder(core, options = {}) {
  if (core === null || typeof core !== "object" || typeof core.tokenBytes !== "function") {
    throw new TypeError("Latin-1 decode core must provide tokenBytes");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Latin-1 decode options must be an object");
  }
  const size = vocabSize(core);
  const now = options.now ?? (() => performance.now());
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const nativeUnmap = options.nativeUnmap === undefined
    ? defaultNativeUnmap
    : options.nativeUnmap;
  if (nativeUnmap !== null && typeof nativeUnmap !== "function") {
    throw new TypeError("nativeUnmap must be a function or null");
  }
  const portable = options.portable ?? false;
  if (typeof portable !== "boolean") throw new TypeError("portable must be a boolean");
  const available = nativeUnmap !== null && nativeUnmap("") !== null;
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const strings = new Array(size);
  const present = new Uint8Array(size);
  let initialized = false;
  let known = 0;
  let payloadCodeUnits = 0;
  let buildMilliseconds = 0;
  let decoderCalls = 0;
  let bytesConverted = 0;
  let portableDecoderCalls = 0;
  let portableBytesConverted = 0;
  let portableScratch = new Uint8Array(0);

  function initialize() {
    if (initialized || (!available && !portable)) return;
    const started = now();
    for (let id = 0; id < size; id += 1) {
      try {
        const bytes = core.tokenBytes(id);
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError("tokenBytes must return a Uint8Array");
        }
        strings[id] = byteString(bytes);
        present[id] = 1;
        known += 1;
        payloadCodeUnits += bytes.length;
      } catch (error) {
        if (error instanceof TypeError && /tokenBytes must return/.test(error.message)) throw error;
      }
    }
    initialized = true;
    buildMilliseconds = now() - started;
  }

  function binaryFor(input) {
    const ids = tokenContainer(input);
    initialize();
    let binary = "";
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (!(ids instanceof Uint32Array) && !validTokenId(id)) {
        throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
      }
      if (id >= size || present[id] === 0) throw new RangeError(`unknown token id ${id}`);
      binary += strings[id];
    }
    return binary;
  }

  function decode(input) {
    if (!available) throw new Error("native Latin-1 decode is unavailable");
    const binary = binaryFor(input);
    const bytes = nativeUnmap(binary);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("nativeUnmap must return a Uint8Array");
    }
    decoderCalls += 1;
    bytesConverted += bytes.length;
    return decoder.decode(bytes);
  }

  function decodePortable(input) {
    if (!portable) throw new Error("portable Latin-1 decode is unavailable");
    const binary = binaryFor(input);
    if (portableScratch.length < binary.length) {
      let capacity = Math.max(256, portableScratch.length);
      while (capacity < binary.length) capacity *= 2;
      portableScratch = new Uint8Array(capacity);
    }
    for (let index = 0; index < binary.length; index += 1) {
      portableScratch[index] = binary.charCodeAt(index);
    }
    portableDecoderCalls += 1;
    portableBytesConverted += binary.length;
    return decoder.decode(portableScratch.subarray(0, binary.length));
  }

  function stats() {
    return Object.freeze({
      available,
      portable,
      initialized,
      known,
      payloadCodeUnits,
      presentBytes: present.byteLength,
      buildMilliseconds,
      decoderCalls,
      bytesConverted,
      portableDecoderCalls,
      portableBytesConverted,
      portableScratchBytes: portableScratch.byteLength,
    });
  }

  return Object.freeze({ available, portable, decode, decodePortable, stats });
}
