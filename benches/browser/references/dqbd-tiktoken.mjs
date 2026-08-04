import * as dqbd from "@dqbd/tiktoken/lite/init";
import gpt2 from "@dqbd/tiktoken/encoders/gpt2";
import dqbdWasm from "../../node_modules/@dqbd/tiktoken/lite/tiktoken_bg.wasm";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "gpt2") {
  requireVocabulary(vocabulary, ["gpt2"]);
  await dqbd.init((imports) => WebAssembly.instantiate(dqbdWasm, imports));
  const tokenizer = new dqbd.Tiktoken(
    gpt2.bpe_ranks,
    gpt2.special_tokens,
    gpt2.pat_str,
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
