export function huggingFaceTokenizerFixture() {
  const vocab = {
    "<unk>": 0,
    "<s>": 1,
    "</s>": 2,
  };
  for (let byte = 0; byte <= 0xff; byte += 1) {
    vocab[`<0x${byte.toString(16).toUpperCase().padStart(2, "0")}>`] = byte + 3;
  }
  return {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: [
      { id: 0, content: "<unk>", single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
      { id: 1, content: "<s>", single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
      { id: 2, content: "</s>", single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    ],
    normalizer: {
      type: "Sequence",
      normalizers: [
        { type: "Prepend", prepend: "▁" },
        { type: "Replace", pattern: { String: " " }, content: "▁" },
      ],
    },
    pre_tokenizer: null,
    post_processor: {
      type: "TemplateProcessing",
      single: [
        { SpecialToken: { id: "<s>", type_id: 0 } },
        { Sequence: { id: "A", type_id: 0 } },
      ],
      pair: [
        { SpecialToken: { id: "<s>", type_id: 0 } },
        { Sequence: { id: "A", type_id: 0 } },
        { SpecialToken: { id: "<s>", type_id: 1 } },
        { Sequence: { id: "B", type_id: 1 } },
      ],
      special_tokens: {
        "<s>": { id: "<s>", ids: [1], tokens: ["<s>"] },
      },
    },
    decoder: {
      type: "Sequence",
      decoders: [
        { type: "Replace", pattern: { String: "▁" }, content: " " },
        { type: "ByteFallback" },
        { type: "Fuse" },
        { type: "Strip", content: " ", start: 1, stop: 0 },
      ],
    },
    model: {
      type: "BPE",
      dropout: null,
      unk_token: "<unk>",
      continuing_subword_prefix: null,
      end_of_word_suffix: null,
      fuse_unk: true,
      byte_fallback: true,
      vocab,
      merges: [],
    },
  };
}
