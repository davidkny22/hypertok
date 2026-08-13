import { resolveShimRuntime } from "./shim-runtime.mjs";

function singleRuntime(runtime) {
  runtime = resolveShimRuntime(runtime);
  if (runtime?.tier !== "single" || typeof runtime.encodeReservedSync !== "function") {
    throw new TypeError("the Hugging Face shim requires a resident single-tier runtime");
  }
  return runtime;
}

function u32Array(value, field, retainArray = false) {
  if (!(value instanceof Uint32Array) && !Array.isArray(value)) {
    throw new TypeError(`${field} must be a Uint32Array or array of u32 values`);
  }
  const values = retainArray && Array.isArray(value) ? value : Array.from(value);
  if (
    !values.every(
      (item) => Number.isInteger(item) && item >= 0 && item <= 0xffff_ffff,
    )
  ) {
    throw new TypeError(`${field} must contain only u32 values`);
  }
  return values;
}

function eagerEncoding(
  ids,
  tokenTypeIds,
  tokenString,
  returnTokenTypeIds,
  reservedFound,
  normalizeU32,
) {
  const values = normalizeU32(ids, "post-processed ids");
  const result = {
    ids: values,
    tokens: values.map((id) => {
      const token = tokenString(id);
      if (typeof token !== "string") {
        throw new RangeError(`no token string is available for id ${id}`);
      }
      return token;
    }),
    attention_mask: values.map(() => 1),
  };
  if (returnTokenTypeIds && tokenTypeIds !== undefined) {
    const types = normalizeU32(tokenTypeIds, "post-processed token_type_ids");
    if (types.length !== values.length) {
      throw new RangeError("post-processed token_type_ids must align with ids");
    }
    result.token_type_ids = types;
  }
  if (reservedFound !== undefined) result.reservedFound = reservedFound;
  return result;
}

function encodeOptions(options = {}) {
  const {
    text_pair = null,
    add_special_tokens = true,
    return_token_type_ids = null,
  } = options;
  return { text_pair, add_special_tokens, return_token_type_ids };
}

function processIds(
  postProcess,
  first,
  second,
  addSpecialTokens,
  returnTokenTypeIds,
  deferMasks,
  prepareInput,
) {
  const args = [
    prepareInput(first),
    second === null ? null : prepareInput(second),
    addSpecialTokens,
  ];
  if (deferMasks) args.push(returnTokenTypeIds);
  const processed = postProcess(...args);
  if (processed === null || typeof processed !== "object" || Array.isArray(processed)) {
    throw new TypeError("postProcess must return an object");
  }
  return {
    ids: processed.ids,
    tokenTypeIds: processed.token_type_ids,
  };
}

function cleanUpTokenization(text) {
  return text
    .replace(/ \./g, ".")
    .replace(/ \?/g, "?")
    .replace(/ \!/g, "!")
    .replace(/ ,/g, ",")
    .replace(/ \' /g, "'")
    .replace(/ n't/g, "n't")
    .replace(/ 'm/g, "'m")
    .replace(/ 's/g, "'s")
    .replace(/ 've/g, "'ve")
    .replace(/ 're/g, "'re");
}

function uniqueFound(first, second) {
  return [...new Set([...first, ...second])];
}

export function createHuggingFaceShim(
  runtime,
  {
    tokenString,
    postProcess,
    specialTokens = [],
    unknownTokenId,
    cleanUpTokenizationSpaces = true,
  } = {},
  createEncoding = eagerEncoding,
  { deferMasks = false, prepareInput = Array.from } = {},
) {
  const core = singleRuntime(runtime);
  if (typeof tokenString !== "function") {
    throw new TypeError("the Hugging Face shim requires a tokenString(id) resolver");
  }
  if (typeof postProcess !== "function") {
    throw new TypeError("the Hugging Face shim requires a postProcess function");
  }
  if (!Array.isArray(specialTokens) || !specialTokens.every((token) => typeof token === "string")) {
    throw new TypeError("specialTokens must be an array of token strings");
  }
  if (!Number.isInteger(unknownTokenId) || unknownTokenId < 0 || unknownTokenId > 0xffff_ffff) {
    throw new TypeError("unknownTokenId must be a u32 value");
  }
  if (typeof cleanUpTokenizationSpaces !== "boolean") {
    throw new TypeError("cleanUpTokenizationSpaces must be a boolean");
  }
  if (typeof createEncoding !== "function") {
    throw new TypeError("the Hugging Face shim requires an Encoding factory");
  }
  if (typeof deferMasks !== "boolean") {
    throw new TypeError("deferMasks must be a boolean");
  }
  if (typeof prepareInput !== "function") {
    throw new TypeError("the Hugging Face shim requires an input array factory");
  }
  const special = new Set(specialTokens);

  const encodeWith = (text, options, policy, detailed) => {
    const normalized = encodeOptions(options);
    const first = core.encodeReservedSync(text, policy);
    const pairText = normalized.text_pair ?? null;
    const second = pairText === null ? null : core.encodeReservedSync(pairText, policy);
    const processed = processIds(
      postProcess,
      first.ids,
      second?.ids ?? null,
      normalized.add_special_tokens,
      normalized.return_token_type_ids === true,
      deferMasks,
      prepareInput,
    );
    return createEncoding(
      processed.ids,
      processed.tokenTypeIds,
      tokenString,
      normalized.return_token_type_ids,
      detailed
        ? uniqueFound(first.reservedFound, second?.reservedFound ?? [])
        : undefined,
      u32Array,
    );
  };

  return Object.freeze({
    encode(text, options) {
      return encodeWith(text, options, undefined, false);
    },
    encodeReserved(text, policy, options) {
      return encodeWith(text, options, policy, true);
    },
    decode(ids, options = {}) {
      const validId = (id) =>
        (typeof id === "bigint" && id >= 0n && id <= 0xffff_ffffn) ||
        (typeof id === "number" &&
          Number.isInteger(id) &&
          id >= 0 &&
          id <= 0xffff_ffff);
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        !ids.every(validId)
      ) {
        throw new Error("token_ids must be a non-empty array of integers.");
      }
      let decodedIds = ids.map((id) => {
        const numeric = Number(id);
        return typeof tokenString(numeric) === "string" ? numeric : unknownTokenId;
      });
      if (options.skip_special_tokens) {
        decodedIds = decodedIds.filter((id) => !special.has(tokenString(id)));
      }
      let decoded = decodedIds.length === 0 ? "" : core.decode(decodedIds);
      if (options.clean_up_tokenization_spaces ?? cleanUpTokenizationSpaces) {
        decoded = cleanUpTokenization(decoded);
      }
      return decoded;
    },
    free() {
      void core.close();
    },
  });
}
