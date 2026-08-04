import o200k from "benchmark-hypertok-o200k-htk";
import { referenceAdapter, requireVocabulary } from "./common.mjs";
import { fromBytes } from "../../../hypertok-js/src/index.mjs";

export async function createAdapter(vocabulary = "o200k_base") {
  requireVocabulary(vocabulary, ["o200k_base"]);
  const tokenizer = await fromBytes(o200k, { tier: "single" });
  return referenceAdapter(
    "hypertok",
    "workspace",
    vocabulary,
    (text) => tokenizer.encodeSync(text),
    (ids) => tokenizer.decode(ids),
    () => tokenizer.free(),
  );
}
