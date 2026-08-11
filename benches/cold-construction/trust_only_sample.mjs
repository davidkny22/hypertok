import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createResolvedVocabLoader } from "../../hypertok-js/src/resolver-provenance.mjs";
import { fromResolvedVocab } from "../../hypertok-js/src/resolver-runtime.mjs";
import { createTierRuntime } from "../../hypertok-js/src/tier-runtime.mjs";

const [runtimePath, modulePath, wasmPath, vocabularyPath, mode] = process.argv.slice(2);
if (
  !runtimePath ||
  !modulePath ||
  !wasmPath ||
  !vocabularyPath ||
  !["untrusted", "trusted", "trusted-touch", "resolver-control"].includes(mode)
) {
  throw new Error(
    "usage: trust_only_sample.mjs runtime module wasm vocabulary untrusted|trusted|trusted-touch|resolver-control",
  );
}

const runtimeModule = await import(pathToFileURL(path.resolve(runtimePath)).href);
const wasmModule = await import(pathToFileURL(path.resolve(modulePath)).href);
const moduleSource = new Uint8Array(fs.readFileSync(wasmPath));
const vocabulary = new Uint8Array(fs.readFileSync(vocabularyPath));
const handle = mode === "untrusted"
  ? undefined
  : await createResolvedVocabLoader(async () => vocabulary)("pricing-fixture");

const resolverOptions = {
  wasmModule,
  moduleSource,
  tier: "single",
  warmup: mode === "trusted-touch",
  ...(mode === "resolver-control"
    ? {
        runtimeFactory: (options) => createTierRuntime({
          ...options,
          resolverTrusted: false,
        }),
      }
    : {}),
};

const started = performance.now();
const tokenizer = mode !== "untrusted"
  ? await fromResolvedVocab(handle, resolverOptions)
  : await runtimeModule.fromBytes(vocabulary, {
      moduleSource,
      tier: "single",
    });
const constructionMilliseconds = performance.now() - started;
const constructionProfile = typeof wasmModule.WasmTokenizer.lastColdConstructionProfileJson === "function"
  ? JSON.parse(wasmModule.WasmTokenizer.lastColdConstructionProfileJson())
  : null;

try {
  const probe = "Trust-only construction: café, 漢字, 👩🏽‍💻,\n\n\uFEFF boundary.";
  const ids = tokenizer.encodeSync(probe);
  const decoded = tokenizer.decode(ids);
  if (decoded !== probe) throw new Error("trust-only construction did not round-trip");
  const outputDigest = crypto
    .createHash("sha256")
    .update(Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength))
    .digest("hex");
  process.stdout.write(`${JSON.stringify({
    constructionMilliseconds,
    outputDigest,
    tokenCount: ids.length,
    tier: tokenizer.tier,
    vocabSize: tokenizer.vocabSize,
    constructionProfile,
  })}\n`);
} finally {
  tokenizer.free();
}
