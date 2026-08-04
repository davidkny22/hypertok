import init, { getEncoding } from "@goliapkg/tiktoken-wasm";
import goliaWasm from "../../node_modules/@goliapkg/tiktoken-wasm/tiktoken_wasm_bg.wasm";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "o200k_base") {
  requireVocabulary(vocabulary, ["o200k_base"]);
  await init({ module_or_path: goliaWasm });
  const tokenizer = getEncoding("o200k_base");
  return referenceAdapter(
    "@goliapkg/tiktoken-wasm",
    "3.5.1",
    vocabulary,
    (text) => tokenizer.encode(text),
    (ids) => tokenizer.decode(ids),
    () => tokenizer.free(),
  );
}
