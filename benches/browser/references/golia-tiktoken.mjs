import init, { getEncoding } from "@goliapkg/tiktoken-wasm";
import goliaWasm from "../../node_modules/@goliapkg/tiktoken-wasm/tiktoken_wasm_bg.wasm";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "gpt2") {
  requireVocabulary(vocabulary, ["gpt2"]);
  await init({ module_or_path: goliaWasm });
  const tokenizer = getEncoding("r50k_base");
  return referenceAdapter(
    "@goliapkg/tiktoken-wasm",
    "3.5.1",
    vocabulary,
    (text) => tokenizer.encode(text),
    (ids) => tokenizer.decode(ids),
    () => tokenizer.free(),
  );
}
