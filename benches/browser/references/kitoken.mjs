import tokenizerBytes from "benchmark-tokenizer-bytes";
import kitokenWasm from "../../node_modules/kitoken/dist/full_bg.wasm";
import * as kitokenGlue from "../../node_modules/kitoken/dist/full_bg.js";
import { referenceAdapter, requireVocabulary } from "./common.mjs";

export async function createAdapter(vocabulary = "gpt2") {
  requireVocabulary(vocabulary, ["gpt2"]);
  const result = await WebAssembly.instantiate(kitokenWasm, {
    "./full_bg.js": kitokenGlue,
  });
  kitokenGlue.__wbg_set_wasm(result.instance.exports);
  const tokenizer = kitokenGlue.Kitoken.from_tokenizers(tokenizerBytes);
  return referenceAdapter(
    "kitoken",
    "0.11.0",
    vocabulary,
    (text) => tokenizer.encode(text, false),
    (ids) => tokenizer.decode(ids, false),
    () => tokenizer.free(),
  );
}
