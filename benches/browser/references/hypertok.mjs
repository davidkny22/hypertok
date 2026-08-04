import gpt2 from "benchmark-hypertok-gpt2-htk";
import { referenceAdapter, requireVocabulary } from "./common.mjs";
import { fromBytes } from "../../../hypertok-js/src/index.mjs";

export async function createAdapter(vocabulary = "gpt2") {
  requireVocabulary(vocabulary, ["gpt2"]);
  const tokenizer = await fromBytes(gpt2, {
    tier: "single",
  });
  return referenceAdapter(
    "hypertok",
    "workspace",
    vocabulary,
    (text) => tokenizer.encodeSync(text),
    (ids) => tokenizer.decode(ids),
    () => tokenizer.free(),
  );
}
