import {
  createTiktokenShim,
  type ReservedEncoding as TiktokenReservedEncoding,
  type TiktokenShimRuntime,
} from "hypertok/tiktoken";
import {
  createHuggingFaceShim,
  type HuggingFaceShimRuntime,
  type HuggingFaceShimSetup,
} from "hypertok/huggingface";
import { createLazyHuggingFaceShim } from "hypertok/huggingface-lazy";
import type { Tokenizer } from "hypertok";

declare const tiktokenRuntime: TiktokenShimRuntime;
declare const huggingFaceRuntime: HuggingFaceShimRuntime;
declare const huggingFaceSetup: HuggingFaceShimSetup;
declare const publicHandle: Tokenizer;

const tiktoken = createTiktokenShim(tiktokenRuntime, { name: "o200k_base" });
const ids: Uint32Array = tiktoken.encode("hello", "all", []);
const ordinary: Uint32Array = tiktoken.encode_ordinary("hello");
const bytes: Uint8Array = tiktoken.decode(ids);
const detailed: TiktokenReservedEncoding = tiktoken.encodeReserved("hello", { match: [] });
tiktoken.free();

const huggingFace = createHuggingFaceShim(huggingFaceRuntime, huggingFaceSetup);
const encoded = huggingFace.encode("hello", {
  text_pair: "world",
  add_special_tokens: true,
  return_token_type_ids: true,
});
const decoded: string = huggingFace.decode(encoded.ids, {
  skip_special_tokens: true,
  clean_up_tokenization_spaces: false,
});
const reported = huggingFace.encodeReserved("hello", { refuse: [] });
huggingFace.free();

createTiktokenShim(publicHandle).free();
createHuggingFaceShim(publicHandle, huggingFaceSetup).free();
createLazyHuggingFaceShim(publicHandle, huggingFaceSetup).free();

void ordinary;
void bytes;
void detailed;
void decoded;
void reported;
