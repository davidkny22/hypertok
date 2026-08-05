use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::error::Error;
use std::fs;

use hypertok::load_tokenizer::hf::{HfTokenizer, load_hf_slice};
use hypertok::load_tokenizer::htk::{LoadedHtk, load_htk_slice};
use hypertok_format::{DIGEST_RANGE, SectionId, ValidatedFile, compute_digest};
use serde_json::Value;

const CORPUS: [&str; 12] = [
    "",
    "Hello, world! This isn't a drill.\n",
    "The quick brown fox jumps over the lazy dog.",
    "fn main() { println!(\"hello\"); } // code\n",
    "Chinese text: 自然语言处理。",
    "Emoji: 🙂🚀👩‍💻",
    "  leading and trailing whitespace  ",
    "line one\r\nline two\t1234567890",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "Russian Greek Arabic Hindi: Рус Ελληνικά العربية हिन्दी",
    "SELECT count(*) FROM tokens WHERE rank >= 128;",
    "boundary:\0\u{feff}\u{200b}\u{2060}:end",
];

struct ExpectedMapping {
    slots: Vec<Option<Vec<u8>>>,
    lookup: BTreeMap<Vec<u8>, u32>,
    specials: Vec<String>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<_> = env::args().skip(1).collect();
    let [name, source_path, htk_path] = arguments.as_slice() else {
        return Err("expected a name, tokenizer.json path, and HTK path".into());
    };
    let source = fs::read(source_path)?;
    let htk = fs::read(htk_path)?;
    let expected = tokenizer_json_mapping(&source)?;
    verify_mapping(&expected, &htk)?;
    require_mapping_mutation_red(&expected, &htk)?;

    let mut source_runtime = load_hf_slice(&source)?;
    let mut htk_runtime = load_htk_slice(&htk)?;
    let mut compared_bytes = 0_usize;
    let mut compared_ids = 0_usize;
    for text in CORPUS {
        compare_case(&mut source_runtime, &mut htk_runtime, text, true)?;
        compared_bytes += text.len();
        compared_ids += encode_source(&mut source_runtime, text).len();
    }
    for special in &expected.specials {
        compare_case(&mut source_runtime, &mut htk_runtime, special, false)?;
        compared_bytes += special.len();
        compared_ids += encode_source(&mut source_runtime, special).len();
    }

    println!(
        "{name} package verifier PASS: slots={} reverse_keys={} corpus={}/{} specials={}/{} bytes={} ids={} mapping_mutation=RED",
        expected.slots.len(),
        expected.lookup.len(),
        CORPUS.len(),
        CORPUS.len(),
        expected.specials.len(),
        expected.specials.len(),
        compared_bytes,
        compared_ids,
    );
    Ok(())
}

fn compare_case(
    source: &mut HfTokenizer,
    actual: &mut LoadedHtk,
    text: &str,
    require_identity: bool,
) -> Result<(), Box<dyn Error>> {
    let expected_ids = encode_source(source, text);
    let actual_ids = actual.tokenizer.encode(text);
    if actual_ids != expected_ids {
        return Err(format!("runtime ids differ for {text:?}").into());
    }
    if require_identity && actual.decode_text(&actual_ids)? != text {
        return Err(format!("runtime decode differs for {text:?}").into());
    }
    Ok(())
}

fn encode_source(tokenizer: &mut HfTokenizer, text: &str) -> Vec<u32> {
    match tokenizer {
        HfTokenizer::Bpe(tokenizer) => {
            let mut ids = Vec::new();
            tokenizer.encode_with_added_tokens_flat(text.as_bytes(), &mut ids);
            ids
        }
        HfTokenizer::SentencePiece(tokenizer) => tokenizer
            .encode_raw(text)
            .into_iter()
            .map(|token| token.0)
            .collect(),
    }
}

fn tokenizer_json_mapping(source: &[u8]) -> Result<ExpectedMapping, Box<dyn Error>> {
    let tokenizer: Value = serde_json::from_slice(source)?;
    let vocab = tokenizer["model"]["vocab"]
        .as_object()
        .ok_or("model vocab is not an object")?;
    let added = tokenizer["added_tokens"]
        .as_array()
        .ok_or("added_tokens is not an array")?;
    let byte_fallback = tokenizer["model"]["byte_fallback"]
        .as_bool()
        .unwrap_or(false);
    let added_ids = added
        .iter()
        .map(|token| json_u32(&token["id"]))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let highest = vocab
        .values()
        .map(json_u32)
        .chain(added.iter().map(|token| json_u32(&token["id"])))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max()
        .ok_or("empty tokenizer mapping")?;
    let mut slots = vec![None; highest as usize + 1];
    let mut lookup = BTreeMap::new();
    let inverse = byte_alias_inverse();
    for (token, id) in vocab {
        let id = json_u32(id)?;
        if added_ids.contains(&id) {
            continue;
        }
        let bytes = if byte_fallback {
            parse_byte_fallback(token).map_or_else(|| token.as_bytes().to_vec(), |byte| vec![byte])
        } else {
            token
                .chars()
                .map(|character| {
                    inverse
                        .get(&character)
                        .copied()
                        .ok_or("non-alias byte-BPE token")
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        if !(byte_fallback && parse_byte_fallback(token).is_some()) {
            if lookup.insert(bytes.clone(), id).is_some() {
                return Err("duplicate decoded model token".into());
            }
        }
        slots[id as usize] = Some(bytes);
    }
    let mut specials = Vec::new();
    for token in added {
        let id = json_u32(&token["id"])?;
        let content = token["content"]
            .as_str()
            .ok_or("added content is not text")?;
        slots[id as usize] = Some(content.as_bytes().to_vec());
        if token["special"].as_bool() == Some(true) {
            specials.push(content.to_owned());
        }
    }
    Ok(ExpectedMapping {
        slots,
        lookup,
        specials,
    })
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
        return Err("mapping mutation stayed green".into());
    }
    Ok(())
}

fn parse_byte_fallback(token: &str) -> Option<u8> {
    let digits = token.strip_prefix("<0x")?.strip_suffix('>')?;
    (digits.len() == 2)
        .then(|| u8::from_str_radix(digits, 16).ok())
        .flatten()
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
