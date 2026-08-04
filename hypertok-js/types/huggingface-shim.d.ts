export interface ReservedPolicy {
  match?: "all" | readonly string[];
  refuse?: "all" | readonly string[];
}

export interface ReservedEncoding {
  ids: Uint32Array;
  reservedFound: readonly string[];
}

export interface HuggingFaceShimRuntime {
  readonly tier: "single";
  encodeReservedSync(text: string, policy?: ReservedPolicy): ReservedEncoding;
  decode(ids: Uint32Array | number[]): string;
  close(): void | Promise<void>;
}

export interface HuggingFaceEncodeOptions {
  text_pair?: string | null;
  add_special_tokens?: boolean;
  return_token_type_ids?: boolean | null;
}

export interface HuggingFaceDecodeOptions {
  skip_special_tokens?: boolean;
  clean_up_tokenization_spaces?: boolean | null;
}

export interface HuggingFaceEncoding {
  ids: number[];
  tokens: string[];
  attention_mask: number[];
  token_type_ids?: number[];
}

export interface HuggingFaceReservedEncoding extends HuggingFaceEncoding {
  reservedFound: readonly string[];
}

export interface HuggingFaceShimSetup {
  tokenString(id: number): string | undefined;
  postProcess(
    first: readonly number[],
    second: readonly number[] | null,
    addSpecialTokens: boolean,
  ): {
    ids: Uint32Array | number[];
    token_type_ids?: Uint32Array | number[];
  };
  specialTokens: readonly string[];
  unknownTokenId: number;
  cleanUpTokenizationSpaces?: boolean;
}

export interface HuggingFaceShim {
  encode(text: string, options?: HuggingFaceEncodeOptions): HuggingFaceEncoding;
  decode(ids: Array<number | bigint>, options?: HuggingFaceDecodeOptions): string;
  encodeReserved(
    text: string,
    policy?: ReservedPolicy,
    options?: HuggingFaceEncodeOptions,
  ): HuggingFaceReservedEncoding;
  free(): void;
}

export function createHuggingFaceShim(
  runtime: HuggingFaceShimRuntime | Tokenizer,
  setup: HuggingFaceShimSetup,
): HuggingFaceShim;
import type { Tokenizer } from "./index.d.ts";
