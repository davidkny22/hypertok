import wasmSource from "../wasm/single/hypertok_wasm_core_bg.wasm?module";
import { fromBytes as fromDefaultBytes } from "./index.mjs";

export function fromBytes(input, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return fromDefaultBytes(input, options);
  }
  return fromDefaultBytes(
    input,
    options.moduleSource == null ? { ...options, moduleSource: wasmSource } : options,
  );
}
