import { Tokenizer } from "@huggingface/tokenizers";
import {
  decode as gpt2Decode,
  encode as gpt2Encode,
} from "gpt-tokenizer/encoding/r50k_base";
import {
  decode as o200kDecode,
  encode as o200kEncode,
} from "gpt-tokenizer/encoding/o200k_base";
import { Tiktoken as JsTiktoken } from "js-tiktoken";
import gpt2Ranks from "js-tiktoken/ranks/gpt2";
import o200kRanks from "js-tiktoken/ranks/o200k_base";
import * as dqbd from "@dqbd/tiktoken/lite/init";
import dqbdGpt2 from "@dqbd/tiktoken/encoders/gpt2";
import dqbdO200k from "@dqbd/tiktoken/encoders/o200k_base";
import goliaInit, {
  getEncoding as getGoliaEncoding,
} from "@goliapkg/tiktoken-wasm";
import { fromPreTrained } from "@lenml/tokenizer-gpt2";
import * as kitokenGlue from "../node_modules/kitoken/dist/full_bg.js";
import { runHarnessSelfCheck } from "../common/harness_self_check.mjs";
import { measureDecodeRoutes } from "../common/decode_route_pricing.mjs";
import { fromBytes } from "../../hypertok-js/src/index.mjs";
import { resolveShimRuntime } from "../../hypertok-js/src/shim-runtime.mjs";
import {
  availableReferencesForVocabulary,
  oracleReferenceForVocabulary,
  referenceRecord,
  unavailableReferencesForVocabulary,
} from "../common/reference_registry.mjs";
import { vocabularyRegistry } from "../common/vocabulary_catalog.mjs";

function asAdapter(id, vocabulary, encode, decode, dispose = () => {}) {
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  return Object.freeze({
    id,
    version: referenceRecord(id).version,
    vocabulary,
    tier: "single",
    simdLevel: "scalar",
    encode(text) {
      return encode(text);
    },
    decode(ids) {
      const output = decode(ids);
      return typeof output === "string" ? output : textDecoder.decode(output);
    },
    dispose,
  });
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function firstMismatch(expected, actual) {
  const limit = Math.min(expected.length, actual.length);
  for (let index = 0; index < limit; index += 1) {
    if (expected[index] !== actual[index]) {
      return { index, expected: expected[index], actual: actual[index] };
    }
  }
  return expected.length === actual.length
    ? null
    : { index: limit, expected: expected[limit] ?? null, actual: actual[limit] ?? null };
}

async function tokenDigest(ids) {
  const bytes = new Uint8Array(ids.length * 4);
  const view = new DataView(bytes.buffer);
  ids.forEach((id, index) => view.setUint32(index * 4, id, true));
  return sha256Hex(bytes);
}

async function createBrowserAdapters(vocabulary = "gpt2") {
  const supportedIds = new Set(
    availableReferencesForVocabulary(vocabulary).map(({ id }) => id),
  );
  const adapters = [];
  let tokenizerBytes;

  if (supportedIds.has("@huggingface/tokenizers") || supportedIds.has("kitoken")) {
    tokenizerBytes = await fetchBytes("/assets/tokenizer.json");
  }
  if (supportedIds.has("@huggingface/tokenizers")) {
    const tokenizerJson = JSON.parse(new TextDecoder().decode(tokenizerBytes));
    const huggingFace = new Tokenizer(tokenizerJson, {});
    adapters.push(asAdapter(
      "@huggingface/tokenizers",
      vocabulary,
      (text) => huggingFace.encode(text).ids,
      (ids) => huggingFace.decode(Array.from(ids), {
        skip_special_tokens: false,
        clean_up_tokenization_spaces: false,
      }),
    ));
  }

  if (supportedIds.has("kitoken")) {
    const kitokenResult = await WebAssembly.instantiate(
      await fetchBytes("/assets/kitoken-full.wasm"),
      { "./full_bg.js": kitokenGlue },
    );
    kitokenGlue.__wbg_set_wasm(kitokenResult.instance.exports);
    const kitoken = kitokenGlue.Kitoken.from_tokenizers(tokenizerBytes);
    adapters.push(asAdapter(
      "kitoken",
      vocabulary,
      (text) => kitoken.encode(text, false),
      (ids) => kitoken.decode(ids, false),
      () => kitoken.free(),
    ));
  }

  if (supportedIds.has("gpt-tokenizer")) {
    adapters.push(asAdapter(
      "gpt-tokenizer",
      vocabulary,
      vocabulary === "gpt2" ? gpt2Encode : o200kEncode,
      vocabulary === "gpt2" ? gpt2Decode : o200kDecode,
    ));
  }

  if (supportedIds.has("js-tiktoken")) {
    const jsTiktoken = new JsTiktoken(vocabulary === "gpt2" ? gpt2Ranks : o200kRanks);
    adapters.push(asAdapter(
      "js-tiktoken",
      vocabulary,
      (text) => jsTiktoken.encode(text),
      (ids) => jsTiktoken.decode(ids),
    ));
  }

  if (supportedIds.has("@dqbd/tiktoken")) {
    const dqbdWasm = await fetchBytes("/assets/dqbd-lite.wasm");
    await dqbd.init((imports) => WebAssembly.instantiate(dqbdWasm, imports));
    const encoding = vocabulary === "gpt2" ? dqbdGpt2 : dqbdO200k;
    const dqbdTokenizer = new dqbd.Tiktoken(
      encoding.bpe_ranks,
      encoding.special_tokens,
      encoding.pat_str,
    );
    adapters.push(asAdapter(
      "@dqbd/tiktoken",
      vocabulary,
      (text) => dqbdTokenizer.encode(text),
      (ids) => dqbdTokenizer.decode(ids),
      () => dqbdTokenizer.free(),
    ));
  }

  if (supportedIds.has("@goliapkg/tiktoken-wasm")) {
    await goliaInit({ module_or_path: "/assets/golia.wasm" });
    const goliaTokenizer = getGoliaEncoding(
      vocabulary === "gpt2" ? "r50k_base" : "o200k_base",
    );
    adapters.push(asAdapter(
      "@goliapkg/tiktoken-wasm",
      vocabulary,
      (text) => goliaTokenizer.encode(text),
      (ids) => goliaTokenizer.decode(ids),
      () => goliaTokenizer.free(),
    ));
  }

  if (supportedIds.has("@lenml/tokenizers")) {
    const lenml = await fromPreTrained();
    adapters.push(asAdapter(
      "@lenml/tokenizers",
      vocabulary,
      (text) => lenml.encode(text),
      (ids) => lenml.decode(Array.from(ids), {
        skip_special_tokens: false,
        clean_up_tokenization_spaces: false,
      }),
    ));
  }

  if (supportedIds.has("hypertok")) {
    const asset = vocabulary === "gpt2" ? "gpt2.htk" : "o200k.htk";
    const hypertok = await fromBytes(await fetchBytes(`/assets/${asset}`), { tier: "single" });
    adapters.push(asAdapter(
      "hypertok",
      vocabulary,
      (text) => hypertok.encodeSync(text),
      (ids) => hypertok.decode(ids),
      () => hypertok.free(),
    ));
  }

  return adapters;
}

async function loadWorkloads() {
  const response = await fetch("/corpus/manifest.json");
  if (!response.ok) throw new Error(`manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  const workloads = [];
  for (const entry of manifest.workloads.filter(
    ({ role }) => role === "arena" || role === "arena-large",
  )) {
    const bytes = await fetchBytes(`/corpus/${entry.path}`);
    if (bytes.length !== entry.bytes) throw new Error(`${entry.id}: byte count mismatch`);
    if ((await sha256Hex(bytes)) !== entry.sha256) throw new Error(`${entry.id}: digest mismatch`);
    workloads.push({ ...entry, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
  }
  return workloads;
}

export async function runAgreement() {
  const workloads = await loadWorkloads();
  const rows = [];
  const mutations = [];
  for (const { id: vocabulary } of vocabularyRegistry) {
    const adapters = await createBrowserAdapters(vocabulary);
    const oracleId = oracleReferenceForVocabulary(vocabulary).id;
    const oracle = adapters.find(({ id }) => id === oracleId);
    try {
      for (const workload of workloads) {
        const oracleIds = oracle.encode(workload.text);
        for (const current of adapters) {
          const ids = current === oracle ? oracleIds : current.encode(workload.text);
          const mismatch = firstMismatch(oracleIds, ids);
          rows.push({
            vocabulary,
            workload: workload.id,
            workloadBytes: workload.bytes,
            reference: current.id,
            referenceVersion: current.version,
            status: mismatch === null ? "identical" : "different",
            tokenCount: ids.length,
            tokenSha256: await tokenDigest(ids),
            mismatch,
            tier: current.tier,
            simdLevel: current.simdLevel,
          });
        }
        for (const current of unavailableReferencesForVocabulary(vocabulary)) {
          rows.push({
            vocabulary,
            workload: workload.id,
            workloadBytes: workload.bytes,
            reference: current.id,
            referenceVersion: current.version,
            status: "unavailable",
            reason: current.reason,
          });
        }
      }

      const oracleIds = oracle.encode(workloads[0].text);
      const mutatedIds = Uint32Array.from(oracleIds);
      mutatedIds[0] ^= 1;
      const mutationMismatch = firstMismatch(oracleIds, mutatedIds);
      mutations.push({
        vocabulary,
        name: "perturb-first-token-id",
        observed: mutationMismatch === null ? "GREEN" : "RED",
        mismatch: mutationMismatch,
      });
    } finally {
      for (const current of adapters) current.dispose();
    }
  }
  return { rows, mutations };
}

export async function probeAdapters() {
  const rows = [];
  const text = "Hello, tokenizer! 中文 😀\n";
  for (const { id: vocabulary } of vocabularyRegistry) {
    const adapters = await createBrowserAdapters(vocabulary);
    const oracleId = oracleReferenceForVocabulary(vocabulary).id;
    const oracle = adapters.find(({ id }) => id === oracleId);
    try {
      const oracleIds = oracle.encode(text);
      rows.push(...adapters.map((current) => ({
        vocabulary,
        reference: current.id,
        status: firstMismatch(oracleIds, current.encode(text)) === null ? "identical" : "different",
        decodeExact: current.decode(current.encode(text)) === text,
      })));
    } finally {
      for (const current of adapters) current.dispose();
    }
  }
  return { crossOriginIsolated, rows };
}

export async function runDecodeRoutePricing({
  candidateMode = "byte",
  containerRegime = "repeated",
  n = 21,
  warmup = 2,
} = {}) {
  const [bytes, workloads] = await Promise.all([
    fetchBytes("/assets/gpt2.htk"),
    loadWorkloads(),
  ]);
  const baseline = await fromBytes(bytes, {
    tier: "single",
    optimizations:
      candidateMode === "fused"
        ? { decodeFusedValidation: "off" }
        : candidateMode === "lean"
          ? { decodeLeanDispatch: "off" }
          : candidateMode === "memo"
            ? { decodeMemo: "off" }
            : candidateMode === "run-cache"
              ? { decodeMemo: "off", decodeRunCache: "off" }
              : candidateMode === "latin1-native"
                ? { decodeMemo: "off", decodeLatin1Native: "off" }
                : candidateMode === "latin1-portable"
                  ? { decodeMemo: "off", decodeLatin1Portable: "off" }
          : { decodeMixedRuns: "off" },
  });
  const candidate = await fromBytes(bytes, {
    tier: "single",
    optimizations:
      candidateMode === "mixed"
        ? { decodeMixedRuns: "on" }
        : candidateMode === "fused"
          ? { decodeFusedValidation: "auto" }
        : candidateMode === "lean"
          ? { decodeLeanDispatch: "on" }
          : candidateMode === "memo"
            ? { decodeMemo: "auto" }
            : candidateMode === "run-cache"
              ? { decodeMemo: "off", decodeRunCache: "on" }
              : candidateMode === "latin1-native"
                ? { decodeMemo: "off", decodeLatin1Native: "on" }
                : candidateMode === "latin1-portable"
                  ? { decodeMemo: "off", decodeLatin1Portable: "on" }
          : { decodeByteTable: "on" },
  });
  try {
    return measureDecodeRoutes({
      baseline,
      candidate,
      workloads,
      candidateMode,
      containerRegime,
      n,
      warmup,
      baselineStats: () => resolveShimRuntime(baseline).decodeStats(),
      candidateStats: () => resolveShimRuntime(candidate).decodeStats(),
    });
  } finally {
    baseline.free();
    candidate.free();
  }
}

export { runHarnessSelfCheck };
