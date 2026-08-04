import { resolveShimRuntime } from "./shim-runtime.mjs";

function singleRuntime(runtime) {
  runtime = resolveShimRuntime(runtime);
  if (
    runtime?.tier !== "single" ||
    typeof runtime.encodeReservedSync !== "function" ||
    typeof runtime.tokenBytes !== "function" ||
    typeof runtime.decodeBytes !== "function"
  ) {
    throw new TypeError("the tiktoken shim requires a resident single-tier runtime");
  }
  return runtime;
}

function selectedNames(value, defaultAll, known, field) {
  if (value === undefined) return defaultAll ? [...known] : [];
  if (value === "all") return [...known];
  if (Array.isArray(value) && value.every((name) => typeof name === "string")) {
    return [...new Set(value)].filter((name) => known.has(name));
  }
  throw new TypeError(`${field} must be "all" or an array of reserved-token names`);
}

function tiktokenPolicy(allowedValue, disallowedValue, known) {
  const allowedAll = allowedValue === "all";
  const allowed = selectedNames(allowedValue, false, known, "allowed_special");
  if (allowedAll) return { match: "all", refuse: [] };
  const allowedSet = new Set(allowed);
  const disallowed = selectedNames(disallowedValue, true, known, "disallowed_special").filter(
    (name) => !allowedSet.has(name),
  );
  return { match: allowed, refuse: disallowed };
}

export function createTiktokenShim(runtime, { name } = {}) {
  const core = singleRuntime(runtime);
  const known = new Set(core.reservedTokens());
  return Object.freeze({
    name,
    encode(text, allowedSpecial, disallowedSpecial) {
      return core.encodeReservedSync(
        text,
        tiktokenPolicy(allowedSpecial, disallowedSpecial, known),
      ).ids;
    },
    encode_ordinary(text) {
      return core.encodeReservedSync(text, { match: [], refuse: [] }).ids;
    },
    encodeReserved(text, policy) {
      return core.encodeReservedSync(text, policy);
    },
    decode(ids) {
      return core.decodeBytes(ids);
    },
    free() {
      void core.close();
    },
  });
}
