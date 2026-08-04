const records = [
  {
    id: "gpt2",
    name: "GPT-2 ByteLevel BPE",
    browserAsset: "gpt2.htk",
    oracleReference: "@huggingface/tokenizers",
    htkSha256: "17e4cc7df1f4d95b80c43df52ecc31f9e5931a319e9964cffbf9dc4ed88c9da2",
    source: Object.freeze({
      package: "@lenml/tokenizer-gpt2",
      version: "3.7.2",
      sha256: "cda20b8ca044949aa07ac4078420c80d1a57139d5f9f33700e46fb2d891e7c66",
    }),
  },
  {
    id: "o200k_base",
    name: "o200k_base",
    browserAsset: "o200k.htk",
    oracleReference: "@dqbd/tiktoken",
    htkSha256: "a583ea153eee0f3547df36f1ad2f38e3d1e92c16942f4ddbafa4b7a9979cb111",
    source: Object.freeze({
      package: "@hypertok/vocab-o200k",
      version: "1.0.0",
      artifact: "vocab.htk",
      sha256: "a583ea153eee0f3547df36f1ad2f38e3d1e92c16942f4ddbafa4b7a9979cb111",
    }),
  },
].map(Object.freeze);

export const vocabularyRegistry = Object.freeze(records);
export const vocabularyIds = Object.freeze(records.map(({ id }) => id));

export function vocabularyRecord(id) {
  const record = vocabularyRegistry.find((candidate) => candidate.id === id);
  if (record === undefined) throw new Error(`Unknown benchmark vocabulary: ${id}`);
  return record;
}

export function vocabularyIdentity() {
  return Object.freeze(
    vocabularyRegistry.map(({ id, name, oracleReference, htkSha256, source }) =>
      Object.freeze({ id, name, oracleReference, htkSha256, source }),
    ),
  );
}
