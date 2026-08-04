import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadExecutionArtifactManifest } from "../../tests/suites/artifact_manifest.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "../..");
const FIXTURE = path.join(ROOT, "demo/incumbents/data/qwen3.6.tokenizer.json");
const CORPUS_PATH = path.join(TEST_DIR, "fixtures/oracle_corpus.json");
const artifacts = loadExecutionArtifactManifest(
  ROOT,
  process.env.HYPERTOK_ARTIFACT_MANIFEST,
);
const artifactRoot = artifacts.roots["single-source-scalar"];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function surrogateBytes(codeUnits) {
  const bytes = [];
  for (const unit of codeUnits) {
    bytes.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f));
  }
  return Uint8Array.from(bytes);
}

function inputBytes(testCase) {
  if ("text" in testCase) {
    return new TextEncoder().encode(testCase.text.repeat(testCase.repeat ?? 1));
  }
  if ("bytes" in testCase) return Uint8Array.from(testCase.bytes);
  if ("surrogate_code_units" in testCase) {
    return surrogateBytes(testCase.surrogate_code_units);
  }
  throw new Error(`case ${testCase.id} has no supported input field`);
}

function wasmResults(tokenizer, corpus) {
  return corpus.map((testCase) => {
    try {
      return {
        id: testCase.id,
        outcome: "ok",
        ids: Array.from(tokenizer.encode(inputBytes(testCase))),
      };
    } catch {
      return { id: testCase.id, outcome: "error" };
    }
  });
}

function assertParity(expected, actual) {
  assert.equal(actual.length, expected.length, "oracle result count differs");
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index].id, expected[index].id, `case order differs at ${index}`);
    assert.equal(
      actual[index].outcome,
      expected[index].outcome,
      `${expected[index].id}: accept or refuse mismatch`,
    );
    if (expected[index].outcome === "ok") {
      assert.deepEqual(actual[index].ids, expected[index].ids, `${expected[index].id}: id mismatch`);
    }
  }
}

function expectRed(label, pattern, action) {
  assert.throws(action, pattern, `${label} remained green`);
  return label;
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
const oracle = JSON.parse(
  run("python", ["hypertok-js/tests/hf_oracle.py", FIXTURE, CORPUS_PATH]),
);

const module = await import(
  `${pathToFileURL(path.join(artifactRoot, "hypertok_wasm_core.js")).href}?oracle=tracked`
);
await module.default({
  module_or_path: readFileSync(path.join(artifactRoot, "hypertok_wasm_core_bg.wasm")),
});
const { WasmTokenizer } = module;
const tokenizer = WasmTokenizer.fromHuggingFace(readFileSync(FIXTURE));
const actual = wasmResults(tokenizer, corpus);
assertParity(oracle.raw, actual);

const negativeRed = [];
negativeRed.push(
  expectRed("postprocessor-enabled-oracle", /empty: id mismatch/, () =>
    assertParity(oracle.postprocessed, actual),
  ),
);

const mutated = structuredClone(oracle.raw);
const changed = mutated.find((result) => result.outcome === "ok" && result.ids.length > 0);
assert(changed, "corpus has no non-empty successful oracle result to mutate");
changed.ids[0] ^= 1;
negativeRed.push(
  expectRed("perturbed-oracle-id", /ascii: id mismatch/, () => assertParity(mutated, actual)),
);

const accepted = oracle.raw.filter((result) => result.outcome === "ok");
const refused = oracle.raw.filter((result) => result.outcome === "error");
const utf8Bytes = corpus.reduce((sum, testCase) => sum + inputBytes(testCase).length, 0);
const tokens = accepted.reduce((sum, result) => sum + result.ids.length, 0);

console.log(
  JSON.stringify({
    status: "PASS",
    family: "qwen3.6-byte-level-bpe",
    tokenizers: oracle.tokenizers_version,
    cases: `${corpus.length}/${corpus.length}`,
    accepted: accepted.length,
    refused: refused.length,
    utf8_bytes: utf8Bytes,
    tokens,
    negative_red: `${negativeRed.length}/${negativeRed.length}`,
    negative_labels: negativeRed,
    artifact_manifest_sha256: artifacts.sha256,
  }),
);
