import argparse
import json
from pathlib import Path

import tokenizers
from tokenizers import Tokenizer
from tokenizers.processors import TemplateProcessing


def text_for_case(case: dict) -> str:
    if "text" in case:
        return case["text"] * case.get("repeat", 1)
    if "bytes" in case:
        return bytes(case["bytes"]).decode("utf-8", errors="strict")
    if "surrogate_code_units" in case:
        return "".join(chr(unit) for unit in case["surrogate_code_units"])
    raise ValueError(f"case {case['id']!r} has no supported input field")


def encode_cases(
    tokenizer: Tokenizer, corpus: list[dict], add_special_tokens: bool
) -> list[dict]:
    results = []
    for case in corpus:
        try:
            text = text_for_case(case)
            ids = tokenizer.encode(text, add_special_tokens=add_special_tokens).ids
            results.append({"id": case["id"], "outcome": "ok", "ids": ids})
        except (TypeError, UnicodeError) as error:
            results.append(
                {
                    "id": case["id"],
                    "outcome": "error",
                    "error_class": type(error).__name__,
                }
            )
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("tokenizer_json", type=Path)
    parser.add_argument("corpus_json", type=Path)
    args = parser.parse_args()

    corpus = json.loads(args.corpus_json.read_text(encoding="utf-8"))
    raw_tokenizer = Tokenizer.from_file(str(args.tokenizer_json))
    raw = encode_cases(raw_tokenizer, corpus, add_special_tokens=False)

    processed_tokenizer = Tokenizer.from_file(str(args.tokenizer_json))
    processed_tokenizer.post_processor = TemplateProcessing(
        single="<|endoftext|> $A <|endoftext|>",
        special_tokens=[("<|endoftext|>", 50256)],
    )
    postprocessed = encode_cases(processed_tokenizer, corpus, add_special_tokens=True)

    print(
        json.dumps(
            {
                "tokenizers_version": tokenizers.__version__,
                "raw": raw,
                "postprocessed": postprocessed,
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
