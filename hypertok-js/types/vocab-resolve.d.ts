export const VOCAB_VERSIONS: Readonly<Record<string, string>>;

export class VocabIntegrityError extends Error {
  readonly name: "VocabIntegrityError";
  readonly code: "ERR_HYPERTOK_VOCAB_INTEGRITY";
  readonly packageName: string;
  readonly file: string;
  readonly expected: string;
  readonly actual: string;
}

export interface VocabLoadOptions {
  file?: string;
  timeoutMs?: number;
}

declare const resolverOwnedVocab: unique symbol;

export interface ResolvedVocab {
  readonly bytes: Uint8Array;
  readonly [resolverOwnedVocab]: true;
}

export interface VocabLoaderDependencies {
  readLocal?: (packageName: string, file: string) => Promise<Uint8Array | ArrayBuffer>;
  fetch?: (
    input: string,
    init: { signal: AbortSignal },
  ) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

export type VocabLoader = (
  name: string,
  options?: VocabLoadOptions,
) => Promise<Uint8Array>;

export function createVocabLoader(dependencies?: VocabLoaderDependencies): VocabLoader;
export function loadVocab(name: string, options?: VocabLoadOptions): Promise<ResolvedVocab>;
