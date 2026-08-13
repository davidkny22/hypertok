use base64::{Engine as _, engine::general_purpose::STANDARD};
use hypertok_converter::{ConvertError, SpecialToken, TiktokenDefinition, convert_tiktoken};
use hypertok_format::{NamedPattern, SectionId, ValidatedFile};
use sha2::{Digest, Sha256};

const SPECIALS: [SpecialToken<'static>; 1] = [SpecialToken {
    bytes: b"<s>",
    id: 260,
    flags: 0,
}];

#[test]
fn decoded_rank_bytes_round_trip_in_both_directions() {
    let source = byte_rank_source();
    let definition = definition();
    let conversion = convert_tiktoken(&source, Sha256::digest(&source).into(), &definition)
        .expect("complete rank file converts");
    assert_eq!(conversion.source_token_count, 256);
    assert_eq!(conversion.vocab_size, 261);
    assert_eq!(conversion.key_set_size, 256);
    assert_eq!(conversion.gap_count, 4);
    assert_eq!(conversion.omega, 3);

    let file = ValidatedFile::read(&conversion.bytes).expect("conversion reads back");
    assert_eq!(file.tokens().nth(260), Some((260, b"<s>".as_slice())));
    assert_eq!(
        file.section(SectionId::Decoder.value()),
        Some(0_u32.to_le_bytes().as_slice())
    );
}

#[test]
fn a_rank_gap_is_accepted_only_when_a_declared_special_fills_it() {
    let mut source = byte_rank_source();
    source.extend_from_slice(format!("{} 257\n", STANDARD.encode([0, 1])).as_bytes());
    let specials = [SpecialToken {
        bytes: b"<gap>",
        id: 256,
        flags: 0,
    }];
    let definition = TiktokenDefinition {
        pattern: NamedPattern::Gpt2,
        special_tokens: &specials,
    };
    let conversion = convert_tiktoken(&source, Sha256::digest(&source).into(), &definition)
        .expect("declared special fills the rank gap");
    let file = ValidatedFile::read(&conversion.bytes).expect("conversion reads back");
    assert_eq!(file.tokens().nth(256), Some((256, b"<gap>".as_slice())));
    assert_eq!(conversion.source_token_count, 257);
    assert_eq!(conversion.key_set_size, 257);
    assert_eq!(conversion.gap_count, 0);
}

#[test]
fn no_output_value_exists_after_source_failures() {
    let source = byte_rank_source();
    let definition = definition();
    let mut wrong_digest: [u8; 32] = Sha256::digest(&source).into();
    wrong_digest[0] ^= 1;
    assert!(matches!(
        convert_tiktoken(&source, wrong_digest, &definition),
        Err(ConvertError::SourceDigestMismatch)
    ));

    let mut missing_rank = source.clone();
    let marker = format!("{} 128\n", STANDARD.encode([128]));
    let position = std::str::from_utf8(&missing_rank)
        .unwrap()
        .find(&marker)
        .unwrap();
    missing_rank.drain(position..position + marker.len());
    assert!(matches!(
        convert_tiktoken(
            &missing_rank,
            Sha256::digest(&missing_rank).into(),
            &definition
        ),
        Err(ConvertError::NonContiguousRank {
            expected: 128,
            actual: 129,
        })
    ));
}

#[test]
fn tiktoken_converter_rejects_empty_special_bytes() {
    let source = byte_rank_source();
    let empty_specials = [SpecialToken {
        bytes: b"",
        id: 260,
        flags: 0,
    }];
    let definition = TiktokenDefinition {
        pattern: NamedPattern::O200kBase,
        special_tokens: &empty_specials,
    };

    assert!(matches!(
        convert_tiktoken(&source, Sha256::digest(&source).into(), &definition),
        Err(ConvertError::EmptySpecialBytes)
    ));
}

fn definition() -> TiktokenDefinition<'static> {
    TiktokenDefinition {
        pattern: NamedPattern::O200kBase,
        special_tokens: &SPECIALS,
    }
}

fn byte_rank_source() -> Vec<u8> {
    let mut source = String::new();
    for rank in 0_u32..256 {
        source.push_str(&STANDARD.encode([rank as u8]));
        source.push(' ');
        source.push_str(&rank.to_string());
        source.push('\n');
    }
    source.into_bytes()
}
