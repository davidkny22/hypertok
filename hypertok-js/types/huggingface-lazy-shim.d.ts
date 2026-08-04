import type {
  HuggingFaceShim,
  HuggingFaceShimRuntime,
  HuggingFaceShimSetup,
} from "./huggingface-shim.d.ts";
import type { Tokenizer } from "./index.d.ts";

export interface HotStringResolver {
  tokenString(id: number): string | undefined;
}

export function createLazyHuggingFaceShim(
  runtime: HuggingFaceShimRuntime | Tokenizer,
  setup: HuggingFaceShimSetup,
  options?: { hotStrings?: HotStringResolver },
): HuggingFaceShim;
