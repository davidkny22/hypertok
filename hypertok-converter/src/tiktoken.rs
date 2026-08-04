use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use hypertok_format::{
    DIGEST_RANGE, HashScheme, MAX_VOCAB_SIZE, NamedPattern, PretokStepKind, SectionId,
    StructuralClass, ValidatedFile, encode_u32,
};
use sha2::{Digest, Sha256};

use crate::{Document, Section, WriteError, write};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpecialToken<'a> {
    pub bytes: &'a [u8],
    pub id: u32,
    pub flags: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TiktokenDefinition<'a> {
    pub pattern: NamedPattern,
    pub special_tokens: &'a [SpecialToken<'a>],
}

#[derive(Debug)]
pub struct Conversion {
    pub bytes: Vec<u8>,
    pub source_token_count: u32,
    pub special_token_count: u32,
    pub vocab_size: u32,
    pub key_set_size: u32,
    pub gap_count: u32,
    pub omega: u32,
    pub digest: [u8; 32],
    pub priority_present: bool,
    pub priority_inversions: u32,
}

#[derive(Debug)]
pub enum ConvertError {
    SourceDigestMismatch,
    MalformedLine(usize),
    InvalidBase64(usize),
    InvalidRank(usize),
    EmptyToken(usize),
    NonContiguousRank { expected: u32, actual: u32 },
    DuplicateToken { first: u32, second: u32 },
    DuplicateSpecialId(u32),
    DuplicateSpecialBytes,
    SpecialIdCollision(u32),
    MissingByte(u8),
    VocabTooLarge(u32),
    SizeOverflow,
    Write(WriteError),
    RoundTripId(u32),
    RoundTripLookup(u32),
}

impl fmt::Display for ConvertError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SourceDigestMismatch => {
                formatter.write_str("source SHA-256 does not match the pinned digest")
            }
            Self::MalformedLine(line) => write!(
                formatter,
                "rank file line {line} does not contain exactly two fields"
            ),
            Self::InvalidBase64(line) => {
                write!(formatter, "rank file line {line} has invalid base64")
            }
            Self::InvalidRank(line) => {
                write!(formatter, "rank file line {line} has an invalid u32 rank")
            }
            Self::EmptyToken(line) => {
                write!(formatter, "rank file line {line} decodes to an empty token")
            }
            Self::NonContiguousRank { expected, actual } => write!(
                formatter,
                "rank sequence expected {expected}, found {actual}"
            ),
            Self::DuplicateToken { first, second } => write!(
                formatter,
                "ranks {first} and {second} decode to the same token bytes"
            ),
            Self::DuplicateSpecialId(id) => {
                write!(formatter, "special token id {id} appears more than once")
            }
            Self::DuplicateSpecialBytes => {
                formatter.write_str("two special tokens have identical bytes")
            }
            Self::SpecialIdCollision(id) => write!(
                formatter,
                "special token id {id} collides with a mergeable rank"
            ),
            Self::MissingByte(byte) => {
                write!(formatter, "byte value {byte} has no one-byte base token")
            }
            Self::VocabTooLarge(size) => write!(formatter, "vocabulary size {size} exceeds 2^28"),
            Self::SizeOverflow => {
                formatter.write_str("converted vocabulary size overflows an addressable field")
            }
            Self::Write(error) => write!(formatter, "format emission failed: {error}"),
            Self::RoundTripId(id) => write!(
                formatter,
                "emitted token bytes disagree with the source at id {id}"
            ),
            Self::RoundTripLookup(id) => write!(
                formatter,
                "emitted bytes-to-id lookup disagrees with source id {id}"
            ),
        }
    }
}

impl std::error::Error for ConvertError {}

pub fn convert_tiktoken(
    source: &[u8],
    expected_source_digest: [u8; 32],
    definition: &TiktokenDefinition<'_>,
) -> Result<Conversion, ConvertError> {
    let actual_source_digest: [u8; 32] = Sha256::digest(source).into();
    if actual_source_digest != expected_source_digest {
        return Err(ConvertError::SourceDigestMismatch);
    }

    let ordinary = parse_ranks(source)?;
    let ordinary_count = u32::try_from(ordinary.len()).map_err(|_| ConvertError::SizeOverflow)?;
    validate_specials(definition.special_tokens, ordinary_count)?;

    let highest_special = definition.special_tokens.iter().map(|token| token.id).max();
    let highest_id = highest_special
        .into_iter()
        .chain(ordinary_count.checked_sub(1))
        .max()
        .ok_or(ConvertError::MissingByte(0))?;
    let vocab_size = highest_id
        .checked_add(1)
        .ok_or(ConvertError::SizeOverflow)?;
    if vocab_size > MAX_VOCAB_SIZE {
        return Err(ConvertError::VocabTooLarge(vocab_size));
    }

    let mut base = [None; 256];
    for (id, token) in ordinary.iter().enumerate() {
        if token.len() == 1 {
            base[token[0] as usize] = Some(id as u32);
        }
    }
    let mut base_bytes = Vec::with_capacity(256 * 4);
    for (byte, id) in base.into_iter().enumerate() {
        let id = id.ok_or(ConvertError::MissingByte(byte as u8))?;
        base_bytes.extend_from_slice(&id.to_le_bytes());
    }

    let mut slots = vec![None; vocab_size as usize];
    for (id, token) in ordinary.into_iter().enumerate() {
        slots[id] = Some(token);
    }
    for special in definition.special_tokens {
        if slots[special.id as usize].is_some() {
            return Err(ConvertError::SpecialIdCollision(special.id));
        }
        slots[special.id as usize] = Some(special.bytes.to_vec());
    }

    let mut arena_len = 0_usize;
    let mut omega = 0_u32;
    for token in slots.iter().flatten() {
        arena_len = arena_len
            .checked_add(token.len())
            .ok_or(ConvertError::SizeOverflow)?;
        omega = omega.max(u32::try_from(token.len()).map_err(|_| ConvertError::SizeOverflow)?);
    }
    let mut arena = Vec::with_capacity(arena_len);
    let mut lengths = Vec::with_capacity(vocab_size as usize);
    for token in &slots {
        let length = token.as_ref().map_or(0, Vec::len);
        let length = u32::try_from(length).map_err(|_| ConvertError::SizeOverflow)?;
        encode_u32(length, &mut lengths);
        if let Some(token) = token {
            arena.extend_from_slice(token);
        }
    }

    let specials = encode_specials(definition.special_tokens);
    let mut pretok = Vec::with_capacity(9);
    pretok.extend_from_slice(&1_u32.to_le_bytes());
    pretok.push(PretokStepKind::NamedPattern.value());
    pretok.extend_from_slice(&definition.pattern.value().to_le_bytes());

    let document = Document {
        structural_class: StructuralClass::ByteBpe,
        hash_scheme: HashScheme::None,
        flags: 0,
        vocab_size,
        omega,
        sections: vec![
            Section::new(SectionId::Base, base_bytes),
            Section::new(SectionId::Arena, arena),
            Section::new(SectionId::Lengths, lengths),
            Section::new(SectionId::Specials, specials),
            Section::new(SectionId::Pretok, pretok),
            Section::new(SectionId::Decoder, 0_u32.to_le_bytes().to_vec()),
        ],
    };
    let bytes = write(&document).map_err(ConvertError::Write)?;
    verify_mapping(&bytes, &slots, ordinary_count)?;
    let file = ValidatedFile::read(&bytes)
        .map_err(|error| ConvertError::Write(WriteError::SelfValidation(error)))?;
    let digest = file.header().digest;
    debug_assert_eq!(&bytes[DIGEST_RANGE], digest);

    let special_token_count =
        u32::try_from(definition.special_tokens.len()).map_err(|_| ConvertError::SizeOverflow)?;
    Ok(Conversion {
        bytes,
        source_token_count: ordinary_count,
        special_token_count,
        vocab_size,
        key_set_size: ordinary_count,
        gap_count: vocab_size - ordinary_count - special_token_count,
        omega,
        digest,
        priority_present: false,
        priority_inversions: 0,
    })
}

fn parse_ranks(source: &[u8]) -> Result<Vec<Vec<u8>>, ConvertError> {
    let content = source.strip_suffix(b"\n").unwrap_or(source);
    let mut rows = Vec::new();
    for (zero_based, raw_line) in content.split(|byte| *byte == b'\n').enumerate() {
        let line_number = zero_based + 1;
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        let mut fields = line
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|field| !field.is_empty());
        let encoded = fields
            .next()
            .ok_or(ConvertError::MalformedLine(line_number))?;
        let rank_bytes = fields
            .next()
            .ok_or(ConvertError::MalformedLine(line_number))?;
        if fields.next().is_some() {
            return Err(ConvertError::MalformedLine(line_number));
        }
        let token = STANDARD
            .decode(encoded)
            .map_err(|_| ConvertError::InvalidBase64(line_number))?;
        if token.is_empty() {
            return Err(ConvertError::EmptyToken(line_number));
        }
        let rank = std::str::from_utf8(rank_bytes)
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or(ConvertError::InvalidRank(line_number))?;
        rows.push((rank, token));
    }

    rows.sort_unstable_by_key(|(rank, _)| *rank);
    for (expected, (actual, _)) in rows.iter().enumerate() {
        let expected = u32::try_from(expected).map_err(|_| ConvertError::SizeOverflow)?;
        if expected != *actual {
            return Err(ConvertError::NonContiguousRank {
                expected,
                actual: *actual,
            });
        }
    }

    let mut seen: BTreeMap<&[u8], u32> = BTreeMap::new();
    for (rank, token) in &rows {
        if let Some(first) = seen.insert(token, *rank) {
            return Err(ConvertError::DuplicateToken {
                first,
                second: *rank,
            });
        }
    }
    Ok(rows.into_iter().map(|(_, token)| token).collect())
}

fn validate_specials(
    specials: &[SpecialToken<'_>],
    ordinary_count: u32,
) -> Result<(), ConvertError> {
    let mut ids = BTreeSet::new();
    let mut bytes = BTreeSet::new();
    for special in specials {
        if special.id < ordinary_count {
            return Err(ConvertError::SpecialIdCollision(special.id));
        }
        if !ids.insert(special.id) {
            return Err(ConvertError::DuplicateSpecialId(special.id));
        }
        if !bytes.insert(special.bytes) {
            return Err(ConvertError::DuplicateSpecialBytes);
        }
    }
    Ok(())
}

fn encode_specials(specials: &[SpecialToken<'_>]) -> Vec<u8> {
    let mut entries: Vec<_> = specials.iter().collect();
    entries.sort_unstable_by_key(|special| special.id);
    let mut output = Vec::new();
    output.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for special in entries {
        output.extend_from_slice(&special.id.to_le_bytes());
        output.extend_from_slice(&(special.bytes.len() as u32).to_le_bytes());
        output.extend_from_slice(special.bytes);
        output.extend_from_slice(&special.flags.to_le_bytes());
    }
    for special in specials {
        output.extend_from_slice(&special.id.to_le_bytes());
    }
    output
}

fn verify_mapping(
    bytes: &[u8],
    source: &[Option<Vec<u8>>],
    ordinary_count: u32,
) -> Result<(), ConvertError> {
    let file = ValidatedFile::read(bytes)
        .map_err(|error| ConvertError::Write(WriteError::SelfValidation(error)))?;
    let mut lookup = BTreeMap::new();
    for (id, token) in file.tokens() {
        let expected = source[id as usize].as_deref().unwrap_or_default();
        if token != expected {
            return Err(ConvertError::RoundTripId(id));
        }
        if id < ordinary_count {
            lookup.insert(token, id);
        }
    }
    for id in 0..ordinary_count {
        let token = source[id as usize]
            .as_deref()
            .ok_or(ConvertError::RoundTripId(id))?;
        if lookup.get(token) != Some(&id) {
            return Err(ConvertError::RoundTripLookup(id));
        }
    }
    Ok(())
}
