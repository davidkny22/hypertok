import { Tiktoken } from "js-tiktoken";
import gpt2Ranks from "js-tiktoken/ranks/gpt2";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "gpt2") {
  requireVocabulary(vocabulary, ["gpt2"]);
  const tokenizer = new Tiktoken(gpt2Ranks);
  return referenceAdapter(
    "js-tiktoken",
    "1.0.21",
    vocabulary,
    (text) => tokenizer.encode(text),
    (ids) => tokenizer.decode(ids),
  );
}
