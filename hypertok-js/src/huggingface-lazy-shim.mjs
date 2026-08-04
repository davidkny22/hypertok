import { createHuggingFaceShim } from "./huggingface-shim.mjs";

const lazyIdsState = new WeakMap();
const maximumArrayIndex = 0xffff_fffe;
const materializeAfterReads = 64;

function arrayIndex(property) {
  if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) return null;
  const index = Number(property);
  return Number.isSafeInteger(index) && index <= maximumArrayIndex ? index : null;
}

function materialize(state) {
  if (state.materialized) return;
  state.target.length = state.backing.length;
  for (let index = 0; index < state.backing.length; index += 1) {
    state.target[index] = state.backing[index];
  }
  state.backing = null;
  state.materialized = true;
}

function markDirty(state) {
  materialize(state);
  state.dirty = true;
}

function lazyU32Array(value) {
  if (!(value instanceof Uint32Array)) return Array.from(value);
  const target = [];
  const state = {
    backing: value,
    dirty: false,
    materialized: false,
    reads: 0,
    target,
  };
  const proxy = new Proxy(target, {
    get(array, property, receiver) {
      if (!state.materialized) {
        if (property === "length") return state.backing.length;
        if (property === Symbol.iterator) materialize(state);
        const index = arrayIndex(property);
        if (index !== null && index < state.backing.length) {
          const item = state.backing[index];
          state.reads += 1;
          if (state.reads >= materializeAfterReads) materialize(state);
          return item;
        }
      }
      return Reflect.get(array, property, receiver);
    },
    set(array, property, replacement, receiver) {
      markDirty(state);
      return Reflect.set(array, property, replacement, receiver);
    },
    defineProperty(array, property, descriptor) {
      markDirty(state);
      return Reflect.defineProperty(array, property, descriptor);
    },
    deleteProperty(array, property) {
      markDirty(state);
      return Reflect.deleteProperty(array, property);
    },
    has(array, property) {
      if (!state.materialized) {
        const index = arrayIndex(property);
        if (index !== null) return index < state.backing.length;
      }
      return Reflect.has(array, property);
    },
    ownKeys(array) {
      materialize(state);
      return Reflect.ownKeys(array);
    },
    getOwnPropertyDescriptor(array, property) {
      if (!state.materialized) {
        if (property === "length") {
          return { ...Reflect.getOwnPropertyDescriptor(array, property), value: state.backing.length };
        }
        const index = arrayIndex(property);
        if (index !== null && index < state.backing.length) {
          return {
            configurable: true,
            enumerable: true,
            value: state.backing[index],
            writable: true,
          };
        }
      }
      return Reflect.getOwnPropertyDescriptor(array, property);
    },
    preventExtensions(array) {
      materialize(state);
      return Reflect.preventExtensions(array);
    },
    setPrototypeOf(array, prototype) {
      markDirty(state);
      return Reflect.setPrototypeOf(array, prototype);
    },
  });
  lazyIdsState.set(proxy, state);
  return proxy;
}

function cleanLazyU32Array(value) {
  const state = lazyIdsState.get(value);
  return state !== undefined && !state.dirty;
}

function materializedValues(value) {
  const state = lazyIdsState.get(value);
  if (state === undefined) return value;
  materialize(state);
  return state.target;
}

function lazyProperty(target, name, materialize) {
  let initialized = false;
  let value;
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    get() {
      if (!initialized) {
        value = materialize();
        initialized = true;
      }
      return value;
    },
    set(replacement) {
      value = replacement;
      initialized = true;
    },
  });
}

function lazyEncoding(
  ids,
  tokenTypeIds,
  tokenString,
  returnTokenTypeIds,
  reservedFound,
  normalizeU32,
) {
  const values = cleanLazyU32Array(ids)
    ? ids
    : ids instanceof Uint32Array
      ? lazyU32Array(ids)
      : normalizeU32(ids, "post-processed ids", true);
  let tokensInitialized = false;
  let tokenValues;
  let attentionInitialized = false;
  let attentionValues;
  const result = {
    ids: values,
    get tokens() {
      if (!tokensInitialized) {
        tokenValues = materializedValues(values).map((id) => {
          const token = tokenString(id);
          if (typeof token !== "string") {
            throw new RangeError(`no token string is available for id ${id}`);
          }
          return token;
        });
        tokensInitialized = true;
      }
      return tokenValues;
    },
    set tokens(replacement) {
      tokenValues = replacement;
      tokensInitialized = true;
    },
    get attention_mask() {
      if (!attentionInitialized) {
        attentionValues = materializedValues(values).map(() => 1);
        attentionInitialized = true;
      }
      return attentionValues;
    },
    set attention_mask(replacement) {
      attentionValues = replacement;
      attentionInitialized = true;
    },
  };
  if (returnTokenTypeIds && tokenTypeIds !== undefined) {
    lazyProperty(result, "token_type_ids", () => {
      const types = normalizeU32(tokenTypeIds, "post-processed token_type_ids");
      if (types.length !== values.length) {
        throw new RangeError("post-processed token_type_ids must align with ids");
      }
      return types;
    });
  }
  if (reservedFound !== undefined) result.reservedFound = reservedFound;
  return result;
}

export function createLazyHuggingFaceShim(runtime, setup = {}, { hotStrings } = {}) {
  if (
    hotStrings !== undefined &&
    (hotStrings === null || typeof hotStrings.tokenString !== "function")
  ) {
    throw new TypeError("hotStrings must provide tokenString(id)");
  }
  const fallback = setup?.tokenString;
  const tokenString =
    hotStrings === undefined
      ? fallback
      : (id) => hotStrings.tokenString(id) ?? fallback?.(id);
  return createHuggingFaceShim(
    runtime,
    { ...setup, tokenString },
    lazyEncoding,
    { deferMasks: true, prepareInput: lazyU32Array },
  );
}
