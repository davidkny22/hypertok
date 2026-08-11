import { registerShimRuntime, resolveShimRuntime } from "./shim-runtime.mjs";

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

export function createPublicRuntime(runtime, bytes) {
  const metadata = readMetadata(bytes);
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
  return registerShimRuntime(handle, resolveShimRuntime(runtime));
}
