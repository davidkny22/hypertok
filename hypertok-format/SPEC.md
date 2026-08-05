# HTK format version 1

HTK files begin with the fixed version-1 header and a section directory. Readers must validate
the file digest, bounds, required sections, section uniqueness, and model-specific invariants
before constructing a tokenizer. Version 1 is extensible through identifier tables: an identifier
that a reader does not implement is invalid and must be refused.

## Named pre-tokenizer pattern identifiers

The `PRETOK` named-pattern payload stores one little-endian `u32` identifier.

| Identifier | Pattern |
| ---: | --- |
| 1 | o200k_base |
| 2 | Qwen 3.5 |
| 3 | Nemotron 3 |
| 4 | DeepSeek V3 |
| 5 | Kimi K2 |
| 6 | GPT-2 |
| 7 | cl100k_base |
| 8 | Cohere Command A+ |

Each identifier selects the matching built-in scanner. A reader that does not implement an
identifier must refuse the file, so no file can be silently interpreted with another scanner.

## Byte-BPE header flags

For byte-BPE files, header bit 0 means merge application is disabled. Header bit 1 means the
`PRIORITY` section represents product rank while the runtime reconstructs every vocabulary-valid
binary split for each ranked product. Bit 1 is valid only when `PRIORITY` is present. A converter
may set it only after proving that the source merge-pair set exactly equals those exhaustive
vocabulary-valid splits. Unknown header bits are errors.

