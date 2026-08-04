import * as o200k from "gpt-tokenizer/encoding/o200k_base";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "o200k_base") {
  requireVocabulary(vocabulary, ["o200k_base"]);
  return referenceAdapter(
    "gpt-tokenizer",
    "3.4.0",
    vocabulary,
    o200k.encode,
    o200k.decode,
  );
}
