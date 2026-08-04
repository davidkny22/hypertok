use hypertok_converter::{Document, Section, WriteError, write};
use hypertok_format::{
    DIGEST_RANGE, HashScheme, ReadError, SectionId, StructuralClass, ValidatedFile, VarintError,
    compute_digest, encode_u32,
};

#[test]
fn byte_bpe_emission_is_deterministic_and_self_validating() {
    let mut document = byte_bpe_document();
    document.sections.reverse();
    let reversed = write(&document).expect("valid byte BPE file");
    document.sections.reverse();
    let forward = write(&document).expect("valid byte BPE file");
    assert_eq!(reversed, forward);

    let file = ValidatedFile::read(&forward).expect("writer output reads back");
    assert_eq!(file.header().vocab_size, 256);
    assert_eq!(file.header().omega, 1);
    assert_eq!(file.lengths().collect::<Vec<_>>(), vec![1; 256]);
    assert_eq!(&forward[DIGEST_RANGE], compute_digest(&forward));
}

#[test]
fn sentencepiece_class_accepts_byte_fallback_collisions() {
    let bytes = write(&sentencepiece_document()).expect("valid sentencepiece file");
    let file = ValidatedFile::read(&bytes).expect("sentencepiece file reads back");
    assert_eq!(
        file.header().structural_class,
        StructuralClass::SentencePieceBpe
    );
    assert!(file.section(SectionId::ByteFall.value()).is_some());
}

#[test]
fn streaming_sections_precede_arena_and_all_payloads_are_aligned() {
    let mut document = byte_bpe_document();
    document.hash_scheme = HashScheme::Fmphgo;
    document
        .sections
        .push(Section::new(SectionId::Hash, vec![7; 16]));
    let bytes = write(&document).expect("valid indexed file");
    let file = ValidatedFile::read(&bytes).expect("indexed file reads back");
    let lengths = file
        .section_entry(SectionId::Lengths.value())
        .unwrap()
        .offset;
    let hash = file.section_entry(SectionId::Hash.value()).unwrap().offset;
    let arena = file.section_entry(SectionId::Arena.value()).unwrap().offset;
    assert!(lengths < hash && hash < arena);
    assert!(file.sections().all(|entry| entry.offset % 8 == 0));
}

#[test]
fn reader_reports_structural_and_varint_failures_without_partial_value() {
    let valid = write(&byte_bpe_document()).expect("fixture");

    let mut bad_magic = valid.clone();
    bad_magic[0] ^= 1;
    assert_eq!(
        ValidatedFile::read(&bad_magic).unwrap_err(),
        ReadError::MagicMismatch
    );

    let mut reserved = valid.clone();
    reserved[14] = 1;
    reseal(&mut reserved);
    assert_eq!(
        ValidatedFile::read(&reserved).unwrap_err(),
        ReadError::ReservedHeader(1)
    );

    let mut noncanonical = byte_bpe_document();
    replace_section(&mut noncanonical, SectionId::Lengths, {
        let mut lengths = vec![0x81, 0x00];
        lengths.extend(std::iter::repeat_n(1, 255));
        lengths
    });
    assert!(matches!(
        write(&noncanonical),
        Err(WriteError::SelfValidation(ReadError::Varint {
            section: 3,
            index: 0,
            error: VarintError::NonCanonical,
        }))
    ));
}

#[test]
fn reader_rejects_unknown_pretokenizer_codes() {
    let mut unknown_kind = byte_bpe_document();
    replace_section(&mut unknown_kind, SectionId::Pretok, {
        let mut bytes = 1_u32.to_le_bytes().to_vec();
        bytes.push(255);
        bytes
    });
    assert!(matches!(
        write(&unknown_kind),
        Err(WriteError::SelfValidation(ReadError::UnknownPretokStep(
            255
        )))
    ));

    let mut unknown_pattern = byte_bpe_document();
    replace_section(&mut unknown_pattern, SectionId::Pretok, {
        let mut bytes = 1_u32.to_le_bytes().to_vec();
        bytes.push(0);
        bytes.extend_from_slice(&999_u32.to_le_bytes());
        bytes
    });
    assert!(matches!(
        write(&unknown_pattern),
        Err(WriteError::SelfValidation(ReadError::UnknownNamedPattern(
            999
        )))
    ));
}

#[test]
fn digest_binds_padding_table_and_payload() {
    let valid = write(&byte_bpe_document()).expect("fixture");
    let file = ValidatedFile::read(&valid).expect("fixture reads");
    let mut table_mutation = valid.clone();
    let first = table_mutation[64..80].to_vec();
    let second = table_mutation[80..96].to_vec();
    table_mutation[64..80].copy_from_slice(&second);
    table_mutation[80..96].copy_from_slice(&first);
    assert_eq!(
        ValidatedFile::read(&table_mutation).unwrap_err(),
        ReadError::DigestMismatch
    );

    let mut payload_mutation = valid.clone();
    let arena = file.section_entry(SectionId::Arena.value()).unwrap().offset as usize;
    payload_mutation[arena] ^= 1;
    assert_eq!(
        ValidatedFile::read(&payload_mutation).unwrap_err(),
        ReadError::DigestMismatch
    );
}

#[test]
fn reader_accepts_table_reordering_and_skips_extensions() {
    let mut document = byte_bpe_document();
    document
        .sections
        .push(Section::extension(2048, vec![1, 2, 3]).expect("extension id"));
    let valid = write(&document).expect("fixture with extension");
    let mut reordered = valid.clone();
    let first = reordered[64..80].to_vec();
    let last_start = 64 + (document.sections.len() - 1) * 16;
    let last = reordered[last_start..last_start + 16].to_vec();
    reordered[64..80].copy_from_slice(&last);
    reordered[last_start..last_start + 16].copy_from_slice(&first);
    reseal(&mut reordered);

    let file = ValidatedFile::read(&reordered).expect("table order is not semantic");
    assert_eq!(file.section(2048), Some([1, 2, 3].as_slice()));
}

#[test]
fn reader_types_section_topology_failures() {
    let valid = write(&byte_bpe_document()).expect("fixture");

    let mut unknown = valid.clone();
    set_entry_id(&mut unknown, SectionId::Base.value(), 13);
    reseal(&mut unknown);
    assert_eq!(
        ValidatedFile::read(&unknown).unwrap_err(),
        ReadError::UnknownSection(13)
    );

    let mut duplicate = valid.clone();
    set_entry_id(
        &mut duplicate,
        SectionId::Pretok.value(),
        SectionId::Specials.value(),
    );
    reseal(&mut duplicate);
    assert_eq!(
        ValidatedFile::read(&duplicate).unwrap_err(),
        ReadError::DuplicateSection(SectionId::Specials.value())
    );

    let mut missing = valid.clone();
    set_entry_id(&mut missing, SectionId::Pretok.value(), 2048);
    reseal(&mut missing);
    assert_eq!(
        ValidatedFile::read(&missing).unwrap_err(),
        ReadError::MissingSection(SectionId::Pretok)
    );

    let mut outside = valid.clone();
    let arena_entry = table_entry(&outside, SectionId::Arena.value());
    outside[arena_entry + 8..arena_entry + 16].copy_from_slice(&u64::MAX.to_le_bytes());
    reseal(&mut outside);
    assert_eq!(
        ValidatedFile::read(&outside).unwrap_err(),
        ReadError::SectionOutOfBounds(SectionId::Arena.value())
    );

    let mut overlap = valid.clone();
    let lengths_entry = table_entry(&overlap, SectionId::Lengths.value());
    let lengths_offset = overlap[lengths_entry + 4..lengths_entry + 8].to_vec();
    let arena_entry = table_entry(&overlap, SectionId::Arena.value());
    overlap[arena_entry + 4..arena_entry + 8].copy_from_slice(&lengths_offset);
    reseal(&mut overlap);
    assert!(matches!(
        ValidatedFile::read(&overlap),
        Err(ReadError::SectionsOverlap { .. })
    ));

    let mut misaligned = valid.clone();
    let base_entry = table_entry(&misaligned, SectionId::Base.value());
    let base_offset = u32::from_le_bytes(
        misaligned[base_entry + 4..base_entry + 8]
            .try_into()
            .unwrap(),
    );
    misaligned[base_entry + 4..base_entry + 8].copy_from_slice(&(base_offset + 1).to_le_bytes());
    reseal(&mut misaligned);
    assert_eq!(
        ValidatedFile::read(&misaligned).unwrap_err(),
        ReadError::MisalignedSection(SectionId::Base.value())
    );

    let mut table_in_header = valid;
    table_in_header[28..32].copy_from_slice(&32_u32.to_le_bytes());
    reseal(&mut table_in_header);
    assert_eq!(
        ValidatedFile::read(&table_in_header).unwrap_err(),
        ReadError::SectionTableOverlapsHeader
    );
}

fn byte_bpe_document() -> Document {
    let arena: Vec<u8> = (0..=255).collect();
    let mut base = Vec::with_capacity(256 * 4);
    for id in 0_u32..256 {
        base.extend_from_slice(&id.to_le_bytes());
    }
    Document {
        structural_class: StructuralClass::ByteBpe,
        hash_scheme: HashScheme::None,
        flags: 0,
        vocab_size: 256,
        omega: 1,
        sections: vec![
            Section::new(SectionId::Base, base),
            Section::new(SectionId::Arena, arena),
            Section::new(SectionId::Lengths, vec![1; 256]),
            Section::new(SectionId::Specials, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Pretok, 0_u32.to_le_bytes().to_vec()),
        ],
    }
}

fn sentencepiece_document() -> Document {
    let mut arena: Vec<u8> = (0..=255).collect();
    arena.push(b'a');
    let mut base = Vec::new();
    base.extend_from_slice(&1_u32.to_le_bytes());
    base.extend_from_slice(&(b'a' as u32).to_le_bytes());
    base.extend_from_slice(&256_u32.to_le_bytes());
    let mut byte_fallback = Vec::with_capacity(256 * 4);
    for id in 0_u32..256 {
        byte_fallback.extend_from_slice(&id.to_le_bytes());
    }
    let mut lengths = Vec::new();
    for _ in 0..257 {
        encode_u32(1, &mut lengths);
    }
    Document {
        structural_class: StructuralClass::SentencePieceBpe,
        hash_scheme: HashScheme::None,
        flags: 0,
        vocab_size: 257,
        omega: 1,
        sections: vec![
            Section::new(SectionId::Base, base),
            Section::new(SectionId::Arena, arena),
            Section::new(SectionId::Lengths, lengths),
            Section::new(SectionId::Specials, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::Pretok, 0_u32.to_le_bytes().to_vec()),
            Section::new(SectionId::ByteFall, byte_fallback),
        ],
    }
}

fn replace_section(document: &mut Document, id: SectionId, bytes: Vec<u8>) {
    let section = document
        .sections
        .iter_mut()
        .find(|section| section.id() == id.value())
        .expect("fixture section");
    *section = Section::new(id, bytes);
}

fn reseal(bytes: &mut [u8]) {
    bytes[DIGEST_RANGE.clone()].fill(0);
    let digest = compute_digest(bytes);
    bytes[DIGEST_RANGE].copy_from_slice(&digest);
}

fn table_entry(bytes: &[u8], id: u32) -> usize {
    let count = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
    let start = u32::from_le_bytes(bytes[28..32].try_into().unwrap()) as usize;
    (0..count)
        .map(|index| start + index * 16)
        .find(|offset| u32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap()) == id)
        .expect("fixture table entry")
}

fn set_entry_id(bytes: &mut [u8], old: u32, new: u32) {
    let offset = table_entry(bytes, old);
    bytes[offset..offset + 4].copy_from_slice(&new.to_le_bytes());
}
