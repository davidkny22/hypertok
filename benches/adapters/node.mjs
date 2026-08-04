import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBenchmarkTokenizer } from "../common/gpt2_model.mjs";
import {
  availableReferencesForVocabulary,
  referenceRecord,
  unavailableReferencesForVocabulary,
} from "../common/reference_registry.mjs";
import { prepareVocabularyArtifact, vocabularyRecord } from "../common/vocabularies.mjs";
import { fromBytes } from "../../hypertok-js/src/index.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function nodeReferenceIds(vocabulary = "gpt2") {
  return Object.freeze(availableReferencesForVocabulary(vocabulary).map(({ id }) => id));
}

export function unavailableReferences(vocabulary = "gpt2") {
  return unavailableReferencesForVocabulary(vocabulary);
}

function adapter(id, version, vocabulary, encode, decode, dispose = () => {}) {
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  return Object.freeze({
    id,
    version,
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

export async function createNodeAdapters(vocabulary = "gpt2") {
  const adapters = [];
  for (const id of nodeReferenceIds(vocabulary)) {
    adapters.push(await createNodeAdapter(id, vocabulary));
  }
  return Object.freeze(adapters);
}

export async function createNodeAdapter(id, vocabulary = "gpt2") {
  vocabularyRecord(vocabulary);
  const available = availableReferencesForVocabulary(vocabulary).some(
    (record) => record.id === id,
  );
  if (!available) throw new Error(`${id} is unavailable for ${vocabulary}`);
  switch (id) {
    case "@huggingface/tokenizers": {
      const tokenizerBytes = readBenchmarkTokenizer();
      const tokenizerJson = JSON.parse(tokenizerBytes.toString("utf8"));
      const { Tokenizer } = await import("@huggingface/tokenizers");
      const tokenizer = new Tokenizer(tokenizerJson, {});
      return adapter(
        id,
        referenceRecord(id).version,
        vocabulary,
        (text) => tokenizer.encode(text).ids,
        (ids) => tokenizer.decode(Array.from(ids), {
          skip_special_tokens: false,
          clean_up_tokenization_spaces: false,
        }),
      );
    }
    case "kitoken": {
      const tokenizerBytes = readBenchmarkTokenizer();
      const { Kitoken } = await import("kitoken/node");
      const tokenizer = Kitoken.from_tokenizers(tokenizerBytes);
      return adapter(
        id,
        referenceRecord(id).version,
        vocabulary,
        (text) => tokenizer.encode(text, false),
        (ids) => tokenizer.decode(ids, false),
      );
    }
    case "gpt-tokenizer": {
      const tokenizer = await import(
        vocabulary === "gpt2"
          ? "gpt-tokenizer/encoding/r50k_base"
          : "gpt-tokenizer/encoding/o200k_base"
      );
      return adapter(
        id,
        referenceRecord(id).version,
        vocabulary,
        tokenizer.encode,
        tokenizer.decode,
      );
    }
    case "js-tiktoken": {
      const [{ Tiktoken }, { default: gpt2Ranks }] = await Promise.all([
        import("js-tiktoken"),
        import(
          vocabulary === "gpt2"
            ? "js-tiktoken/ranks/gpt2"
            : "js-tiktoken/ranks/o200k_base"
        ),
      ]);
      const tokenizer = new Tiktoken(gpt2Ranks);
      return adapter(
        id,
        referenceRecord(id).version,
        vocabulary,
        (text) => tokenizer.encode(text),
        (ids) => tokenizer.decode(ids),
      );
    }
    case "@dqbd/tiktoken": {
      const { get_encoding: getEncoding } = await import("@dqbd/tiktoken");
      const tokenizer = getEncoding(vocabulary === "gpt2" ? "gpt2" : "o200k_base");
      return adapter(
        id,
        referenceRecord(id).version,
        vocabulary,
        (text) => tokenizer.encode(text),
        (ids) => tokenizer.decode(ids),
        () => tokenizer.free(),
      );
    }
    case "@goliapkg/tiktoken-wasm": {
      const tokenizerModule = await import("@goliapkg/tiktoken-wasm");
      const wasm = fs.readFileSync(
        path.join(
          benchesDirectory,
          "node_modules",
          "@goliapkg",
          "tiktoken-wasm",
          "tiktoken_wasm_bg.wasm",
        ),
      );
      tokenizerModule.initSync({ module: wasm });
      const tokenizer = tokenizerModule.getEncoding(
        vocabulary === "gpt2" ? "r50k_base" : "o200k_base",
      );
      return adapter(
        id,
        referenceRecord(id).version,
        vocabulary,
        (text) => tokenizer.encode(text),
        (ids) => tokenizer.decode(ids),
        () => tokenizer.free(),
      );
    }
    case "@lenml/tokenizers": {
      const tokenizerModule = await import("@lenml/tokenizer-gpt2");
      const tokenizer = await tokenizerModule.fromPreTrained();
      return adapter(
        id,
        referenceRecord(id).version,
        vocabulary,
        (text) => tokenizer.encode(text),
        (ids) => tokenizer.decode(Array.from(ids), {
          skip_special_tokens: false,
          clean_up_tokenization_spaces: false,
        }),
      );
    }
    case "hypertok": {
      const tokenizer = await fromBytes(prepareVocabularyArtifact(vocabulary).bytes, {
        tier: "single",
      });
      return adapter(
        id,
        "workspace",
        vocabulary,
        (text) => tokenizer.encodeSync(text),
        (ids) => tokenizer.decode(ids),
        () => tokenizer.free(),
      );
    }
    default:
      throw new Error(`Unknown Node reference: ${id}`);
  }
}

export function disposeAdapters(adapters) {
  const errors = [];
  for (const current of adapters) {
    try {
      current.dispose();
    } catch (error) {
      errors.push(new Error(`Failed to dispose ${current.id}`, { cause: error }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Reference adapter cleanup failed");
  }
}
