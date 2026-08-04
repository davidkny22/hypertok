import * as dqbd from "@dqbd/tiktoken/lite/init";
import o200k from "@dqbd/tiktoken/encoders/o200k_base";
import dqbdWasm from "../../node_modules/@dqbd/tiktoken/lite/tiktoken_bg.wasm";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "o200k_base") {
  requireVocabulary(vocabulary, ["o200k_base"]);
  await dqbd.init((imports) => WebAssembly.instantiate(dqbdWasm, imports));
  const tokenizer = new dqbd.Tiktoken(
    o200k.bpe_ranks,
    o200k.special_tokens,
    o200k.pat_str,
  );
  return referenceAdapter(
    "@dqbd/tiktoken",
    "1.0.21",
    vocabulary,
    (text) => tokenizer.encode(text),
    (ids) => tokenizer.decode(ids),
    () => tokenizer.free(),
  );
}
