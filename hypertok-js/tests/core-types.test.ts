import {
  fromBytes,
  type EncodeResult,
  type ReservedPolicy,
  type Tier,
  type Tokenizer,
} from "hypertok";
import { loadVocab, VOCAB_VERSIONS } from "hypertok/vocab-resolve";

declare const bytes: Uint8Array;
const tier: Tier = "single";
const policy: ReservedPolicy = { match: "all", refuse: [] };
const tokenizer: Tokenizer = await fromBytes(bytes, {
  tier,
  workers: 1,
  moduleSource: bytes,
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
const installedVocab: Uint8Array = await loadVocab("o200k", { timeoutMs: 5_000 });
const o200kVersion: string | undefined = VOCAB_VERSIONS.o200k;

void syncIds;
void detailed;
void decoded;
void token;
void structuralClass;
void prefixMarker;
void installedVocab;
void o200kVersion;
