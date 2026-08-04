export type TiktokenSpecialSelector = "all" | readonly string[];

export interface ReservedPolicy {
  match?: "all" | readonly string[];
  refuse?: "all" | readonly string[];
}

export interface ReservedEncoding {
  ids: Uint32Array;
  reservedFound: readonly string[];
}

export interface TiktokenShimRuntime {
  readonly tier: "single";
  encodeReservedSync(text: string, policy?: ReservedPolicy): ReservedEncoding;
  reservedTokens(): readonly string[];
  tokenBytes(id: number): Uint8Array;
  decodeBytes(ids: Uint32Array | number[]): Uint8Array;
  close(): void | Promise<void>;
}

export interface TiktokenShim {
  readonly name: string | undefined;
  encode(
    text: string,
    allowed_special?: TiktokenSpecialSelector,
    disallowed_special?: TiktokenSpecialSelector,
  ): Uint32Array;
  encode_ordinary(text: string): Uint32Array;
  decode(tokens: Uint32Array | number[]): Uint8Array;
  encodeReserved(text: string, policy?: ReservedPolicy): ReservedEncoding;
  free(): void;
}

export function createTiktokenShim(
  runtime: TiktokenShimRuntime | Tokenizer,
  options?: { name?: string },
): TiktokenShim;
import type { Tokenizer } from "./index.d.ts";
