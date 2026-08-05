export const vocabulary = new URL("./vocab.htk", import.meta.url);
export const metadata = Object.freeze({
  name: "cl100k_base",
  displayName: "OpenAI cl100k_base",
  formatVersion: 1,
  fileSha256: "5fbde1cb8074b6198ea469711a33e68af2767bdf643bb694f0edf604a2831703",
  vocabularyDigest: "b55e5d835986d8694d57bd32d3d2c1971278e1b77d84135ff045f0066799d86c",
  vocabSize: 100277,
  keySetSize: 100256,
  omega: 128,
  priorityPresent: false,
  sourceUrl: "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken",
  sourceRevision: "openai/tiktoken@08a5f3b2c987ada4fc5aa1f16c643c203fa8acaa",
  sourceSha256: "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7",
  license: "MIT",
});
export default vocabulary;
