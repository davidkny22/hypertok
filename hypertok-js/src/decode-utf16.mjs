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

export function createUtf16AssemblyDecoder(core) {
  if (
    core === null ||
    typeof core !== "object" ||
    typeof core.decodeAssemblyUtf16 !== "function"
  ) {
    throw new TypeError("UTF-16 assembly core must provide decodeAssemblyUtf16");
  }
  const decoder = new TextDecoder("utf-16le", { ignoreBOM: true });
  let calls = 0;

  function decode(input) {
    const codeUnits = core.decodeAssemblyUtf16(tokenIds(input));
    if (!(codeUnits instanceof Uint16Array)) {
      throw new TypeError("UTF-16 assembly output must be a Uint16Array");
    }
    calls += 1;
    return decoder.decode(codeUnits);
  }

  return Object.freeze({
    decode,
    stats: () => Object.freeze({ decoderCalls: calls, utf16Calls: calls }),
  });
}
