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

const METHODS = [
  "decodeBoundaryBytes",
  "growResidentDecodeIds",
  "residentDecodeIdsCapacity",
  "residentDecodeIdsHighWater",
  "residentDecodeIdsView",
];

export function createBoundaryDecoder(core) {
  if (
    core === null ||
    typeof core !== "object" ||
    METHODS.some((method) => typeof core[method] !== "function")
  ) {
    throw new TypeError("boundary core must provide the resident decode id seam");
  }
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let capacity = core.residentDecodeIdsCapacity();
  let decoderCalls = 0;
  let growCalls = 0;
  let highWater = core.residentDecodeIdsHighWater();
  let view = null;
  let viewAcquisitions = 0;
  let viewWrites = 0;

  function decode(input) {
    const ids = tokenIds(input);
    while (capacity < ids.length) {
      view = null;
      core.growResidentDecodeIds();
      capacity *= 2;
      highWater = Math.max(highWater, capacity);
      growCalls += 1;
    }
    if (view === null || view.byteLength === 0) {
      view = core.residentDecodeIdsView();
      viewAcquisitions += 1;
    }
    if (view.length < ids.length) {
      throw new Error("resident decode id view is shorter than its reported capacity");
    }
    view.subarray(0, ids.length).set(ids);
    viewWrites += 1;
    const shrinks = highWater > 1_048_576 && ids.length < highWater / 4;
    const bytes = core.decodeBoundaryBytes(ids.length);
    if (shrinks) {
      capacity = 1_048_576;
      highWater = 1_048_576;
      view = null;
    }
    decoderCalls += 1;
    return decoder.decode(bytes);
  }

  return Object.freeze({
    decode,
    stats: () =>
      Object.freeze({
        decoderCalls,
        growCalls,
        highWaterIds: highWater,
        viewAcquisitions,
        viewWrites,
      }),
  });
}
