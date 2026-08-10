function nextCapacity(length) {
  let capacity = 1;
  while (capacity < length) capacity *= 2;
  return capacity;
}

export function createValidatedIdScratch(validate) {
  if (typeof validate !== "function") {
    throw new TypeError("validated ID scratch requires a validation function");
  }
  let storage = new Uint32Array(0);
  let active = false;
  let preparations = 0;
  let grows = 0;
  let reentrantAllocations = 0;

  function withValidated(input, use) {
    if (!Array.isArray(input)) {
      throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
    }
    if (typeof use !== "function") {
      throw new TypeError("validated ID scratch requires a synchronous consumer");
    }
    const reusable = !active;
    let target;
    if (reusable) {
      active = true;
      if (storage.length < input.length) {
        storage = new Uint32Array(nextCapacity(input.length));
        grows += 1;
      }
      target = storage;
    } else {
      target = new Uint32Array(input.length);
      reentrantAllocations += 1;
    }
    try {
      for (let index = 0; index < input.length; index += 1) {
        const id = input[index];
        if (!validate(id)) {
          throw new TypeError("decode input must be a Uint32Array or an array of u32 values");
        }
        target[index] = id;
      }
      preparations += 1;
      return use(target.subarray(0, input.length));
    } finally {
      if (reusable) active = false;
    }
  }

  return Object.freeze({
    withValidated,
    stats: () => Object.freeze({
      capacity: storage.length,
      preparations,
      grows,
      reentrantAllocations,
    }),
  });
}
