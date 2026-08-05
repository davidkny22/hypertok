#![cfg(feature = "source-loaders")]

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use hypertok::load_tokenizer::hf::HfTokenizer;
use hypertok::load_tokenizer::hf::load_hf_slice;
use hypertok::load_tokenizer::tiktoken::load_tiktoken;
use hypertok::load_tokenizer::tiktoken_slice::load_tiktoken_slice;
use hypertok::pretokenize::PretokenizerType;

#[cfg(feature = "htk")]
use hypertok::load_tokenizer::htk::{HtkTokenizer, load_htk_slice};
#[cfg(feature = "htk")]
use hypertok_converter::{Document, Section, TiktokenDefinition, convert_tiktoken, write};
#[cfg(feature = "htk")]
use hypertok_format::{
    HashScheme, NamedPattern, NormStepKind, PretokStepKind, SectionId, StructuralClass,
};
#[cfg(feature = "htk")]
use sha2::{Digest, Sha256};
fn byte_ranks() -> Vec<u8> {
    let mut data = Vec::new();
    for byte in 0u8..=u8::MAX {
        data.extend_from_slice(BASE64_STANDARD.encode([byte]).as_bytes());
        data.extend_from_slice(format!(" {byte}\n").as_bytes());
    }
    data
}

#[test]
fn tiktoken_file_and_slice_loaders_match() {
    let data = byte_ranks();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("tiktoken-slice-{}.tiktoken", std::process::id()));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, &data).unwrap();

    let mut from_file = load_tiktoken(&path, PretokenizerType::GPT2, Vec::new()).unwrap();
    let mut from_slice = load_tiktoken_slice(&data, PretokenizerType::GPT2, Vec::new()).unwrap();
    let file_vocab: Vec<_> = from_file
        .vocab_entries()
        .map(|(id, token)| (id, token.to_vec()))
        .collect();
    let slice_vocab: Vec<_> = from_slice
        .vocab_entries()
        .map(|(id, token)| (id, token.to_vec()))
        .collect();
    assert_eq!(file_vocab, slice_vocab);

    let input = b"portable byte-slice loader\nwith two lines";
    let mut file_ids = Vec::new();
    let mut slice_ids = Vec::new();
    from_file.encode_with_added_tokens_flat(input, &mut file_ids);
    from_slice.encode_with_added_tokens_flat(input, &mut slice_ids);
    assert_eq!(file_ids, slice_ids);

    std::fs::remove_file(path).unwrap();
}

#[test]
fn tiktoken_slice_rejects_invalid_utf8() {
    let error = load_tiktoken_slice(&[0xFF], PretokenizerType::GPT2, Vec::new())
        .err()
        .expect("invalid UTF-8 must be refused");
    assert!(error.to_string().contains("not valid UTF-8"));
}

#[test]
fn portable_hf_loader_applies_nfc() {
    let vocab: serde_json::Map<String, serde_json::Value> = (0u8..=u8::MAX)
        .map(|byte| {
            (
                gpt2_byte_char(byte).to_string(),
                serde_json::Value::from(byte),
            )
        })
        .collect();
    let json = serde_json::to_vec(&serde_json::json!({
        "normalizer": {"type": "NFC"},
        "model": {"type": "BPE", "vocab": vocab, "merges": []}
    }))
    .unwrap();
    let mut tokenizer = match load_hf_slice(&json).unwrap() {
        HfTokenizer::Bpe(tokenizer) => tokenizer,
        #[cfg(feature = "sentencepiece")]
        HfTokenizer::SentencePiece(_) => panic!("byte-BPE fixture loaded as SentencePiece"),
    };
    let mut ids = Vec::new();
    let input = "A\u{030A}".as_bytes();
    tokenizer.encode_with_added_tokens_flat(input, &mut ids);
    assert_eq!(ids, vec![0xC3, 0x85]);
    assert_eq!(tokenizer.token_starts(input, &ids).unwrap(), vec![0, 0]);
}

#[cfg(feature = "htk")]
#[test]
fn portable_htk_loader_applies_nfc() {
    let mut base = Vec::with_capacity(256 * 4);
    for id in 0_u32..256 {
        base.extend_from_slice(&id.to_le_bytes());
    }
    let mut pretok = 1_u32.to_le_bytes().to_vec();
    pretok.push(PretokStepKind::NamedPattern.value());
    pretok.extend_from_slice(&NamedPattern::O200kBase.value().to_le_bytes());
    let mut norm = 1_u32.to_le_bytes().to_vec();
    norm.push(NormStepKind::Nfc.value());
    let document = Document {
        structural_class: StructuralClass::ByteBpe,
        hash_scheme: HashScheme::None,
        flags: 0,
        vocab_size: 256,
        omega: 1,
        sections: vec![
            Section::new(SectionId::Base, base),
            Section::new(SectionId::Arena, (0_u8..=u8::MAX).collect()),
            Section::new(SectionId::Lengths, vec![1; 256]),
            Section::new(SectionId::Specials, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Pretok, pretok),
            Section::new(SectionId::Norm, norm),
        ],
    };
    let bytes = write(&document).unwrap();
    let mut loaded = load_htk_slice(&bytes).unwrap();
    let input = "A\u{030A}";
    let ids = loaded.tokenizer.encode(input);
    assert_eq!(ids, vec![0xC3, 0x85]);
    let tokenizer = match &mut loaded.tokenizer {
        HtkTokenizer::ByteBpe(tokenizer) => tokenizer,
        #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
        HtkTokenizer::SentencePiece(_) => panic!("byte-BPE fixture loaded as SentencePiece"),
    };
    assert_eq!(
        tokenizer.token_starts(input.as_bytes(), &ids).unwrap(),
        vec![0, 0]
    );
}

#[cfg(feature = "htk")]
#[test]
fn cl100k_identifier_reaches_the_cl100k_scanner() {
    let mut source = byte_ranks();
    for (token, rank) in [(b"12".as_slice(), 256), (b"123", 257), (b"1234", 258)] {
        source.extend_from_slice(BASE64_STANDARD.encode(token).as_bytes());
        source.extend_from_slice(format!(" {rank}\n").as_bytes());
    }
    let definition = TiktokenDefinition {
        pattern: NamedPattern::Cl100kBase,
        special_tokens: &[],
    };
    let conversion =
        convert_tiktoken(&source, Sha256::digest(&source).into(), &definition).unwrap();

    let mut loaded = load_htk_slice(&conversion.bytes).unwrap();
    let actual = loaded.tokenizer.encode("1234");

    let mut cl100k = load_tiktoken_slice(&source, PretokenizerType::GPT4, Vec::new()).unwrap();
    let mut expected = Vec::new();
    cl100k.encode_with_added_tokens_flat(b"1234", &mut expected);

    let mut gpt2 = load_tiktoken_slice(&source, PretokenizerType::GPT2, Vec::new()).unwrap();
    let mut wrong_route = Vec::new();
    gpt2.encode_with_added_tokens_flat(b"1234", &mut wrong_route);

    assert_eq!(actual, expected);
    assert_eq!(actual, [257, u32::from(b'4')]);
    assert_eq!(wrong_route, [258]);
    assert_ne!(actual, wrong_route, "fixture must have routing teeth");
}

fn gpt2_byte_char(byte: u8) -> char {
    let visible = (b'!'..=b'~')
        .chain(0xA1..=0xAC)
        .chain(0xAE..=u8::MAX)
        .collect::<Vec<_>>();
    if visible.contains(&byte) {
        return char::from(byte);
    }
    let offset = (0u8..byte)
        .filter(|candidate| !visible.contains(candidate))
        .count();
    char::from_u32(256 + u32::try_from(offset).unwrap()).unwrap()
}
