import {
  browserCapabilities,
  createTierRuntime as createBaseRuntime,
  selectTier,
} from "../../src/tier-runtime.mjs";

const fault = __HYPERTOK_TEST_FAULT__;
const startupFaults = new Set(["transfer-corrupt", "source-digest", "source-rebuild"]);

function changedIds(ids) {
  const changed = ids.slice();
  if (changed.length !== 0) changed[0] ^= 1;
  return changed;
}

function bind(value, target) {
  return typeof value === "function" ? value.bind(target) : value;
}

function wrapRuntime(runtime) {
  return new Proxy({}, {
    get(_target, property) {
      if (property === "switchTier") {
        return async (...arguments_) => wrapRuntime(await runtime.switchTier(...arguments_));
      }
      if ((fault === "reorder" || fault === "corrupt") && property === "encode") {
        return async (...arguments_) => changedIds(await runtime.encode(...arguments_));
      }
      if ((fault === "reorder" || fault === "corrupt") && property === "encodeSync") {
        return (...arguments_) => changedIds(runtime.encodeSync(...arguments_));
      }
      if (fault === "decode-drop" && property === "decode") {
        return (...arguments_) => runtime.decode(...arguments_).slice(1);
      }
      if (property === "lifecycle" && (fault === "pool-reload" || fault === "resident-replace")) {
        return () => {
          const lifecycle = { ...runtime.lifecycle() };
          if (fault === "pool-reload") lifecycle.workerPoolInitializations += 1;
          if (fault === "resident-replace") lifecycle.residentSingleIdentity += 1;
          return lifecycle;
        };
      }
      return bind(Reflect.get(runtime, property, runtime), runtime);
    },
    has(_target, property) {
      return property in runtime;
    },
  });
}

async function createTierRuntime(options) {
  if (startupFaults.has(fault)) {
    throw new Error(`injected ${fault} startup fault`);
  }
  return wrapRuntime(await createBaseRuntime(options));
}

globalThis.hypertokTierHarness = Object.freeze({
  browserCapabilities,
  createTierRuntime,
  selectTier,
});
