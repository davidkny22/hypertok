import { Tiktoken } from "js-tiktoken";
import o200kRanks from "js-tiktoken/ranks/o200k_base";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "o200k_base") {
  requireVocabulary(vocabulary, ["o200k_base"]);
  const tokenizer = new Tiktoken(o200kRanks);
  return referenceAdapter(
    "js-tiktoken",
    "1.0.21",
    vocabulary,
    (text) => tokenizer.encode(text),
    (ids) => tokenizer.decode(ids),
  );
}
