const VOCAB_FILE_SHA256 = Object.freeze({
  "cl100k": Object.freeze({
    "vocab.htk": "5fbde1cb8074b6198ea469711a33e68af2767bdf643bb694f0edf604a2831703",
  }),
  "command-a-plus": Object.freeze({
    "vocab.htk": "45fbdf64ea065e53e663ddf0c2ee1921bb03c382913ea33e06a3b80d0c1be3f7",
  }),
  "deepseek-v4": Object.freeze({
    "vocab.htk": "33d3a40a01a6df36bbf98f2be967eef442e7fff0b6ffe766c2b7f987134a06f3",
  }),
  "gemma4": Object.freeze({
    "vocab.htk": "ca4760bc8f7cf29793680e507ed154a3dfa02cb637e6cc87ec5fa5ececa05205",
  }),
  "glm5-2": Object.freeze({
    "vocab.htk": "3f381aca611a9d665d43c5b3d72411f02bb909dc665f0ca8ead6a8940c54a9d0",
  }),
  "gpt2": Object.freeze({
    "vocab.htk": "17e4cc7df1f4d95b80c43df52ecc31f9e5931a319e9964cffbf9dc4ed88c9da2",
  }),
  "kimi-k3": Object.freeze({
    "vocab.htk": "4e0cce4ec2b4b78733882d10756703bdb99db1cada31fc2c3280b0e05c71ab36",
  }),
  "llama3": Object.freeze({
    "vocab.htk": "33e1857c9b2ec0af8d6176ad1a7e6e783a37f010e637f18ebfbfb86597d908f9",
  }),
  "minimax-m3": Object.freeze({
    "vocab.htk": "81eed24ddbabc03221f97c5c46a088bb96efb13afd0fec2036c12aa17f8a51a9",
  }),
  "mistral-tekken": Object.freeze({
    "vocab.htk": "0f3aaad13e639abe29323c87e75c08159e1fa9d34f96e0b519cf189bfc62f763",
  }),
  "nemotron3": Object.freeze({
    "vocab.htk": "1f498097e8d3fcb17458e965dcde3e96fc458ed002807d9a0d04101468d5a63e",
  }),
  "o200k": Object.freeze({
    "vocab.htk": "a583ea153eee0f3547df36f1ad2f38e3d1e92c16942f4ddbafa4b7a9979cb111",
  }),
  "p50k": Object.freeze({
    "vocab.htk": "fc45b94be11649acf1d29bd2885c2d080810f8ad9f6942b9adbe8c1651e3824e",
    "p50k-edit.htk": "ec4fc02da668992fdd11cd304a6cb1c7631e29c3d8de978c2b65a13eb5e3a2da",
  }),
  "qwen3-6": Object.freeze({
    "vocab.htk": "ddf38305ea3f18a2aee3a073f4fac54b99b9f2aa08ec1967eda2f7ff3fabfb0d",
  }),
});

export class VocabIntegrityError extends Error {
  constructor(packageName, file, expected, actual) {
    super(`vocabulary integrity check failed for ${packageName}/${file}: expected SHA-256 ${expected}, received ${actual}`);
    this.name = "VocabIntegrityError";
    this.code = "ERR_HYPERTOK_VOCAB_INTEGRITY";
    this.packageName = packageName;
    this.file = file;
    this.expected = expected;
    this.actual = actual;
  }
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("Web Crypto is unavailable for vocabulary integrity verification");
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyVocabBytes(bytes, packageName, suffix, file) {
  const expected = VOCAB_FILE_SHA256[suffix]?.[file];
  if (expected === undefined) {
    throw new RangeError(`no pinned digest for ${packageName}/${file}`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new VocabIntegrityError(packageName, file, expected, actual);
  }
  return bytes;
}
