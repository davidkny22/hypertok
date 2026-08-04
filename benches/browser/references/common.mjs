export function referenceAdapter(
  id,
  version,
  vocabulary,
  encode,
  decode,
  dispose = () => {},
) {
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

export function requireVocabulary(vocabulary, supported) {
  if (!supported.includes(vocabulary)) {
    throw new Error(`Reference payload does not support ${vocabulary}`);
  }
  return vocabulary;
}

export function tokenizerJson(tokenizerBytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(tokenizerBytes));
}
