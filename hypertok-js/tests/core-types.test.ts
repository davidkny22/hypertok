import {
  fromBytes,
  type EncodeResult,
  type ReservedPolicy,
  type Tier,
  type Tokenizer,
} from "hypertok";

declare const bytes: Uint8Array;
const tier: Tier = "single";
const policy: ReservedPolicy = { match: "all", refuse: [] };
const tokenizer: Tokenizer = await fromBytes(bytes, {
  tier,
  workers: 1,
  optimizations: { decodeAssembly: "auto", decodeTable: "auto" },
});
const ids: Uint32Array = await tokenizer.encode("hello", { reserved: policy });
const syncIds: Uint32Array = tokenizer.encodeSync("hello");
const written: number = await tokenizer.encodeInto("hello", new Uint32Array(16));
const detailed: EncodeResult = await tokenizer.encodeDetailed("hello");
const decoded: string = tokenizer.decode(ids);
const token: Uint8Array = tokenizer.tokenBytes(ids[0]);
const structuralClass: "byte_bpe" | "sentencepiece_bpe" = tokenizer.structuralClass;
const prefixMarker: Uint32Array = tokenizer.prefixMarker;
tokenizer.free();

void syncIds;
void detailed;
void decoded;
void token;
void structuralClass;
void prefixMarker;
