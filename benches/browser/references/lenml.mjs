import { fromPreTrained } from "@lenml/tokenizer-gpt2";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "gpt2") {
  requireVocabulary(vocabulary, ["gpt2"]);
  const tokenizer = await fromPreTrained();
  return referenceAdapter(
    "@lenml/tokenizers",
    "3.7.2",
    vocabulary,
    (text) => tokenizer.encode(text),
    (ids) => tokenizer.decode(Array.from(ids), {
      skip_special_tokens: false,
      clean_up_tokenization_spaces: false,
    }),
  );
}
