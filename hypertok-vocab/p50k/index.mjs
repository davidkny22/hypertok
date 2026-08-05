export const vocabulary = new URL("./vocab.htk", import.meta.url);
export const editVocabulary = new URL("./p50k-edit.htk", import.meta.url);

export const metadata = Object.freeze({
  name: "p50k_base",
  displayName: "OpenAI p50k_base",
  formatVersion: 1,
  fileSha256: "fc45b94be11649acf1d29bd2885c2d080810f8ad9f6942b9adbe8c1651e3824e",
  vocabularyDigest: "bcadd0362f60c5da3af648289cb4db934b393b62f41071bb3b82fe980299dbce",
  vocabSize: 50281,
  keySetSize: 50280,
  omega: 128,
  priorityPresent: false,
  sourceUrl: "https://openaipublic.blob.core.windows.net/encodings/p50k_base.tiktoken",
  sourceRevision: "openai/tiktoken@08a5f3b2c987ada4fc5aa1f16c643c203fa8acaa",
  sourceSha256: "94b5ca7dff4d00767bc256fdd1b27e5b17361d7b8a5f968547f9f23eb70d2069",
  license: "MIT",
});

export const editMetadata = Object.freeze({
  name: "p50k_edit",
  displayName: "OpenAI p50k_edit",
  formatVersion: 1,
  fileSha256: "ec4fc02da668992fdd11cd304a6cb1c7631e29c3d8de978c2b65a13eb5e3a2da",
  vocabularyDigest: "33ce10b7e2b8e4899e120a9590d671a19d526315ee105d6422fd2c83b99cf32b",
  vocabSize: 50284,
  keySetSize: 50280,
  omega: 128,
  priorityPresent: false,
  sourceUrl: "https://openaipublic.blob.core.windows.net/encodings/p50k_base.tiktoken",
  sourceRevision: "openai/tiktoken@08a5f3b2c987ada4fc5aa1f16c643c203fa8acaa",
  sourceSha256: "94b5ca7dff4d00767bc256fdd1b27e5b17361d7b8a5f968547f9f23eb70d2069",
  license: "MIT",
});

export default vocabulary;
