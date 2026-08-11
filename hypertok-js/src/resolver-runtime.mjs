import { resolverOwnedBytes } from "./resolver-provenance.mjs";

export async function fromResolvedVocab(handle, {
  wasmModule,
  moduleSource,
} = {}) {
  if (wasmModule === null || typeof wasmModule !== "object") {
    throw new TypeError("a pricing wasm module is required");
  }
  const bytes = resolverOwnedBytes(handle);
  await wasmModule.default(
    moduleSource === undefined ? undefined : { module_or_path: moduleSource },
  );
  if (typeof wasmModule.WasmTokenizer?.fromResolverTrustedHtk !== "function") {
    throw new Error("the wasm module has no resolver-provenance constructor");
  }
  return wasmModule.WasmTokenizer.fromResolverTrustedHtk(bytes);
}
