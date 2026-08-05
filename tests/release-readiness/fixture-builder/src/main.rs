use hypertok_converter::{Document, Section, write};
use hypertok_format::{HashScheme, SectionId, StructuralClass, encode_u32};
use std::env;
use std::fs;
use std::path::PathBuf;

fn push_string(output: &mut Vec<u8>, value: &str) {
    output.extend_from_slice(&(value.len() as u32).to_le_bytes());
    output.extend_from_slice(value.as_bytes());
}

fn decoder() -> Vec<u8> {
    let mut bytes = 3_u32.to_le_bytes().to_vec();
    bytes.push(0);
    push_string(&mut bytes, "\u{2581}");
    push_string(&mut bytes, " ");
    bytes.extend_from_slice(&[1, 2]);
    bytes
}

fn specials() -> Vec<u8> {
    let entries: [(u32, &[u8]); 2] = [(259, b"<s>"), (260, b"</s>")];
    let mut bytes = (entries.len() as u32).to_le_bytes().to_vec();
    for (id, token) in entries {
        bytes.extend_from_slice(&id.to_le_bytes());
        bytes.extend_from_slice(&(token.len() as u32).to_le_bytes());
        bytes.extend_from_slice(token);
        bytes.extend_from_slice(&0_u32.to_le_bytes());
    }
    for (id, _) in entries {
        bytes.extend_from_slice(&id.to_le_bytes());
    }
    bytes
}

fn fixture() -> Vec<u8> {
    let mut tokens = (0_u8..=255).map(|byte| vec![byte]).collect::<Vec<_>>();
    tokens.extend([
        b"a".to_vec(),
        b"b".to_vec(),
        b"ab".to_vec(),
        b"<s>".to_vec(),
        b"</s>".to_vec(),
    ]);
    let arena = tokens.iter().flatten().copied().collect::<Vec<_>>();
    let mut lengths = Vec::new();
    for token in &tokens {
        encode_u32(token.len() as u32, &mut lengths);
    }
    let mut base = 2_u32.to_le_bytes().to_vec();
    base.extend_from_slice(&(b'a' as u32).to_le_bytes());
    base.extend_from_slice(&256_u32.to_le_bytes());
    base.extend_from_slice(&(b'b' as u32).to_le_bytes());
    base.extend_from_slice(&257_u32.to_le_bytes());
    let mut byte_fallback = Vec::with_capacity(256 * 4);
    for id in 0_u32..256 {
        byte_fallback.extend_from_slice(&id.to_le_bytes());
    }
    let mut post = 1_u32.to_le_bytes().to_vec();
    post.push(0);
    post.extend_from_slice(&259_u32.to_le_bytes());
    let mut unknown = 260_u32.to_le_bytes().to_vec();
    unknown.push(0);
    write(&Document {
        structural_class: StructuralClass::SentencePieceBpe,
        hash_scheme: HashScheme::None,
        flags: 0,
        vocab_size: tokens.len() as u32,
        omega: 4,
        sections: vec![
            Section::new(SectionId::Base, base),
            Section::new(SectionId::Arena, arena),
            Section::new(SectionId::Lengths, lengths),
            Section::new(SectionId::Specials, specials()),
            Section::new(SectionId::Pretok, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Norm, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Decoder, decoder()),
            Section::new(SectionId::Post, post),
            Section::new(SectionId::ByteFall, byte_fallback),
            Section::new(SectionId::Unk, unknown),
        ],
    })
    .expect("synthetic sentencepiece fixture must be valid")
}

fn main() {
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .expect("output path is required");
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).expect("create fixture directory");
    }
    fs::write(&output, fixture()).expect("write sentencepiece fixture");
    println!("{}", output.display());
}
