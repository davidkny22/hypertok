const runtimes = new WeakMap();

export function registerShimRuntime(handle, runtime) {
  if (
    (typeof handle !== "object" && typeof handle !== "function") ||
    handle === null ||
    (typeof runtime !== "object" && typeof runtime !== "function") ||
    runtime === null
  ) {
    throw new TypeError("shim runtime registration requires object handles");
  }
  runtimes.set(handle, runtime);
  return handle;
}

export function resolveShimRuntime(handle) {
  return runtimes.get(handle) ?? handle;
}
