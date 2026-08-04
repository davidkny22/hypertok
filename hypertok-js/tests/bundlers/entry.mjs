import {
  browserCapabilities,
  createTierRuntime,
  selectTier,
} from "../../src/tier-runtime.mjs";

globalThis.hypertokTierHarness = Object.freeze({
  browserCapabilities,
  createTierRuntime,
  selectTier,
});
