import { vocabularyRecord } from "./vocabulary_catalog.mjs";

const records = [
  {
    id: "@huggingface/tokenizers",
    packageName: "@huggingface/tokenizers",
    version: "0.1.3",
    browserSlug: "huggingface",
    vocabularies: ["gpt2"],
    unavailableByVocabulary: {
      o200k_base: "No official o200k tokenizer.json is published for @huggingface/tokenizers",
    },
  },
  {
    id: "kitoken",
    packageName: "kitoken",
    version: "0.11.0",
    browserSlug: "kitoken",
    vocabularies: ["gpt2"],
    unavailableByVocabulary: {
      o200k_base:
        "Kitoken 0.11.0 publishes no named o200k preset or self-contained o200k model artifact",
    },
  },
  {
    id: "gpt-tokenizer",
    packageName: "gpt-tokenizer",
    version: "3.4.0",
    browserSlug: "gpt-tokenizer",
    vocabularies: ["gpt2", "o200k_base"],
  },
  {
    id: "js-tiktoken",
    packageName: "js-tiktoken",
    version: "1.0.21",
    browserSlug: "js-tiktoken",
    vocabularies: ["gpt2", "o200k_base"],
  },
  {
    id: "@dqbd/tiktoken",
    packageName: "@dqbd/tiktoken",
    version: "1.0.21",
    browserSlug: "dqbd-tiktoken",
    vocabularies: ["gpt2", "o200k_base"],
  },
  {
    id: "@goliapkg/tiktoken-wasm",
    packageName: "@goliapkg/tiktoken-wasm",
    version: "3.5.1",
    browserSlug: "golia-tiktoken",
    vocabularies: ["gpt2", "o200k_base"],
  },
  {
    id: "@lenml/tokenizers",
    packageName: "@lenml/tokenizers",
    version: "3.7.2",
    browserSlug: "lenml",
    vocabularies: ["gpt2"],
    unavailableByVocabulary: {
      o200k_base: "No official o200k tokenizer.json is published for @lenml/tokenizers",
    },
  },
  {
    id: "hypertok",
    packageName: null,
    version: "workspace",
    browserSlug: "hypertok",
    subject: true,
    vocabularies: ["gpt2", "o200k_base"],
  },
].map((record) => Object.freeze({ availability: "available", ...record }));

const unavailable = Object.freeze({
  id: "tiktoken-wasm",
  packageName: "tiktoken-wasm",
  version: null,
  browserSlug: null,
  availability: "unavailable",
  reason: "The exact bare npm package name returned E404 on 2026-07-30",
  vocabularies: ["gpt2", "o200k_base"],
});

export const referenceRegistry = Object.freeze([...records, unavailable]);

export const availableReferences = Object.freeze(
  referenceRegistry.filter(({ availability }) => availability === "available"),
);

export const unavailableReferences = Object.freeze(
  referenceRegistry.filter(({ availability }) => availability === "unavailable"),
);

export const subjectReference = availableReferences.find(({ subject }) => subject);

if (subjectReference === undefined) {
  throw new Error("Reference registry requires one benchmark subject");
}

export function referenceRecord(id) {
  const record = referenceRegistry.find((candidate) => candidate.id === id);
  if (record === undefined) throw new Error(`Unknown benchmark reference: ${id}`);
  return record;
}

export function availableReferencesForVocabulary(vocabulary) {
  vocabularyRecord(vocabulary);
  return Object.freeze(
    availableReferences.filter(({ vocabularies }) => vocabularies.includes(vocabulary)),
  );
}

export function unavailableReferencesForVocabulary(vocabulary) {
  vocabularyRecord(vocabulary);
  return Object.freeze(
    referenceRegistry.flatMap((record) => {
      if (record.availability === "unavailable") return [record];
      if (record.vocabularies.includes(vocabulary)) return [];
      const reason = record.unavailableByVocabulary?.[vocabulary];
      if (typeof reason !== "string" || reason.length === 0) {
        throw new Error(`${record.id} lacks an unavailability reason for ${vocabulary}`);
      }
      return [Object.freeze({ ...record, availability: "unavailable", reason })];
    }),
  );
}

export function oracleReferenceForVocabulary(vocabulary) {
  const { oracleReference } = vocabularyRecord(vocabulary);
  const record = referenceRecord(oracleReference);
  if (!record.vocabularies.includes(vocabulary)) {
    throw new Error(`${record.id} is not available for ${vocabulary}`);
  }
  return record;
}
