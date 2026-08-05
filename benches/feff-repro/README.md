# GPT-2 U+FEFF exactness repro

Run from the repository root:

```powershell
node benches/feff-repro/run.mjs
```

The harness compares the packaged public runtime, its direct binding, chunk-prescan encoding, and
pretoken ranges against the pinned `@dqbd/tiktoken` GPT-2 implementation. It covers padding sizes
0, 50, 200, 2,000, and 100,000 plus the Unicode whitespace edge points U+0085, U+00A0, U+200B,
U+2060, and U+FEFF. Hugging Face's result is reported separately because its JavaScript regex
classifies U+FEFF differently.
