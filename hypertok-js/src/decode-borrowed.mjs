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

export function createBorrowedAssemblyDecoder(core) {
  if (
    core === null ||
    typeof core !== "object" ||
    typeof core.decodeBorrowedAssemblyView !== "function"
  ) {
    throw new TypeError("borrowed assembly core must provide decodeBorrowedAssemblyView");
  }
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let calls = 0;

  function decode(input) {
    const view = core.decodeBorrowedAssemblyView(tokenIds(input));
    if (!(view instanceof Uint8Array)) {
      throw new TypeError("borrowed assembly output must be a Uint8Array");
    }
    calls += 1;
    return decoder.decode(view);
  }

  return Object.freeze({
    decode,
    stats: () => Object.freeze({ decoderCalls: calls, borrowedViewCalls: calls }),
  });
}
