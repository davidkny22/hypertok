use std::collections::BTreeMap;

use hypertok_converter::{JsonConversionError, convert_tokenizer_json};
use hypertok_format::{NamedPattern, SectionId, StructuralClass, ValidatedFile};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const QWEN35: &str = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";
const NEMOTRON: &str = r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+";
const LLAMA3_CL100K: &str = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";
const O200K: &str = r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+";
const RIGHT_GROUP_DIGITS: &str = r"\d{1,3}(?=(?:\d{3})*\b)";

#[test]
fn byte_aliases_added_ids_nfc_and_non_products_round_trip() {
    let source = fixture(QWEN35, false, true, false);
    let source = serde_json::to_vec(&source).unwrap();
    let conversion = convert_tokenizer_json(&source, Sha256::digest(&source).into()).unwrap();
    assert_eq!(conversion.source_token_count, 259);
    assert_eq!(conversion.special_token_count, 1);
    assert_eq!(conversion.vocab_size, 259);
    assert_eq!(conversion.key_set_size, 258);
    assert_eq!(conversion.gap_count, 0);
    assert!(conversion.priority_present);
    assert_eq!(conversion.priority_inversions, 0);

    let file = ValidatedFile::read(&conversion.bytes).unwrap();
    assert_eq!(file.header().structural_class, StructuralClass::ByteBpe);
    assert_eq!(file.header().flags, 0);
    assert!(file.section(SectionId::Norm.value()).is_some());
    assert!(file.section(SectionId::Affix.value()).is_some());
    assert!(file.section(SectionId::Priority.value()).is_some());
    assert_eq!(file.tokens().nth(256), Some((256, b"ab".as_slice())));
    assert_eq!(file.tokens().nth(257), Some((257, b"abc".as_slice())));
    assert_eq!(file.tokens().nth(258), Some((258, b"<added>".as_slice())));
    assert_eq!(pretok_pattern(&file), NamedPattern::Qwen35.value());
}

#[test]
fn pair_merges_absent_model_type_and_ignore_merges_are_carried() {
    let mut source = fixture(NEMOTRON, true, false, true);
    source["model"].as_object_mut().unwrap().remove("type");
    source["model"]["merges"] = json!([["a", "b"]]);
    source["model"]["vocab"]
        .as_object_mut()
        .unwrap()
        .remove("abc");
    source["added_tokens"][0]["id"] = json!(257);
    let source = serde_json::to_vec(&source).unwrap();
    let conversion = convert_tokenizer_json(&source, Sha256::digest(&source).into()).unwrap();
    assert_eq!(conversion.vocab_size, 258);
    assert_eq!(conversion.key_set_size, 257);
    assert!(!conversion.priority_present);

    let file = ValidatedFile::read(&conversion.bytes).unwrap();
    assert_eq!(file.header().flags, 1);
    assert!(file.section(SectionId::Norm.value()).is_some());
    assert!(file.section(SectionId::Affix.value()).is_none());
    assert_eq!(pretok_pattern(&file), NamedPattern::Nemotron.value());
}

#[test]
fn bare_byte_level_regex_selects_gpt2() {
    let mut source = fixture(QWEN35, false, false, false);
    source["pre_tokenizer"] = json!({
        "type": "ByteLevel",
        "add_prefix_space": false,
        "trim_offsets": true,
        "use_regex": true
    });
    let source = serde_json::to_vec(&source).unwrap();
    let conversion = convert_tokenizer_json(&source, Sha256::digest(&source).into()).unwrap();
    let file = ValidatedFile::read(&conversion.bytes).unwrap();
    assert_eq!(pretok_pattern(&file), NamedPattern::Gpt2.value());
}

#[test]
fn removed_inverted_o200k_split_and_absent_postprocessor_are_exactly_admitted() {
    let mut source = fixture(O200K, false, false, false);
    source["pre_tokenizer"]["pretokenizers"][0]["behavior"] = json!("Removed");
    source["pre_tokenizer"]["pretokenizers"][0]["invert"] = json!(true);
    source["post_processor"] = Value::Null;
    let bytes = serde_json::to_vec(&source).unwrap();
    let conversion = convert_tokenizer_json(&bytes, Sha256::digest(&bytes).into()).unwrap();
    let file = ValidatedFile::read(&conversion.bytes).unwrap();
    assert_eq!(pretok_pattern(&file), NamedPattern::O200kBase.value());
    assert!(file.section(SectionId::Post.value()).is_none());

    source["pre_tokenizer"]["pretokenizers"][0]["invert"] = json!(false);
    let bytes = serde_json::to_vec(&source).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&bytes, Sha256::digest(&bytes).into()),
        Err(JsonConversionError::Unsupported("byte-BPE split behavior"))
    ));
}

#[test]
fn command_split_and_template_envelope_are_exactly_admitted() {
    let mut source = fixture(O200K, false, false, false);
    let o200k = source["pre_tokenizer"]["pretokenizers"][0].clone();
    let byte_level = source["pre_tokenizer"]["pretokenizers"][1].clone();
    source["pre_tokenizer"]["pretokenizers"] = json!([
        {
            "type": "Split",
            "pattern": {"Regex": RIGHT_GROUP_DIGITS},
            "behavior": "Isolated",
            "invert": false
        },
        o200k,
        byte_level
    ]);
    source["added_tokens"][0]["special"] = json!(true);
    let duplicate = source["added_tokens"][0].clone();
    source["added_tokens"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    source["post_processor"] = command_postprocessor();
    let bytes = serde_json::to_vec(&source).unwrap();
    let conversion = convert_tokenizer_json(&bytes, Sha256::digest(&bytes).into()).unwrap();
    let file = ValidatedFile::read(&conversion.bytes).unwrap();
    assert_eq!(pretok_pattern(&file), NamedPattern::CohereCommand.value());
    let post = file.section(SectionId::Post.value()).unwrap();
    assert_eq!(u32::from_le_bytes(post[..4].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(post[5..9].try_into().unwrap()), 258);

    let mut conflicting_duplicate = source.clone();
    conflicting_duplicate["added_tokens"][1]["content"] = json!("<different>");
    let bytes = serde_json::to_vec(&conflicting_duplicate).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&bytes, Sha256::digest(&bytes).into()),
        Err(JsonConversionError::InvalidId(258))
    ));

    source["pre_tokenizer"]["pretokenizers"][0]["pattern"]["Regex"] =
        json!(r"\d{1,4}(?=(?:\d{4})*\b)");
    let bytes = serde_json::to_vec(&source).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&bytes, Sha256::digest(&bytes).into()),
        Err(JsonConversionError::Unsupported("named split pattern"))
    ));

    source["pre_tokenizer"]["pretokenizers"][0]["pattern"]["Regex"] = json!(RIGHT_GROUP_DIGITS);
    source["post_processor"]["trim_offsets"] = json!(true);
    let bytes = serde_json::to_vec(&source).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&bytes, Sha256::digest(&bytes).into()),
        Err(JsonConversionError::Unsupported(
            "byte-BPE postprocessor template options"
        ))
    ));
}

#[test]
fn llama_sequence_postprocessor_and_cl100k_pattern_are_encoded() {
    let mut source = fixture(LLAMA3_CL100K, false, false, false);
    source["added_tokens"][0]["special"] = json!(true);
    source["post_processor"] = llama_sequence_postprocessor();
    let source = serde_json::to_vec(&source).unwrap();
    let conversion = convert_tokenizer_json(&source, Sha256::digest(&source).into()).unwrap();
    let file = ValidatedFile::read(&conversion.bytes).unwrap();

    assert_eq!(pretok_pattern(&file), NamedPattern::Cl100kBase.value());
    let post = file.section(SectionId::Post.value()).unwrap();
    assert_eq!(u32::from_le_bytes(post[..4].try_into().unwrap()), 1);
    assert_eq!(post[4], 0);
    assert_eq!(u32::from_le_bytes(post[5..9].try_into().unwrap()), 258);
}

#[test]
fn unsupported_postprocessor_sequences_are_refused() {
    let mut reversed = fixture(LLAMA3_CL100K, false, false, false);
    let mut processors = llama_sequence_postprocessor()["processors"]
        .as_array()
        .unwrap()
        .clone();
    processors.reverse();
    reversed["post_processor"] = json!({"type": "Sequence", "processors": processors});
    let source = serde_json::to_vec(&reversed).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&source, Sha256::digest(&source).into()),
        Err(JsonConversionError::Unsupported("byte-BPE postprocessor"))
    ));

    let mut extra = fixture(LLAMA3_CL100K, false, false, false);
    let mut processors = llama_sequence_postprocessor()["processors"]
        .as_array()
        .unwrap()
        .clone();
    processors.push(json!({
        "type": "ByteLevel",
        "add_prefix_space": false,
        "trim_offsets": false,
        "use_regex": false
    }));
    extra["post_processor"] = json!({"type": "Sequence", "processors": processors});
    let source = serde_json::to_vec(&extra).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&source, Sha256::digest(&source).into()),
        Err(JsonConversionError::Unsupported(
            "byte-BPE postprocessor sequence"
        ))
    ));
}

#[test]
fn exhaustive_duplicate_product_merges_require_complete_split_coverage() {
    let mut source = fixture(LLAMA3_CL100K, false, false, false);
    source["model"]["vocab"]["bc"] = json!(257);
    source["model"]["vocab"]["cd"] = json!(258);
    source["model"]["vocab"]["abc"] = json!(259);
    source["model"]["vocab"]["bcd"] = json!(260);
    source["model"]["vocab"]["abcd"] = json!(261);
    source["added_tokens"][0]["id"] = json!(262);
    source["model"]["merges"] = json!([
        "a b", "b c", "c d", "ab c", "a bc", "b cd", "bc d", "abc d", "ab cd", "a bcd"
    ]);
    let bytes = serde_json::to_vec(&source).unwrap();
    let conversion = convert_tokenizer_json(&bytes, Sha256::digest(&bytes).into()).unwrap();
    let file = ValidatedFile::read(&conversion.bytes).unwrap();
    assert_eq!(file.header().flags, 2);
    assert!(conversion.priority_present);

    source["model"]["merges"].as_array_mut().unwrap().pop();
    let bytes = serde_json::to_vec(&source).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&bytes, Sha256::digest(&bytes).into()),
        Err(JsonConversionError::Unsupported(
            "duplicate-product merge coverage"
        ))
    ));
}

#[test]
fn merge_without_its_concatenated_product_is_refused() {
    let mut source = fixture(QWEN35, false, true, false);
    source["model"]["merges"] = json!(["a a"]);
    let source = serde_json::to_vec(&source).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&source, Sha256::digest(&source).into()),
        Err(JsonConversionError::InvalidMerge(0))
    ));
}

#[test]
fn novel_pattern_and_behavioral_postprocessor_are_refused() {
    let mut unknown = fixture("novel", false, true, false);
    let source = serde_json::to_vec(&unknown).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&source, Sha256::digest(&source).into()),
        Err(JsonConversionError::Unsupported("named split pattern"))
    ));

    unknown["pre_tokenizer"]["pretokenizers"][0]["pattern"]["Regex"] = json!(QWEN35);
    unknown["post_processor"]["trim_offsets"] = json!(true);
    let source = serde_json::to_vec(&unknown).unwrap();
    assert!(matches!(
        convert_tokenizer_json(&source, Sha256::digest(&source).into()),
        Err(JsonConversionError::Unsupported(
            "ByteLevel postprocessor trim_offsets"
        ))
    ));
}

fn fixture(pattern: &str, ignore_merges: bool, nfc: bool, normalized: bool) -> Value {
    let mut vocab = BTreeMap::new();
    for (byte, alias) in byte_aliases().into_iter().enumerate() {
        vocab.insert(alias.to_string(), byte as u32);
    }
    vocab.insert("ab".to_string(), 256);
    vocab.insert("abc".to_string(), 257);
    json!({
        "version": "1.0",
        "truncation": null,
        "padding": null,
        "added_tokens": [{
            "id": 258,
            "content": "<added>",
            "single_word": false,
            "lstrip": false,
            "rstrip": false,
            "normalized": normalized,
            "special": false
        }],
        "normalizer": if nfc { json!({"type": "NFC"}) } else { json!({"type": "Sequence", "normalizers": []}) },
        "pre_tokenizer": {
            "type": "Sequence",
            "pretokenizers": [
                {"type": "Split", "pattern": {"Regex": pattern}, "behavior": "Isolated", "invert": false},
                {"type": "ByteLevel", "add_prefix_space": false, "trim_offsets": true, "use_regex": false}
            ]
        },
        "post_processor": {"type": "ByteLevel", "add_prefix_space": true, "trim_offsets": false, "use_regex": true},
        "decoder": {"type": "ByteLevel", "add_prefix_space": true, "trim_offsets": true, "use_regex": true},
        "model": {
            "type": "BPE",
            "dropout": null,
            "unk_token": null,
            "continuing_subword_prefix": if nfc { json!("") } else { Value::Null },
            "end_of_word_suffix": if nfc { json!("") } else { Value::Null },
            "fuse_unk": false,
            "byte_fallback": false,
            "ignore_merges": ignore_merges,
            "vocab": vocab,
            "merges": ["a b"]
        }
    })
}

fn llama_sequence_postprocessor() -> Value {
    json!({
        "type": "Sequence",
        "processors": [
            {
                "type": "ByteLevel",
                "add_prefix_space": true,
                "trim_offsets": false,
                "use_regex": true
            },
            {
                "type": "TemplateProcessing",
                "single": [
                    {"SpecialToken": {"id": "<added>", "type_id": 0}},
                    {"Sequence": {"id": "A", "type_id": 0}}
                ],
                "pair": [
                    {"SpecialToken": {"id": "<added>", "type_id": 0}},
                    {"Sequence": {"id": "A", "type_id": 0}},
                    {"SpecialToken": {"id": "<added>", "type_id": 1}},
                    {"Sequence": {"id": "B", "type_id": 1}}
                ],
                "special_tokens": {
                    "<added>": {"id": "<added>", "ids": [258], "tokens": ["<added>"]}
                }
            }
        ]
    })
}

fn command_postprocessor() -> Value {
    json!({
        "type": "TemplateProcessing",
        "add_prefix_space": true,
        "trim_offsets": false,
        "use_regex": true,
        "single": [
            {"SpecialToken": {"id": "<added>", "type_id": 0}},
            {"Sequence": {"id": "A", "type_id": 0}}
        ],
        "pair": [
            {"SpecialToken": {"id": "<added>", "type_id": 0}},
            {"Sequence": {"id": "A", "type_id": 0}},
            {"Sequence": {"id": "B", "type_id": 1}},
            {"SpecialToken": {"id": "<added>", "type_id": 1}},
            {"SpecialToken": {"id": "<added>", "type_id": 1}}
        ],
        "special_tokens": {
            "<added>": {"id": "<added>", "ids": [258], "tokens": ["<added>"]}
        }
    })
}

fn byte_aliases() -> [char; 256] {
    let direct: std::collections::BTreeSet<u8> = (b'!'..=b'~')
        .chain(0xA1..=0xAC)
        .chain(0xAE..=0xFF)
        .collect();
    let mut next = 0_u32;
    std::array::from_fn(|index| {
        let byte = index as u8;
        let scalar = if direct.contains(&byte) {
            u32::from(byte)
        } else {
            let scalar = 256 + next;
            next += 1;
            scalar
        };
        char::from_u32(scalar).unwrap()
    })
}

fn pretok_pattern(file: &ValidatedFile<'_>) -> u32 {
    let section = file.section(SectionId::Pretok.value()).unwrap();
    u32::from_le_bytes(section[5..9].try_into().unwrap())
}
