import * as gpt2 from "gpt-tokenizer/encoding/r50k_base";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "gpt2") {
  requireVocabulary(vocabulary, ["gpt2"]);
  return referenceAdapter(
    "gpt-tokenizer",
    "3.4.0",
    vocabulary,
    gpt2.encode,
    gpt2.decode,
  );
}
