import { resolverOwnedBytes } from "./resolver-provenance.mjs";
import { createPublicRuntime } from "./public-runtime.mjs";
import { createTierRuntime } from "./tier-runtime.mjs";

export async function fromResolvedVocab(handle, {
  wasmModule,
  moduleSource,
  tier = "single",
  workerCount,
  optimizations,
  warmup = false,
  runtimeFactory = createTierRuntime,
} = {}) {
  if (wasmModule === null || typeof wasmModule !== "object") {
    throw new TypeError("a pricing wasm module is required");
  }
  const bytes = resolverOwnedBytes(handle);
  const runtime = await runtimeFactory({
    unthreadedModule: wasmModule,
    unthreadedModuleSource: moduleSource,
    vocabulary: bytes,
    format: "htk",
    tier,
    workerCount,
    optimizations,
    resolverTrusted: true,
    resolverWarmup: warmup,
  });
  return createPublicRuntime(runtime, bytes);
}
