import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { get_encoding as getEncoding } from "@dqbd/tiktoken";
import { Tiktoken as JsTiktoken } from "js-tiktoken";

import { fromBytes } from "../../src/index.mjs";
import { createTiktokenShim } from "../../src/tiktoken-shim.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(
  directory,
  "../../../../hypertok-langchain/docs/research",
);
const outputBase = path.join(outputDirectory, "2026-08-05-divergence-audit-results");

const encodings = [
  {
    id: "cl100k_base",
    canonical: "cl100k_base",
    ranks: "js-tiktoken/ranks/cl100k_base",
    vocabulary: "@hypertok/vocab-cl100k",
    file: "vocab.htk",
    special: "<|endoftext|>",
  },
  {
    id: "o200k_base",
    canonical: "o200k_base",
    ranks: "js-tiktoken/ranks/o200k_base",
    vocabulary: "@hypertok/vocab-o200k",
    file: "vocab.htk",
    special: "<|endoftext|>",
  },
  {
    id: "r50k_base/gpt2",
    canonical: "r50k_base",
    ranks: "js-tiktoken/ranks/r50k_base",
    vocabulary: "@hypertok/vocab-gpt2",
    file: "vocab.htk",
    special: "<|endoftext|>",
  },
  {
    id: "p50k_base",
    canonical: "p50k_base",
    ranks: "js-tiktoken/ranks/p50k_base",
    vocabulary: "@hypertok/vocab-p50k",
    file: "vocab.htk",
    special: "<|endoftext|>",
  },
];

const corpus = [];
const add = (category, ...inputs) => {
  for (const input of inputs) corpus.push(Object.freeze({ category, input }));
};

add(
  "empty-and-small",
  "",
  "a",
  "hello",
  "hello world",
  "The quick brown fox jumps over the lazy dog.",
  "A café costs €4.50 today.",
  "Hypertok counts tokens exactly, even at awkward boundaries.",
  "Line one. Line two? Line three!",
);
add(
  "prose",
  "It was the best of times, it was the worst of times.",
  "Token counting should be deterministic across runtimes.",
  "A long-ish sentence with commas, parentheses (like these), and semicolons; still prose.",
  "Numbers 0 1 2 3 10 99 100 1000 123456789 occur beside words.",
  "URLs such as https://example.com/a?b=c&d=e and email@example.com are common.",
  "don't can't won't I'd we'll they're apostrophes and contractions",
  "UPPER lower TitleCase camelCase snake_case kebab-case",
  "One\nparagraph\nwith\nshort\nlines.",
);
add(
  "code",
  "const answer = (value) => value * 42;",
  "function f(x) { return x?.map((y) => y + 1) ?? []; }",
  "for (let i = 0; i < 100; i += 1) console.log(i);",
  "SELECT id, name FROM users WHERE active = true ORDER BY id DESC;",
  "def greet(name: str) -> str:\n    return f\"hello {name}\"",
  "fn main() { println!(\"hello, world\"); }",
  "<div class=\"card\"><span>hello</span></div>",
  "{\"alpha\":1,\"beta\":[true,false,null],\"text\":\"hello\"}",
  "#!/usr/bin/env node\nconsole.log(process.argv.slice(2));",
  "a::before { content: \"→\"; display: inline-block; }",
);
add(
  "cjk",
  "中文分词测试。",
  "简体中文、繁體中文、日本語、한국어。",
  "東京都渋谷区で機械学習モデルを試します。",
  "안녕하세요. 토큰 수를 정확하게 계산합니다.",
  "汉字かな交じり文とカタカナ。",
  "零一二三四五六七八九十",
  "中文\n\n下一段",
  "空 白　和不换行空格 结束",
  "甲乙丙丁戊己庚辛壬癸",
  "你好，world，こんにちは，세계!",
);
add(
  "emoji",
  "😀 😃 😄 😁 😆 😅 😂 🤣",
  "👩🏽‍💻 codes while 👨‍👩‍👧‍👦 watches.",
  "🏳️‍🌈🏴‍☠️🇺🇸🇯🇵🇰🇷",
  "👍🏿👍🏽👍🏻 thumbs",
  "❤️🧡💛💚💙💜🖤🤍🤎",
  "keycap 1️⃣ 2️⃣ 3️⃣ and ©️ ®️ ™️",
  "family 👩‍👩‍👦‍👦 then text",
  "emoji\n\n﻿following BOM",
  "🧑‍🚀\u200B🛰️\u2060🌌",
  "🙂🙃🙂🙃🙂🙃",
);
add(
  "ascii-whitespace",
  " ",
  "  ",
  "\t",
  "\n",
  "\r\n",
  "\n\n",
  "a b",
  "a\tb",
  "a\n\nb",
  "  leading",
  "trailing  ",
  "\t mixed \r\n whitespace \n",
);
add(
  "unicode-whitespace",
  "a\u00a0b",
  "a\u0085b",
  "a\u1680b",
  "a\u2000b",
  "a\u2007b",
  "a\u2028b",
  "a\u2029b",
  "a\u202fb",
  "a\u205fb",
  "a\u3000b",
  "\n\n\u00a0next",
  "\n\n\u0085next",
);
add(
  "zero-width-and-feff",
  "\u200b",
  "a\u200bb",
  "\u2060",
  "a\u2060b",
  "\ufeff",
  "a\ufeffb",
  "\ufeff\ufeff",
  "\n\n\ufeff",
  ".\n\n\ufeff\ufeffAlso on HuffPost:\n\n",
  `${"x".repeat(50)}.\n\n\ufeff\ufeffAlso on HuffPost:\n\n${"y".repeat(50)}`,
  `${"x".repeat(200)}.\n\n\ufeff\ufeffAlso on HuffPost:\n\n${"y".repeat(200)}`,
  "\u200c\u200d\u034f\u061c",
  "text\ufeff\n\nmore",
  "\n\n\u2060next",
);
add(
  "combining-and-normalization",
  "café",
  "cafe\u0301",
  "Ångström",
  "A\u030angstro\u0308m",
  "नमस्ते दुनिया",
  "مرحبا بالعالم",
  "שָׁלוֹם עוֹלָם",
  "สวัสดีชาวโลก",
  "e\u0301e\u0301e\u0301",
  "Z̢͑ͫ̎ͪ̎ͪ̕a̴l̡g͝o̕",
);
add(
  "punctuation-and-symbols",
  "!@#$%^&*()_+-=[]{}|;':,./<>?",
  "“quotes” ‘single’ «guillemets» ‹single›",
  "— – - ‐ ‑ − plus ... …",
  "© ® ™ § ¶ † ‡ • ◦",
  "math: ∀x∈ℝ, x²≥0; ∑ᵢ i = n(n+1)/2",
  "currency: $1 €2 £3 ¥4 ₹5 ₿6",
  "path C:\\Users\\name\\file.txt /usr/local/bin",
  "version 1.2.3-alpha+build.7",
);

function resultOf(operation) {
  try {
    return { length: operation().length, error: null };
  } catch (error) {
    return {
      length: null,
      error: {
        name: error?.constructor?.name ?? typeof error,
        message: String(error?.message ?? error),
      },
    };
  }
}

async function packageVersion(name) {
  const manifest = JSON.parse(await readFile(path.join(directory, "node_modules", name, "package.json")));
  return manifest.version;
}

const versions = {
  canonical: await packageVersion("@dqbd/tiktoken"),
  jsTiktoken: await packageVersion("js-tiktoken"),
  hypertok: JSON.parse(await readFile(path.resolve(directory, "../../package.json"))).version,
  vocabularies: "1.0.0",
};

const rows = [];
const specialPolicy = [];
for (const encoding of encodings) {
  const canonical = getEncoding(encoding.canonical);
  const { default: jsRanks } = await import(encoding.ranks);
  const javascript = new JsTiktoken(jsRanks);
  const vocabModule = await import(encoding.vocabulary);
  const vocabUrl = encoding.file === "vocab.htk"
    ? vocabModule.vocabulary
    : new URL(encoding.file, vocabModule.vocabulary);
  const vocabBytes = await readFile(vocabUrl);
  const handle = await fromBytes(vocabBytes, { tier: "single" });
  const hypertok = createTiktokenShim(handle, { name: encoding.canonical });
  try {
    for (const probe of corpus) {
      const canonicalResult = resultOf(() => canonical.encode(probe.input));
      const jsResult = resultOf(() => javascript.encode(probe.input));
      const hypertokResult = resultOf(() => hypertok.encode(probe.input));
      const diverges = canonicalResult.length !== null
        && jsResult.length !== null
        && canonicalResult.length !== jsResult.length;
      const hypertokMatchesCanonical = canonicalResult.length === hypertokResult.length
        && canonicalResult.error?.name === hypertokResult.error?.name;
      rows.push({
        encoding: encoding.id,
        category: probe.category,
        input: probe.input,
        canonical: canonicalResult,
        jsTiktoken: jsResult,
        hypertok: hypertokResult,
        diverges,
        hypertokMatchesCanonical,
      });
      if (canonicalResult.length !== null) {
        assert.equal(
          hypertokResult.length,
          canonicalResult.length,
          `${encoding.id} hypertok mismatch for ${JSON.stringify(probe.input)}`,
        );
      }
    }
    specialPolicy.push({
      encoding: encoding.id,
      input: encoding.special,
      canonicalDefault: resultOf(() => canonical.encode(encoding.special)),
      canonicalAllowedAll: resultOf(() => canonical.encode(encoding.special, "all")),
      jsTiktokenDefault: resultOf(() => javascript.encode(encoding.special)),
      hypertokDefault: resultOf(() => hypertok.encode(encoding.special)),
      hypertokAllowedAll: resultOf(() => hypertok.encode(encoding.special, "all")),
    });
  } finally {
    hypertok.free();
    javascript.free?.();
    canonical.free();
  }
}

const divergences = rows.filter((row) => row.diverges);
const mismatches = rows.filter(
  (row) => row.canonical.length !== null && !row.hypertokMatchesCanonical,
);
assert.equal(mismatches.length, 0, "hypertok must match canonical on every encodable probe");

const summary = encodings.map(({ id }) => {
  const encodingRows = rows.filter((row) => row.encoding === id);
  return {
    encoding: id,
    probes: encodingRows.length,
    jsTiktokenDivergences: encodingRows.filter((row) => row.diverges).length,
    hypertokCanonicalMismatches: encodingRows.filter(
      (row) => row.canonical.length !== null && !row.hypertokMatchesCanonical,
    ).length,
  };
});

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  versions,
  corpusCasesPerEncoding: corpus.length,
  summary,
  specialPolicy,
  divergences,
  rows,
};
await writeFile(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  "# OpenAI encoding divergence audit",
  "",
  `Generated: ${report.generatedAt}`,
  "",
  `Versions: canonical @dqbd/tiktoken ${versions.canonical}; js-tiktoken ${versions.jsTiktoken}; hypertok workspace ${versions.hypertok}; vocab packages ${versions.vocabularies}.`,
  "",
  "## Summary",
  "",
  "| Encoding | Probes | js-tiktoken length divergences | hypertok canonical mismatches |",
  "|---|---:|---:|---:|",
  ...summary.map((row) => `| ${row.encoding} | ${row.probes} | ${row.jsTiktokenDivergences} | ${row.hypertokCanonicalMismatches} |`),
  "",
  "## Canonical default special-token behavior",
  "",
  "| Encoding | Input | Default result | Allowed-all length | hypertok default result |",
  "|---|---|---|---:|---|",
  ...specialPolicy.map((row) => {
    const canonicalDefault = row.canonicalDefault.error
      ? `${row.canonicalDefault.error.name}: ${row.canonicalDefault.error.message.replaceAll("|", "\\|")}`
      : `length ${row.canonicalDefault.length}`;
    const hypertokDefault = row.hypertokDefault.error
      ? `${row.hypertokDefault.error.name}: ${row.hypertokDefault.error.message.replaceAll("|", "\\|")}`
      : `length ${row.hypertokDefault.length}`;
    return `| ${row.encoding} | \`${row.input}\` | ${canonicalDefault} | ${row.canonicalAllowedAll.length} | ${hypertokDefault} |`;
  }),
  "",
  "## js-tiktoken length divergences",
  "",
];
if (divergences.length === 0) {
  lines.push("None in the audited corpus.");
} else {
  lines.push("| Encoding | Category | Input | Canonical | js-tiktoken | hypertok |", "|---|---|---|---:|---:|---:|");
  for (const row of divergences) {
    lines.push(`| ${row.encoding} | ${row.category} | \`${JSON.stringify(row.input).slice(1, -1).replaceAll("|", "\\|")}\` | ${row.canonical.length} | ${row.jsTiktoken.length} | ${row.hypertok.length} |`);
  }
}
lines.push(
  "",
  "Hypertok matched canonical tiktoken on every canonical-encodable probe, including every row where js-tiktoken differed.",
  "",
  `Machine-readable rows: [${path.basename(outputBase)}.json](./${path.basename(outputBase)}.json).`,
  "",
);
await writeFile(`${outputBase}.md`, lines.join("\n"));

console.log(JSON.stringify({ outputBase, summary, divergences: divergences.length, specialPolicy }, null, 2));
