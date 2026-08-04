import { Tokenizer } from "@huggingface/tokenizers";
import tokenizerBytes from "benchmark-tokenizer-bytes";
import { referenceAdapter, requireVocabulary, tokenizerJson } from "./common.mjs";

export async function createAdapter(vocabulary = "gpt2") {
  requireVocabulary(vocabulary, ["gpt2"]);
  const tokenizer = new Tokenizer(tokenizerJson(tokenizerBytes), {});
  return referenceAdapter(
    "@huggingface/tokenizers",
    "0.1.3",
    vocabulary,
    (text) => tokenizer.encode(text).ids,
    (ids) => tokenizer.decode(Array.from(ids), {
      skip_special_tokens: false,
      clean_up_tokenization_spaces: false,
    }),
  );
}
