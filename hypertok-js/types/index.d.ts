import type { ResolvedVocab } from "./vocab-resolve.js";

export type Tier = "single" | "worker" | "shared";
export type OptimizationState = "auto" | "off";
export type CandidateOptimizationState = OptimizationState | "on";

export interface OptimizationOptions {
  decodeAssembly?: OptimizationState;
  decodeBoundary?: OptimizationState;
  decodeBorrowedOutput?: CandidateOptimizationState;
  decodeUtf16Output?: CandidateOptimizationState;
  decodeHotStrings?: OptimizationState;
  decodeTable?: OptimizationState;
  decodeByteTable?: CandidateOptimizationState;
  decodeMixedRuns?: CandidateOptimizationState;
  decodeRunCache?: CandidateOptimizationState;
  decodeLatin1Native?: CandidateOptimizationState;
  decodeLatin1Portable?: CandidateOptimizationState;
  decodeFusedValidation?: CandidateOptimizationState;
  decodeLeanDispatch?: CandidateOptimizationState;
  decodeCleanUnroll?: CandidateOptimizationState;
  decodeDirectScratch?: CandidateOptimizationState;
  decodeMemo?: CandidateOptimizationState;
}

export interface LoadOptions {
  tier?: Tier;
  workers?: number;
  optimizations?: OptimizationOptions;
  moduleSource?: WebAssembly.Module | BufferSource;
  validate?: boolean;
}

export interface ReservedPolicy {
  match?: "all" | readonly string[];
  refuse?: "all" | readonly string[];
}

export interface EncodeResult {
  ids: Uint32Array;
  starts: Uint32Array;
  reservedFound: readonly string[];
}

export interface EncodeOptions {
  reserved?: ReservedPolicy;
}

export interface Tokenizer {
  readonly vocabSize: number;
  readonly structuralClass: "byte_bpe" | "sentencepiece_bpe";
  readonly tier: Tier;
  readonly formatVersion: number;
  readonly prefixMarker: Uint32Array;
  readonly suffixMarker: Uint32Array;
  encode(text: string, options?: EncodeOptions): Promise<Uint32Array>;
  encodeInto(
    text: string,
    destination: Uint32Array,
    options?: EncodeOptions,
  ): Promise<number>;
  encodeSync(text: string, options?: EncodeOptions): Uint32Array;
  encodeDetailed(text: string, options?: EncodeOptions): Promise<EncodeResult>;
  decode(ids: Uint32Array | number[]): string;
  tokenBytes(id: number): Uint8Array;
  free(): void;
}

export function fromBytes(
  bytes: Uint8Array | ArrayBuffer | ResolvedVocab,
  options?: LoadOptions,
): Promise<Tokenizer>;
