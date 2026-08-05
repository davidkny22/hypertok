use hypertok::load_tokenizer::htk::{HtkIndexError, HtkLoadError, load_htk_slice};
use hypertok_converter::{Document, Section, write};
use hypertok_format::{
    DIGEST_RANGE, HashScheme, ReadError, SectionId, StructuralClass, VarintError, compute_digest,
    encode_u32,
};
use hypertok_hash::{ImageError, TableBuildError, build};
use std::env;

const TABLE_ENTRY_LEN: usize = 16;

fn main() {
    let mode = env::var("HYPERTOK_REFUSAL_MODE").unwrap_or_else(|_| "checklist".to_string());
    let fixtures = Fixtures::new();
    match mode.as_str() {
        "checklist" => run_checklist(&fixtures),
        "hash-index-mutation" => {
            refuse(
                "hash_evaluated_index_bounds",
                fixtures.perfect.clone(),
                |error| {
                    matches!(
                        error,
                        HtkLoadError::Index(HtkIndexError::HashIndexOutOfBounds { .. })
                    )
                },
            );
            println!("refusal mutation PASS: hash_evaluated_index_bounds=1/1");
        }
        "payload-id-mutation" => {
            refuse(
                "payload_stored_id_bounds",
                fixtures.perfect.clone(),
                |error| {
                    matches!(
                        error,
                        HtkLoadError::Index(HtkIndexError::PayloadIdOutOfBounds { .. })
                    )
                },
            );
            println!("refusal mutation PASS: payload_stored_id_bounds=1/1");
        }
        value => panic!("unknown mode {value}"),
    }
}

struct Fixtures {
    byte: Vec<u8>,
    plain_byte: Vec<u8>,
    sentencepiece: Vec<u8>,
    perfect: Vec<u8>,
    hash_section: Vec<u8>,
    priority: Vec<u8>,
    byte_with_extension: Vec<u8>,
}

impl Fixtures {
    fn new() -> Self {
        let byte_document = byte_document();
        let byte = write(&byte_document).expect("valid byte fixture");
        let plain_byte = write(&plain_byte_document()).expect("valid plain byte fixture");
        let sentencepiece = write(&sentencepiece_document()).expect("valid sentencepiece fixture");

        let mut perfect_document = byte_document.clone();
        perfect_document.hash_scheme = HashScheme::Fmphgo;
        let keys = byte_tokens()[..258].to_vec();
        let image = build(&keys).expect("fixture hash construction");
        perfect_document
            .sections
            .push(Section::new(SectionId::Hash, image.to_bytes()));
        let perfect = write(&perfect_document).expect("valid perfect-hash fixture");

        let mut hash_document = byte_document.clone();
        hash_document
            .sections
            .push(Section::new(SectionId::Hash, vec![0; 32]));
        let hash_section = write(&hash_document).expect("aligned HASH fixture");

        let mut priority_document = byte_document.clone();
        let mut priorities = vec![0; 256];
        priorities.extend_from_slice(&[1, 2, 0, 0]);
        priority_document
            .sections
            .push(Section::new(SectionId::Priority, priorities));
        let priority = write(&priority_document).expect("aligned PRIORITY fixture");

        let mut extension_document = byte_document;
        extension_document
            .sections
            .push(Section::extension(2048, vec![0; 1024]).expect("available extension section"));
        let byte_with_extension = write(&extension_document).expect("extension fixture");

        Self {
            byte,
            plain_byte,
            sentencepiece,
            perfect,
            hash_section,
            priority,
            byte_with_extension,
        }
    }
}

fn run_checklist(fixtures: &Fixtures) {
    accept("valid_byte_bpe", fixtures.byte.clone(), 256);
    accept(
        "valid_sentencepiece_bpe",
        fixtures.sentencepiece.clone(),
        258,
    );
    accept("known_perfect_hash", fixtures.perfect.clone(), 256);
    accept(
        "extension_section_at_or_above_1024",
        fixtures.byte_with_extension.clone(),
        256,
    );

    let mut count = 0_u32;
    macro_rules! case {
        ($name:literal, $bytes:expr, $pattern:pat $(if $guard:expr)? ) => {{
            refuse($name, $bytes, |error| matches!(error, $pattern $(if $guard)?));
            count += 1;
        }};
    }

    case!(
        "magic_mismatch",
        mutate(&fixtures.byte, false, |bytes| bytes[0] ^= 1),
        HtkLoadError::Format(ReadError::MagicMismatch)
    );
    case!(
        "unsupported_format_version",
        mutate(&fixtures.byte, false, |bytes| put_u16(bytes, 8, 2)),
        HtkLoadError::Format(ReadError::UnsupportedVersion(2))
    );
    case!(
        "unrecognized_structural_class",
        mutate(&fixtures.byte, false, |bytes| bytes[10] = 2),
        HtkLoadError::Format(ReadError::UnknownStructuralClass(2))
    );
    case!(
        "unrecognized_layout",
        mutate(&fixtures.byte, false, |bytes| bytes[11] = 1),
        HtkLoadError::Format(ReadError::UnknownLayout(1))
    );
    case!(
        "unrecognized_hash_scheme",
        mutate(&fixtures.byte, false, |bytes| bytes[12] = 2),
        HtkLoadError::Format(ReadError::UnknownHashScheme(2))
    );
    case!(
        "unrecognized_pretok_step_kind",
        mutate_section(&fixtures.byte, SectionId::Pretok, |section| section[4] =
            255),
        HtkLoadError::Format(ReadError::UnknownPretokStep(255))
    );
    case!(
        "unrecognized_norm_step_kind",
        mutate_section(&fixtures.byte, SectionId::Norm, |section| section[4] = 255),
        HtkLoadError::Format(ReadError::UnknownNormStep(255))
    );
    case!(
        "unrecognized_section_below_1024",
        mutate(&fixtures.byte, true, |bytes| set_entry_id(
            bytes,
            SectionId::Decoder.value(),
            13
        )),
        HtkLoadError::Format(ReadError::UnknownSection(13))
    );
    case!(
        "duplicate_section_ids",
        mutate(&fixtures.byte, true, |bytes| {
            set_entry_id(bytes, SectionId::Decoder.value(), SectionId::Pretok.value())
        }),
        HtkLoadError::Format(ReadError::DuplicateSection(id)) if *id == SectionId::Pretok.value()
    );
    case!(
        "required_section_absent",
        mutate(&fixtures.byte, true, |bytes| set_entry_id(
            bytes,
            SectionId::Pretok.value(),
            2048
        )),
        HtkLoadError::Format(ReadError::MissingSection(SectionId::Pretok))
    );
    case!(
        "section_range_exceeds_buffer_u64",
        mutate(&fixtures.byte, true, |bytes| {
            let entry = table_entry(bytes, SectionId::Arena.value());
            put_u64(bytes, entry + 8, u64::MAX);
        }),
        HtkLoadError::Format(ReadError::SectionOutOfBounds(id)) if *id == SectionId::Arena.value()
    );
    case!(
        "section_content_length_mismatch",
        mutate_section(&fixtures.byte, SectionId::Pretok, |section| put_u32(section, 0, 3)),
        HtkLoadError::Format(ReadError::SectionLengthMismatch(id)) if *id == SectionId::Pretok.value()
    );
    case!(
        "sections_overlap",
        mutate(&fixtures.byte, true, |bytes| {
            let lengths = section_offset(bytes, SectionId::Lengths);
            let arena_entry = table_entry(bytes, SectionId::Arena.value());
            put_u32(bytes, arena_entry + 4, lengths as u32);
        }),
        HtkLoadError::Format(ReadError::SectionsOverlap { .. })
    );
    case!(
        "section_table_past_buffer",
        mutate(&fixtures.byte, false, |bytes| put_u32(bytes, 24, u32::MAX)),
        HtkLoadError::Format(ReadError::SectionTableOutOfBounds)
    );
    misalignment_case(&fixtures.byte, SectionId::Base, "base_misaligned");
    count += 1;
    misalignment_case(
        &fixtures.sentencepiece,
        SectionId::ByteFall,
        "bytefall_misaligned",
    );
    count += 1;
    misalignment_case(&fixtures.hash_section, SectionId::Hash, "hash_misaligned");
    count += 1;
    misalignment_case(
        &fixtures.priority,
        SectionId::Priority,
        "priority_misaligned",
    );
    count += 1;
    case!(
        "reserved_header_nonzero",
        mutate(&fixtures.byte, true, |bytes| bytes[14] = 1),
        HtkLoadError::Format(ReadError::ReservedHeader(1))
    );
    case!(
        "vocab_size_over_limit",
        mutate(&fixtures.byte, false, |bytes| put_u32(bytes, 16, (1 << 28) + 1)),
        HtkLoadError::Format(ReadError::VocabTooLarge(value)) if *value == (1 << 28) + 1
    );
    case!(
        "arena_index_outside",
        mutate_section(&fixtures.byte, SectionId::Lengths, |section| section[0] =
            127),
        HtkLoadError::Format(ReadError::ArenaIndexOutOfBounds { .. })
    );
    case!(
        "noncanonical_varint",
        mutate_section(&fixtures.byte, SectionId::Lengths, |section| {
            section[0] = 0x81;
            section[1] = 0;
        }),
        HtkLoadError::Format(ReadError::Varint {
            error: VarintError::NonCanonical,
            ..
        })
    );
    case!(
        "u32_overflow_varint",
        mutate_section(&fixtures.byte, SectionId::Lengths, |section| {
            section[..5].copy_from_slice(&[0xff, 0xff, 0xff, 0xff, 0x10]);
        }),
        HtkLoadError::Format(ReadError::Varint {
            error: VarintError::Overflow,
            ..
        })
    );
    case!(
        "length_sum_mismatch",
        mutate_section(&fixtures.plain_byte, SectionId::Lengths, |section| {
            section[257] = 1
        }),
        HtkLoadError::Format(ReadError::LengthSumMismatch { .. })
    );
    case!(
        "forbidden_section_for_class",
        mutate(&fixtures.byte_with_extension, true, |bytes| set_entry_id(
            bytes,
            2048,
            SectionId::ByteFall.value()
        )),
        HtkLoadError::Format(ReadError::ForbiddenSection {
            section: SectionId::ByteFall,
            class: 0
        })
    );
    case!(
        "class_required_section_absent",
        mutate(&fixtures.sentencepiece, true, |bytes| set_entry_id(
            bytes,
            SectionId::ByteFall.value(),
            2048
        )),
        HtkLoadError::Format(ReadError::MissingSection(SectionId::ByteFall))
    );
    case!(
        "duplicate_ids_in_section_entry_list",
        mutate_section(&fixtures.byte, SectionId::Specials, |section| {
            let second_precedence = section.len() - 4;
            put_u32(section, second_precedence, 258);
        }),
        HtkLoadError::Format(ReadError::DuplicateSectionEntry { section, id }) if *section == SectionId::Specials.value() && *id == 258
    );
    case!(
        "duplicate_lookup_key_bytes",
        mutate_section(&fixtures.byte, SectionId::Arena, |arena| arena[259] = b'b'),
        HtkLoadError::Index(HtkIndexError::Table(TableBuildError::DuplicateKey))
    );
    case!(
        "missing_byte_base_token",
        mutate_section(&fixtures.byte, SectionId::Base, |base| {
            put_u32(base, 0, 1);
            put_u32(base, 4, 0);
        }),
        HtkLoadError::InvalidModel("BASE id does not denote its indexed byte")
    );
    id_out_of_range_case(fixtures, SectionId::Specials, "specials_id_out_of_range");
    count += 1;
    id_out_of_range_case(fixtures, SectionId::Base, "base_id_out_of_range");
    count += 1;
    id_out_of_range_case(fixtures, SectionId::ByteFall, "bytefall_id_out_of_range");
    count += 1;
    id_out_of_range_case(fixtures, SectionId::Unk, "unk_id_out_of_range");
    count += 1;
    id_out_of_range_case(fixtures, SectionId::Post, "post_id_out_of_range");
    count += 1;
    case!(
        "specials_entry_length_exceeds_section",
        mutate_section(&fixtures.byte, SectionId::Specials, |section| put_u32(section, 8, u32::MAX)),
        HtkLoadError::Format(ReadError::SectionLengthMismatch(id)) if *id == SectionId::Specials.value()
    );
    case!(
        "specials_bytes_disagree_with_arena",
        mutate_section(&fixtures.byte, SectionId::Specials, |section| section
            [12] ^= 1),
        HtkLoadError::Format(ReadError::SpecialBytesMismatch(258))
    );
    case!(
        "sentencepiece_base_unsorted",
        mutate_section(&fixtures.sentencepiece, SectionId::Base, |base| {
            put_u32(base, 4, b'b' as u32);
            put_u32(base, 12, b'a' as u32);
        }),
        HtkLoadError::Format(ReadError::UnsortedBase)
    );
    case!(
        "unknown_named_pattern",
        mutate_section(&fixtures.byte, SectionId::Pretok, |section| put_u32(
            section, 5, 999
        )),
        HtkLoadError::Format(ReadError::UnknownNamedPattern(999))
    );
    case!(
        "omega_mismatch",
        mutate(&fixtures.byte, true, |bytes| put_u32(bytes, 20, 2)),
        HtkLoadError::Format(ReadError::OmegaMismatch { .. })
    );
    case!(
        "digest_mismatch",
        mutate(&fixtures.byte, false, |bytes| bytes[DIGEST_RANGE.start] ^=
            1),
        HtkLoadError::Format(ReadError::DigestMismatch)
    );

    case!(
        "scheme_1_hash_section_absent",
        mutate(&fixtures.byte, true, |bytes| bytes[12] =
            HashScheme::Fmphgo as u8),
        HtkLoadError::Index(HtkIndexError::MissingHashSection)
    );
    case!(
        "hash_content_malformed",
        mutate(&fixtures.hash_section, true, |bytes| bytes[12] =
            HashScheme::Fmphgo as u8),
        HtkLoadError::Index(HtkIndexError::HashImage(ImageError::BadMagic))
    );

    println!(
        "refusal checklist PASS: crafted={count}/{count}; accepted_controls=4/4; every refusal returned Err"
    );
}

fn byte_document() -> Document {
    let tokens = byte_tokens();
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
        omega: 3,
        sections: vec![
            Section::new(SectionId::Base, base),
            Section::new(SectionId::Arena, arena),
            Section::new(SectionId::Lengths, lengths),
            Section::new(
                SectionId::Specials,
                specials(&[(258, b"<x>"), (259, b"<y>")]),
            ),
            Section::new(SectionId::Pretok, byte_pretok()),
            Section::new(SectionId::Norm, vec![1, 0, 0, 0, 0]),
            Section::new(SectionId::Decoder, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Post, post(258)),
            Section::new(SectionId::Unk, unk(258)),
        ],
    }
}

fn plain_byte_document() -> Document {
    let tokens = byte_tokens()[..258].to_vec();
    let arena = tokens.iter().flatten().copied().collect::<Vec<_>>();
    let mut lengths = Vec::new();
    for token in &tokens {
        encode_u32(token.len() as u32, &mut lengths);
    }
    let mut document = byte_document();
    document.vocab_size = tokens.len() as u32;
    document.omega = 2;
    document
        .sections
        .retain(|section| !matches!(section.id(), 8 | 11));
    replace_document_section(&mut document, SectionId::Arena, arena);
    replace_document_section(&mut document, SectionId::Lengths, lengths);
    replace_document_section(
        &mut document,
        SectionId::Specials,
        0_u32.to_le_bytes().to_vec(),
    );
    document
}

fn replace_document_section(document: &mut Document, id: SectionId, bytes: Vec<u8>) {
    let section = document
        .sections
        .iter_mut()
        .find(|section| section.id() == id.value())
        .expect("document section");
    *section = Section::new(id, bytes);
}

fn byte_tokens() -> Vec<Vec<u8>> {
    let mut tokens = (0_u8..=255).map(|byte| vec![byte]).collect::<Vec<_>>();
    tokens.extend([
        b"ab".to_vec(),
        b"ac".to_vec(),
        b"<x>".to_vec(),
        b"<y>".to_vec(),
    ]);
    tokens
}

fn sentencepiece_document() -> Document {
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
    let mut base = Vec::new();
    base.extend_from_slice(&2_u32.to_le_bytes());
    base.extend_from_slice(&(b'a' as u32).to_le_bytes());
    base.extend_from_slice(&256_u32.to_le_bytes());
    base.extend_from_slice(&(b'b' as u32).to_le_bytes());
    base.extend_from_slice(&257_u32.to_le_bytes());
    let mut byte_fallback = Vec::with_capacity(256 * 4);
    for id in 0_u32..256 {
        byte_fallback.extend_from_slice(&id.to_le_bytes());
    }
    Document {
        structural_class: StructuralClass::SentencePieceBpe,
        hash_scheme: HashScheme::None,
        flags: 0,
        vocab_size: tokens.len() as u32,
        omega: 4,
        sections: vec![
            Section::new(SectionId::Base, base),
            Section::new(SectionId::Arena, arena),
            Section::new(SectionId::Lengths, lengths),
            Section::new(
                SectionId::Specials,
                specials(&[(259, b"<s>"), (260, b"</s>")]),
            ),
            Section::new(SectionId::Pretok, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Norm, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Decoder, sentencepiece_decoder()),
            Section::new(SectionId::Post, post(259)),
            Section::new(SectionId::ByteFall, byte_fallback),
            Section::new(SectionId::Unk, unk(260)),
        ],
    }
}

fn byte_pretok() -> Vec<u8> {
    let mut bytes = 2_u32.to_le_bytes().to_vec();
    bytes.push(0);
    bytes.extend_from_slice(&1_u32.to_le_bytes());
    bytes.extend_from_slice(&[1, 0b100]);
    bytes
}

fn sentencepiece_decoder() -> Vec<u8> {
    let mut bytes = 3_u32.to_le_bytes().to_vec();
    bytes.push(0);
    push_string(&mut bytes, "▁");
    push_string(&mut bytes, " ");
    bytes.extend_from_slice(&[1, 2]);
    bytes
}

fn push_string(output: &mut Vec<u8>, value: &str) {
    output.extend_from_slice(&(value.len() as u32).to_le_bytes());
    output.extend_from_slice(value.as_bytes());
}

fn specials(entries: &[(u32, &[u8])]) -> Vec<u8> {
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

fn post(id: u32) -> Vec<u8> {
    let mut bytes = 1_u32.to_le_bytes().to_vec();
    bytes.push(0);
    bytes.extend_from_slice(&id.to_le_bytes());
    bytes
}

fn unk(id: u32) -> Vec<u8> {
    let mut bytes = id.to_le_bytes().to_vec();
    bytes.push(0);
    bytes
}

fn refuse(name: &str, bytes: Vec<u8>, expected: impl FnOnce(&HtkLoadError) -> bool) {
    match load_htk_slice(&bytes) {
        Err(error) if expected(&error) => println!("CHECK {name} PASS typed={error}"),
        Err(error) => panic!("CHECK {name} returned the wrong typed error: {error:?}"),
        Ok(_) => panic!("CHECK {name} loaded a tokenizer"),
    }
}

fn accept(name: &str, bytes: Vec<u8>, expected_id: u32) {
    let loaded =
        load_htk_slice(&bytes).unwrap_or_else(|error| panic!("CONTROL {name} failed: {error:?}"));
    assert_eq!(loaded.lookup_index.lookup(b"ab"), Some(expected_id));
    assert_eq!(loaded.lookup_index.lookup(b"not a token"), None);
    println!("CONTROL {name} PASS");
}

fn misalignment_case(source: &[u8], id: SectionId, name: &str) {
    refuse(
        name,
        mutate(source, true, |bytes| {
            let entry = table_entry(bytes, id.value());
            let offset = read_u32(bytes, entry + 4);
            put_u32(bytes, entry + 4, offset - 1);
        }),
        |error| matches!(error, HtkLoadError::Format(ReadError::MisalignedSection(section)) if *section == id.value()),
    );
}

fn id_out_of_range_case(fixtures: &Fixtures, id: SectionId, name: &str) {
    let (source, field) = match id {
        SectionId::Specials => (&fixtures.byte, 4),
        SectionId::Base => (&fixtures.byte, 0),
        SectionId::ByteFall => (&fixtures.sentencepiece, 0),
        SectionId::Unk => (&fixtures.byte, 0),
        SectionId::Post => (&fixtures.byte, 5),
        _ => unreachable!(),
    };
    refuse(
        name,
        mutate_section(source, id, |section| put_u32(section, field, u32::MAX)),
        |error| matches!(error, HtkLoadError::Format(ReadError::IdOutOfRange { section, id: u32::MAX }) if *section == id.value()),
    );
}

fn mutate(source: &[u8], reseal_digest: bool, edit: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut bytes = source.to_vec();
    edit(&mut bytes);
    if reseal_digest {
        reseal(&mut bytes);
    }
    bytes
}

fn mutate_section(source: &[u8], id: SectionId, edit: impl FnOnce(&mut [u8])) -> Vec<u8> {
    mutate(source, true, |bytes| {
        let start = section_offset(bytes, id);
        let length = section_length(bytes, id);
        edit(&mut bytes[start..start + length]);
    })
}

fn reseal(bytes: &mut [u8]) {
    bytes[DIGEST_RANGE.clone()].fill(0);
    let digest = compute_digest(bytes);
    bytes[DIGEST_RANGE.clone()].copy_from_slice(&digest);
}

fn table_entry(bytes: &[u8], id: u32) -> usize {
    let count = read_u32(bytes, 24) as usize;
    let start = read_u32(bytes, 28) as usize;
    (0..count)
        .map(|index| start + index * TABLE_ENTRY_LEN)
        .find(|offset| read_u32(bytes, *offset) == id)
        .unwrap_or_else(|| panic!("fixture section {id} is absent"))
}

fn set_entry_id(bytes: &mut [u8], old: u32, new: u32) {
    let entry = table_entry(bytes, old);
    put_u32(bytes, entry, new);
}

fn section_offset(bytes: &[u8], id: SectionId) -> usize {
    let entry = table_entry(bytes, id.value());
    read_u32(bytes, entry + 4) as usize
}

fn section_length(bytes: &[u8], id: SectionId) -> usize {
    let entry = table_entry(bytes, id.value());
    read_u64(bytes, entry + 8) as usize
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("u32 field"))
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("u64 field"))
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
