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
  constructionObserver,
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
    constructionObserver,
  });
  if (constructionObserver === undefined) return createPublicRuntime(runtime, bytes);
  const started = performance.now();
  const publicRuntime = createPublicRuntime(runtime, bytes);
  constructionObserver(Object.freeze({
    name: "public-handle-construction",
    milliseconds: performance.now() - started,
  }));
  return publicRuntime;
}
