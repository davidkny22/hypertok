const contexts = new WeakMap();
const moduleBytes = Uint8Array.of(
  0,97,115,109,1,0,0,0,1,20,3,94,119,1,96,3,99,0,127,127,1,100,111,96,2,127,127,1,100,111,2,50,2,14,119,97,115,109,58,106,115,45,115,116,114,105,110,103,17,102,114,111,109,67,104,97,114,67,111,100,101,65,114,114,97,121,0,1,3,101,110,118,6,109,101,109,111,114,121,2,0,1,3,2,1,2,7,14,1,10,102,114,111,109,77,101,109,111,114,121,0,1,10,65,1,63,2,1,100,0,1,127,32,1,251,7,0,33,2,2,64,3,64,32,3,32,1,79,13,1,32,2,32,3,32,0,32,3,65,2,108,106,47,1,0,251,14,0,32,3,65,1,106,33,3,12,0,11,0,11,32,2,65,0,32,1,16,0,11,
);

function tokenIds(input) {
  if (input instanceof Uint32Array) return input;
  if (
    Array.isArray(input) &&
    input.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff)
  ) {
    return Uint32Array.from(input);
  }
  throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
}

export function registerStringBuiltinsContext(core, wasm) {
  if (core === null || typeof core !== "object") {
    throw new TypeError("string builtins context requires a tokenizer");
  }
  if (
    wasm === null ||
    typeof wasm !== "object" ||
    !(wasm.memory instanceof WebAssembly.Memory)
  ) return false;
  contexts.set(core, wasm);
  return true;
}

export function createStringBuiltinsDecoder(core) {
  const wasm = contexts.get(core);
  if (wasm === undefined) throw new Error("string builtins require a registered wasm context");
  let glue = null;
  try {
    const module = new WebAssembly.Module(moduleBytes, { builtins: ["js-string"] });
    glue = new WebAssembly.Instance(module, { env: { memory: wasm.memory } });
  } catch {
    // Engines without JavaScript String Builtins retain the exact resident decoder.
  }
  let decoderCalls = 0;
  let codeUnits = 0;

  function decode(input) {
    const ids = tokenIds(input);
    if (glue === null) return core.decode(ids);
    const pointer = wasm.__wbindgen_malloc(ids.length * 4, 4);
    new Uint32Array(wasm.memory.buffer, pointer, ids.length).set(ids);
    const result = wasm.wasmtokenizer_decodeAssemblyUtf16(core.__wbg_ptr, pointer, ids.length);
    if (result[3]) return core.decode(ids);
    try {
      decoderCalls += 1;
      codeUnits += result[1];
      return glue.exports.fromMemory(result[0], result[1]);
    } finally {
      wasm.__wbindgen_free(result[0], result[1] * 2, 2);
    }
  }

  return Object.freeze({
    decode,
    stats: () => Object.freeze({ supported: glue !== null, decoderCalls, codeUnits }),
  });
}
