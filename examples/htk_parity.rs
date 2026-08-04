use hypertok::load_tokenizer::hf::load_hf_sentencepiece;
use hypertok::load_tokenizer::htk::{HtkLoadError, load_htk_slice};
use hypertok::load_tokenizer::tiktoken_slice::load_tiktoken_slice;
use hypertok::pretokenize::PretokenizerType;
use hypertok_format::{DIGEST_RANGE, SectionId, ValidatedFile, compute_digest, decode_u32};
use std::collections::BTreeSet;
use std::env;
use std::fs;

const FIXED_CORPUS: [&str; 14] = [
    "",
    "Hello, world! This isn't a drill.\n",
    "The quick brown fox jumps over the lazy dog.",
    "自然语言处理需要逐字节一致。",
    "fn main() { println!(\"hello\"); } // code\n",
    "🙂🚀👩‍💻 café naïve; combining: e\u{301}",
    "  leading and trailing whitespace  ",
    "line one\r\nline two\t1234567890",
    "<|endoftext|> ordinary text <|endofprompt|>",
    "<s>literal special-like text</s>",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "▁already marked and spaced",
    "Русский Ελληνικά العربية हिन्दी",
    "SELECT count(*) FROM tokens WHERE rank >= 128;",
];

fn main() {
    let args: Vec<String> = env::args().collect();
    assert!(
        args.len() == 3 || args.len() == 5,
        "usage: htk_parity O200K_HTK O200K_RANKS [LLAMA_HTK LLAMA_JSON]"
    );
    let o200k_bytes = fs::read(&args[1]).expect("read o200k .htk");
    let ranks = fs::read(&args[2]).expect("read o200k ranks");

    let mut o200k = load_htk_slice(&o200k_bytes).expect("load o200k .htk");
    assert_lookup_index(&o200k, &o200k_bytes, 199_998);
    let mut o200k_oracle = load_tiktoken_slice(
        &ranks,
        PretokenizerType::O200k,
        vec![
            ("<|endoftext|>".to_string(), 199_999),
            ("<|endofprompt|>".to_string(), 200_018),
        ],
    )
    .expect("load o200k reference path");
    assert!(o200k.prepend_ids.is_empty() && o200k.append_ids.is_empty());

    let mut compared_bytes = 0_usize;
    let mut compared_ids = 0_usize;
    let corpus = corpus();
    for text in &corpus {
        let actual = o200k.tokenizer.encode(text);
        let mut expected = Vec::new();
        o200k_oracle.encode_with_added_tokens_flat(text.as_bytes(), &mut expected);
        assert_eq!(actual, expected, "o200k mismatch for {text:?}");
        assert_eq!(o200k.tokenizer.decode(&actual), text.as_bytes());
        compared_bytes += text.len();
        compared_ids += actual.len();
    }

    assert_digest_mutation_refused(&o200k_bytes);

    if args.len() == 3 {
        println!(
            "source-loader parity PASS: cases={} bytes={} ids={} negative_controls=1/1",
            corpus.len(),
            compared_bytes,
            compared_ids,
        );
        return;
    }

    let llama_bytes = fs::read(&args[3]).expect("read Llama .htk");
    let mut llama = load_htk_slice(&llama_bytes).expect("load Llama .htk");
    assert_lookup_index(&llama, &llama_bytes, 31_741);
    let llama_oracle = load_hf_sentencepiece(&args[4]).expect("load Llama reference path");
    assert_eq!(llama.prepend_ids, [1]);
    assert!(llama.append_ids.is_empty());
    for text in &corpus {
        let actual = llama.tokenizer.encode(text);
        let expected_tokens = llama_oracle.encode_raw(text);
        let expected: Vec<u32> = expected_tokens.iter().copied().map(u32::from).collect();
        assert_eq!(actual, expected, "Llama mismatch for {text:?}");
        assert_eq!(
            llama.tokenizer.decode(&actual),
            llama_oracle.decode(&expected_tokens)
        );
        compared_bytes += text.len();
        compared_ids += actual.len();
    }

    let first_nonempty = corpus
        .iter()
        .find(|text| !text.is_empty())
        .expect("nonempty corpus member");
    let correct = llama.tokenizer.encode(first_nonempty);
    let mut planted = correct.clone();
    planted[0] ^= 1;
    assert_ne!(planted, correct, "id comparator mutation stayed green");

    let priority_outcome = assert_priority_mutation_red(&llama_bytes, &|text| {
        llama_oracle
            .encode_raw(text)
            .into_iter()
            .map(u32::from)
            .collect()
    });
    println!(
        "class-parity PASS: classes=2/2 cases={} bytes={} ids={} negative_controls=3/3 priority_mutation={priority_outcome}",
        corpus.len() * 2,
        compared_bytes,
        compared_ids,
    );
}

fn assert_lookup_index(
    loaded: &hypertok::load_tokenizer::htk::LoadedHtk,
    bytes: &[u8],
    expected_keys: usize,
) {
    let file = ValidatedFile::read(bytes).expect("validated lookup source");
    let mut observed = BTreeSet::new();
    for (_, token) in file.tokens() {
        if let Some(id) = loaded.lookup_index.lookup(token) {
            assert_eq!(loaded.lookup_index.token(id), Some(token));
            observed.insert(id);
        }
    }
    assert_eq!(loaded.lookup_index.key_count() as usize, expected_keys);
    assert_eq!(observed.len(), expected_keys);
    assert!(loaded.lookup_index.resident_bytes() > 0);
}

fn corpus() -> Vec<String> {
    const ATOMS: [&str; 31] = [
        "a",
        "Z",
        "0",
        "17",
        " ",
        "  ",
        "\n",
        "\r\n",
        "\t",
        ".",
        ",",
        "'s",
        "_",
        "::",
        "()",
        "自然",
        "语言",
        "界",
        "🙂",
        "🚀",
        "👩‍💻",
        "é",
        "e\u{301}",
        "▁",
        "Рус",
        "العربية",
        "हिन्दी",
        "<s>",
        "</s>",
        "<|endoftext|>",
        "{}",
    ];
    let mut output: Vec<String> = FIXED_CORPUS
        .iter()
        .map(|text| (*text).to_string())
        .collect();
    let mut state = 0x8f3d_91b5_7a2c_4e61_u64;
    for case in 0..4_096 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let count = 1 + (state as usize % 48);
        let mut text = String::new();
        for index in 0..count {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            text.push_str(ATOMS[(state as usize + case + index) % ATOMS.len()]);
        }
        output.push(text);
    }
    output
}

fn assert_digest_mutation_refused(bytes: &[u8]) {
    let file = ValidatedFile::read(bytes).expect("validated mutation source");
    let arena = file
        .section_entry(SectionId::Arena.value())
        .expect("ARENA entry");
    let mut mutated = bytes.to_vec();
    let index = arena.offset as usize;
    mutated[index] ^= 1;
    assert!(matches!(
        load_htk_slice(&mutated),
        Err(HtkLoadError::Format(
            hypertok_format::ReadError::DigestMismatch
        ))
    ));
}

fn assert_priority_mutation_red(bytes: &[u8], oracle: &impl Fn(&str) -> Vec<u32>) -> &'static str {
    let file = ValidatedFile::read(bytes).expect("validated priority source");
    let entry = file
        .section_entry(SectionId::Priority.value())
        .expect("PRIORITY entry");
    let section = file
        .section(SectionId::Priority.value())
        .expect("PRIORITY section");
    let mut values = Vec::with_capacity(file.header().vocab_size as usize);
    let mut spans = Vec::with_capacity(file.header().vocab_size as usize);
    let mut remaining = section;
    let mut offset = 0_usize;
    for _ in 0..file.header().vocab_size {
        let (value, consumed) = decode_u32(remaining).expect("validated priority varint");
        values.push(value);
        spans.push((offset, consumed));
        offset += consumed;
        remaining = &remaining[consumed..];
    }
    let (left, right) = values
        .windows(2)
        .enumerate()
        .find_map(|(index, pair)| {
            (pair[0] != 0
                && pair[1] != 0
                && pair[0] > pair[1]
                && spans[index].1 == spans[index + 1].1)
                .then_some((index, index + 1))
        })
        .expect("priority inversion with equal-width values");

    let mut mutated = bytes.to_vec();
    let start = entry.offset as usize;
    let left_range = start + spans[left].0..start + spans[left].0 + spans[left].1;
    let right_range = start + spans[right].0..start + spans[right].0 + spans[right].1;
    let left_bytes = mutated[left_range.clone()].to_vec();
    let right_bytes = mutated[right_range.clone()].to_vec();
    mutated[left_range].copy_from_slice(&right_bytes);
    mutated[right_range].copy_from_slice(&left_bytes);
    let digest = compute_digest(&mutated);
    mutated[DIGEST_RANGE].copy_from_slice(&digest);

    let Ok(mut loaded) = load_htk_slice(&mutated) else {
        return "load-red";
    };
    let original = ValidatedFile::read(bytes).expect("validated original");
    let candidates = mutation_candidates(&original, left, right);
    for candidate in candidates {
        let actual = loaded.tokenizer.encode(&candidate);
        let expected = oracle(&candidate);
        if actual != expected {
            return "parity-red";
        }
    }
    for (_, token) in original.tokens() {
        if let Ok(candidate) = std::str::from_utf8(token) {
            let actual = loaded.tokenizer.encode(candidate);
            let expected = oracle(candidate);
            if actual != expected {
                return "parity-red";
            }
        }
    }
    panic!("priority inversion mutation stayed green");
}

fn mutation_candidates(file: &ValidatedFile<'_>, left: usize, right: usize) -> Vec<String> {
    let tokens: Vec<&[u8]> = file.tokens().map(|(_, token)| token).collect();
    let mut output = Vec::new();
    for bytes in [tokens[left], tokens[right]] {
        if let Ok(text) = std::str::from_utf8(bytes) {
            output.push(text.to_string());
            output.push(format!(" {text}"));
            output.push(format!("{text}{text}"));
        }
    }
    if let (Ok(a), Ok(b)) = (
        std::str::from_utf8(tokens[left]),
        std::str::from_utf8(tokens[right]),
    ) {
        output.push(format!("{a}{b}"));
        output.push(format!("{b}{a}"));
    }
    output
}
