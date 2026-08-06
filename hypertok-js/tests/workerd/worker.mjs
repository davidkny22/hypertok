import { fromBytes } from "../../src/index.mjs";
import wasmModule from "../../wasm/single/hypertok_wasm_core_bg.wasm";
import vocabulary from "../../../hypertok-vocab/gpt2/vocab.htk";

const probeText = "workerd edge round trip \u{1F469}\u{1F3FD}\u200D\u{1F4BB}";

export default {
  async fetch() {
    try {
      const tokenizer = await fromBytes(vocabulary, { moduleSource: wasmModule });
      try {
        const ids = await tokenizer.encode(probeText);
        const decoded = tokenizer.decode(ids);
        return Response.json({
          ok: decoded === probeText,
          tier: tokenizer.tier,
          ids: [...ids],
          decoded,
        }, { status: decoded === probeText ? 200 : 500 });
      } finally {
        tokenizer.free();
      }
    } catch (error) {
      return Response.json({
        ok: false,
        name: error?.name,
        message: error?.message,
      }, { status: 500 });
    }
  },
};
