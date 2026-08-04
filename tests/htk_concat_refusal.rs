use hypertok::load_tokenizer::htk::{HtkLoadError, load_htk_slice};
use hypertok_converter::{Document, Section, write};
use hypertok_format::{HashScheme, SectionId, StructuralClass, encode_u32};

#[test]
fn token_with_one_final_merge_loads() {
    let bytes = write(&byte_document(b"ab")).unwrap();
    load_htk_slice(&bytes).unwrap();
}

#[test]
fn token_without_one_final_merge_is_refused() {
    let bytes = write(&byte_document(b"abc")).unwrap();
    assert!(matches!(
        load_htk_slice(&bytes),
        Err(HtkLoadError::InvalidModel(
            "token does not reconstruct from one final merge"
        ))
    ));
}

fn byte_document(product: &[u8]) -> Document {
    let mut tokens = (0_u8..=255).map(|byte| vec![byte]).collect::<Vec<_>>();
    tokens.push(product.to_vec());
    let arena = tokens.iter().flatten().copied().collect::<Vec<_>>();
    let mut lengths = Vec::new();
    for token in &tokens {
        encode_u32(token.len() as u32, &mut lengths);
    }
    let mut base = Vec::with_capacity(256 * 4);
    for id in 0_u32..256 {
        base.extend_from_slice(&id.to_le_bytes());
    }
    Document {
        structural_class: StructuralClass::ByteBpe,
        hash_scheme: HashScheme::None,
        flags: 0,
        vocab_size: tokens.len() as u32,
        omega: product.len() as u32,
        sections: vec![
            Section::new(SectionId::Base, base),
            Section::new(SectionId::Arena, arena),
            Section::new(SectionId::Lengths, lengths),
            Section::new(SectionId::Specials, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Pretok, byte_pretok()),
            Section::new(SectionId::Norm, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Decoder, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Post, 0_u32.to_le_bytes().to_vec()),
        ],
    }
}

fn byte_pretok() -> Vec<u8> {
    let mut bytes = 1_u32.to_le_bytes().to_vec();
    bytes.push(0);
    bytes.extend_from_slice(&1_u32.to_le_bytes());
    bytes
}
