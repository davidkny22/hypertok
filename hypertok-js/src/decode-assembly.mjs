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

export function createAssemblyDecoder(core) {
  if (
    core === null ||
    typeof core !== "object" ||
    typeof core.decodeAssemblyBytes !== "function"
  ) {
    throw new TypeError("assembly core must provide decodeAssemblyBytes");
  }
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let calls = 0;

  function decode(input) {
    const bytes = core.decodeAssemblyBytes(tokenIds(input));
    calls += 1;
    return decoder.decode(bytes);
  }

  return Object.freeze({
    decode,
    stats: () => Object.freeze({ decoderCalls: calls }),
  });
}
