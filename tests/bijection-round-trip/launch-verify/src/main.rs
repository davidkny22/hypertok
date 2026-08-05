use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::error::Error;
use std::fs;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use hypertok::load_tokenizer::hf::load_hf_bpe;
use hypertok::load_tokenizer::htk::load_htk_slice;
use hypertok::load_tokenizer::tiktoken_slice::load_tiktoken_slice;
use hypertok::pretokenize::PretokenizerType;
use hypertok_format::{DIGEST_RANGE, SectionId, ValidatedFile, compute_digest};
use serde_json::Value;

const CORPUS: [&str; 12] = [
    "",
    "Hello, world! This isn't a drill.\n",
    "The quick brown fox jumps over the lazy dog.",
    "Natural language processing needs exact bytes.",
    "fn main() { println!(\"hello\"); } // code\n",
    "Chinese text: \u{81ea}\u{7136}\u{8bed}\u{8a00}\u{5904}\u{7406}\u{3002}",
    "Emoji: \u{1f642}\u{1f680}\u{1f469}\u{200d}\u{1f4bb}",
    "  leading and trailing whitespace  ",
    "line one\r\nline two\t1234567890",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "Russian Greek Arabic Hindi: \u{0420}\u{0443}\u{0441} \u{0395}\u{03bb} \u{0627}\u{0644} \u{0939}\u{093f}",
    "SELECT count(*) FROM tokens WHERE rank >= 128;",
];

struct ExpectedMapping {
    slots: Vec<Option<Vec<u8>>>,
    lookup: BTreeMap<Vec<u8>, u32>,
}

struct Metrics {
    vocab_size: usize,
    key_set_size: usize,
    bytes: usize,
    ids: usize,
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<_> = env::args().skip(1).collect();
    if arguments.first().map(String::as_str) == Some("--cl100k-family") {
        return verify_cl100k_family(&arguments[1..]);
    }
    if arguments.len() != 11 {
        return Err("expected three JSON source/output pairs, then Kimi rank/config/output".into());
    }

    let mut metrics = Vec::new();
    for (name, source, output) in [
        ("qwen3.6", &arguments[0], &arguments[1]),
        ("mistral-tekken", &arguments[2], &arguments[3]),
        ("deepseek-v4", &arguments[4], &arguments[5]),
    ] {
        let expected = tokenizer_json_mapping(&fs::read(source)?)?;
        let bytes = fs::read(output)?;
        verify_mapping(&expected, &bytes)?;
        require_mapping_mutation_red(&expected, &bytes, name)?;
        let (compared_bytes, compared_ids) = verify_json_runtime(source, &bytes)?;
        metrics.push((
            name,
            Metrics {
                vocab_size: expected.slots.len(),
                key_set_size: expected.lookup.len(),
                bytes: compared_bytes,
                ids: compared_ids,
            },
        ));
    }

    let kimi_specials = kimi_specials(&fs::read(&arguments[7])?)?;
    let expected = tiktoken_mapping(&fs::read(&arguments[6])?, &kimi_specials)?;
    let bytes = fs::read(&arguments[8])?;
    verify_mapping(&expected, &bytes)?;
    require_mapping_mutation_red(&expected, &bytes, "kimi-k3")?;
    let (compared_bytes, compared_ids) =
        verify_kimi_runtime(&fs::read(&arguments[6])?, &bytes, &kimi_specials)?;
    metrics.push((
        "kimi-k3",
        Metrics {
            vocab_size: expected.slots.len(),
            key_set_size: expected.lookup.len(),
            bytes: compared_bytes,
            ids: compared_ids,
        },
    ));

    if arguments[9] != "--expected-new-vocabularies" || arguments[10] != "4" {
        return Err("launch verifier sentinel mismatch".into());
    }
    let vocab_slots: usize = metrics.iter().map(|(_, row)| row.vocab_size).sum();
    let key_set: usize = metrics.iter().map(|(_, row)| row.key_set_size).sum();
    let compared_bytes: usize = metrics.iter().map(|(_, row)| row.bytes).sum();
    let compared_ids: usize = metrics.iter().map(|(_, row)| row.ids).sum();
    for (name, row) in &metrics {
        println!(
            "{name}: vocab={} key_set={} runtime_bytes={} runtime_ids={}",
            row.vocab_size, row.key_set_size, row.bytes, row.ids,
        );
    }
    println!(
        "launch verifier PASS: new_vocabularies=4/4 slots={vocab_slots} reverse_keys={key_set} runtime_cases=48/48 runtime_bytes={compared_bytes} runtime_ids={compared_ids} mapping_mutations=4/4",
    );
    Ok(())
}

fn verify_cl100k_family(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let [cl100k_source, cl100k_htk, llama_source, llama_htk] = arguments else {
        return Err("expected cl100k source/HTK and Llama source/HTK paths".into());
    };
    let cl100k_specials = vec![
        ("<|endoftext|>".to_owned(), 100_257),
        ("<|fim_prefix|>".to_owned(), 100_258),
        ("<|fim_middle|>".to_owned(), 100_259),
        ("<|fim_suffix|>".to_owned(), 100_260),
        ("<|endofprompt|>".to_owned(), 100_276),
    ];

    let cl100k_source_bytes = fs::read(cl100k_source)?;
    let cl100k_expected = tiktoken_mapping(&cl100k_source_bytes, &cl100k_specials)?;
    let cl100k_bytes = fs::read(cl100k_htk)?;
    verify_mapping(&cl100k_expected, &cl100k_bytes)?;
    require_mapping_mutation_red(&cl100k_expected, &cl100k_bytes, "cl100k")?;
    let mut cl100k_oracle = load_tiktoken_slice(
        &cl100k_source_bytes,
        PretokenizerType::GPT4,
        cl100k_specials,
    )?;
    let mut cl100k_actual = load_htk_slice(&cl100k_bytes)
        .map_err(|error| format!("cl100k HTK load failed: {error:?}"))?;
    let (cl100k_runtime_bytes, cl100k_runtime_ids) =
        compare_runtime(&mut cl100k_oracle, &mut cl100k_actual)?;

    let llama_source_bytes = fs::read(llama_source)?;
    let llama_expected = tokenizer_json_mapping(&llama_source_bytes)?;
    let llama_bytes = fs::read(llama_htk)?;
    verify_mapping(&llama_expected, &llama_bytes)?;
    require_mapping_mutation_red(&llama_expected, &llama_bytes, "llama3")?;
    let mut llama_oracle = load_hf_bpe(llama_source)?;
    let mut llama_actual = load_htk_slice(&llama_bytes)
        .map_err(|error| format!("Llama 3 HTK load failed: {error:?}"))?;
    let (llama_runtime_bytes, llama_runtime_ids) =
        compare_runtime(&mut llama_oracle, &mut llama_actual)?;

    println!(
        "cl100k-family verifier PASS: vocabularies=2/2 slots={}/{} reverse_keys={}/{} runtime_cases=24/24 runtime_bytes={} runtime_ids={} mapping_mutations=2/2",
        cl100k_expected.slots.len(),
        llama_expected.slots.len(),
        cl100k_expected.lookup.len(),
        llama_expected.lookup.len(),
        cl100k_runtime_bytes + llama_runtime_bytes,
        cl100k_runtime_ids + llama_runtime_ids,
    );
    Ok(())
}

fn tokenizer_json_mapping(source: &[u8]) -> Result<ExpectedMapping, Box<dyn Error>> {
    let tokenizer: Value = serde_json::from_slice(source)?;
    let vocab = tokenizer["model"]["vocab"]
        .as_object()
        .ok_or("model vocab is not an object")?;
    let added = tokenizer["added_tokens"]
        .as_array()
        .ok_or("added_tokens is not an array")?;
    let added_ids: BTreeSet<u32> = added
        .iter()
        .map(|token| json_u32(&token["id"]))
        .collect::<Result<_, _>>()?;
    let highest_model = vocab
        .values()
        .map(json_u32)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max();
    let highest_added = added_ids.iter().copied().max();
    let highest = highest_model
        .into_iter()
        .chain(highest_added)
        .max()
        .ok_or("empty tokenizer mapping")?;
    let mut slots = vec![None; highest as usize + 1];
    let inverse = byte_alias_inverse();
    let mut lookup = BTreeMap::new();
    for (token, id) in vocab {
        let id = json_u32(id)?;
        if added_ids.contains(&id) {
            continue;
        }
        let bytes: Vec<u8> = token
            .chars()
            .map(|character| {
                inverse
                    .get(&character)
                    .copied()
                    .ok_or("non-alias model token")
            })
            .collect::<Result<_, _>>()?;
        if lookup.insert(bytes.clone(), id).is_some() {
            return Err("duplicate decoded model token".into());
        }
        slots[id as usize] = Some(bytes);
    }
    for token in added {
        let id = json_u32(&token["id"])?;
        let content = token["content"]
            .as_str()
            .ok_or("added content is not text")?;
        slots[id as usize] = Some(content.as_bytes().to_vec());
    }
    Ok(ExpectedMapping { slots, lookup })
}

fn tiktoken_mapping(
    source: &[u8],
    specials: &[(String, u32)],
) -> Result<ExpectedMapping, Box<dyn Error>> {
    let content = source.strip_suffix(b"\n").unwrap_or(source);
    let mut rows = Vec::new();
    for line in content.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let separator = line
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or("rank separator")?;
        let bytes = STANDARD.decode(&line[..separator])?;
        let id = std::str::from_utf8(&line[separator + 1..])?.parse::<u32>()?;
        rows.push((id, bytes));
    }
    rows.sort_unstable_by_key(|(id, _)| *id);
    let ordinary_count = rows.len() as u32;
    let highest = specials
        .iter()
        .map(|(_, id)| *id)
        .chain(ordinary_count.checked_sub(1))
        .max()
        .ok_or("empty rank mapping")?;
    let mut slots = vec![None; highest as usize + 1];
    let mut lookup = BTreeMap::new();
    for (expected, (id, bytes)) in rows.into_iter().enumerate() {
        if id != expected as u32 || lookup.insert(bytes.clone(), id).is_some() {
            return Err("rank mapping is not contiguous and unique".into());
        }
        slots[id as usize] = Some(bytes);
    }
    for (token, id) in specials {
        slots[*id as usize] = Some(token.as_bytes().to_vec());
    }
    Ok(ExpectedMapping { slots, lookup })
}

fn kimi_specials(config: &[u8]) -> Result<Vec<(String, u32)>, Box<dyn Error>> {
    let config: Value = serde_json::from_slice(config)?;
    let entries = config["added_tokens_decoder"]
        .as_object()
        .ok_or("Kimi added token map is absent")?;
    let mut overrides = BTreeMap::new();
    for (raw_id, entry) in entries {
        overrides.insert(
            raw_id.parse::<u32>()?,
            entry["content"]
                .as_str()
                .ok_or("Kimi override content")?
                .to_string(),
        );
    }
    Ok((163_584..163_840)
        .map(|id| {
            (
                overrides
                    .remove(&id)
                    .unwrap_or_else(|| format!("<|reserved_token_{id}|>")),
                id,
            )
        })
        .collect())
}

fn verify_mapping(expected: &ExpectedMapping, bytes: &[u8]) -> Result<(), Box<dyn Error>> {
    let file = ValidatedFile::read(bytes)?;
    if file.header().vocab_size as usize != expected.slots.len() {
        return Err("vocabulary size changed".into());
    }
    let mut emitted_lookup = BTreeMap::new();
    for (id, token) in file.tokens() {
        let source = expected.slots[id as usize].as_deref().unwrap_or_default();
        if token != source {
            return Err(format!("id-to-bytes mismatch at {id}").into());
        }
        if expected.lookup.get(token) == Some(&id) {
            emitted_lookup.insert(token.to_vec(), id);
        }
    }
    if emitted_lookup != expected.lookup {
        return Err("bytes-to-id mapping changed".into());
    }
    Ok(())
}

fn require_mapping_mutation_red(
    expected: &ExpectedMapping,
    original: &[u8],
    name: &str,
) -> Result<(), Box<dyn Error>> {
    let file = ValidatedFile::read(original)?;
    let arena = file
        .section_entry(SectionId::Arena.value())
        .ok_or("ARENA absent")?;
    let mut mutated = original.to_vec();
    mutated[arena.offset as usize] ^= 1;
    mutated[DIGEST_RANGE.clone()].fill(0);
    let digest = compute_digest(&mutated);
    mutated[DIGEST_RANGE].copy_from_slice(&digest);
    if verify_mapping(expected, &mutated).is_ok() {
        return Err(format!("{name} mapping mutation stayed green").into());
    }
    Ok(())
}

fn verify_json_runtime(source: &str, htk: &[u8]) -> Result<(usize, usize), Box<dyn Error>> {
    let mut expected = load_hf_bpe(source)?;
    let mut actual = load_htk_slice(htk)?;
    if actual.lookup_index.key_count() == 0 {
        return Err("loaded lookup index is empty".into());
    }
    compare_runtime(&mut expected, &mut actual)
}

fn verify_kimi_runtime(
    source: &[u8],
    htk: &[u8],
    specials: &[(String, u32)],
) -> Result<(usize, usize), Box<dyn Error>> {
    let mut expected = load_tiktoken_slice(source, PretokenizerType::Kimi, specials.to_vec())?;
    let mut actual = load_htk_slice(htk)?;
    compare_runtime(&mut expected, &mut actual)
}

fn compare_runtime(
    expected: &mut hypertok::Tokenizer,
    actual: &mut hypertok::load_tokenizer::htk::LoadedHtk,
) -> Result<(usize, usize), Box<dyn Error>> {
    let mut compared_bytes = 0_usize;
    let mut compared_ids = 0_usize;
    for text in CORPUS {
        let mut expected_ids = Vec::new();
        expected.encode_with_added_tokens_flat(text.as_bytes(), &mut expected_ids);
        let actual_ids = actual.tokenizer.encode(text);
        if actual_ids != expected_ids {
            return Err(format!("runtime ids differ for {text:?}").into());
        }
        if actual.decode_text(&actual_ids)? != text {
            return Err(format!("runtime decode differs for {text:?}").into());
        }
        compared_bytes += text.len();
        compared_ids += actual_ids.len();
    }
    Ok((compared_bytes, compared_ids))
}

fn byte_alias_inverse() -> BTreeMap<char, u8> {
    let direct: BTreeSet<u8> = (b'!'..=b'~')
        .chain(0xA1..=0xAC)
        .chain(0xAE..=0xFF)
        .collect();
    let mut next = 0_u32;
    let mut inverse = BTreeMap::new();
    for byte in 0_u8..=u8::MAX {
        let scalar = if direct.contains(&byte) {
            u32::from(byte)
        } else {
            let scalar = 256 + next;
            next += 1;
            scalar
        };
        inverse.insert(char::from_u32(scalar).expect("valid byte alias"), byte);
    }
    inverse
}

fn json_u32(value: &Value) -> Result<u32, Box<dyn Error>> {
    u32::try_from(value.as_u64().ok_or("id is not unsigned")?).map_err(Into::into)
}
