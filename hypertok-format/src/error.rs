use core::fmt;

use crate::SectionId;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VarintError {
    UnexpectedEnd,
    NonCanonical,
    Overflow,
}

impl fmt::Display for VarintError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedEnd => formatter.write_str("varint ended before its terminating byte"),
            Self::NonCanonical => {
                formatter.write_str("varint is not in canonical unsigned LEB128 form")
            }
            Self::Overflow => formatter.write_str("varint exceeds u32"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReadError {
    FileTooShort {
        actual: usize,
    },
    MagicMismatch,
    UnsupportedVersion(u16),
    UnknownStructuralClass(u8),
    UnknownLayout(u8),
    UnknownHashScheme(u8),
    ReservedHeader(u16),
    VocabTooLarge(u32),
    SectionTableOutOfBounds,
    SectionTableOverlapsHeader,
    UnknownSection(u32),
    DuplicateSection(u32),
    MissingSection(SectionId),
    ForbiddenSection {
        section: SectionId,
        class: u8,
    },
    SectionOutOfBounds(u32),
    SectionOverlapsMetadata(u32),
    SectionsOverlap {
        first: u32,
        second: u32,
    },
    MisalignedSection(u32),
    SectionLengthMismatch(u32),
    DuplicateSectionEntry {
        section: u32,
        id: u32,
    },
    IdOutOfRange {
        section: u32,
        id: u32,
    },
    UnsortedBase,
    SpecialBytesMismatch(u32),
    UnknownPretokStep(u8),
    UnknownNamedPattern(u32),
    InvalidPretokFlags(u8),
    InvalidMetaspaceReplacement(u32),
    UnknownNormStep(u8),
    UnknownDecoderStep(u8),
    InvalidUnicodeScalar {
        section: u32,
        value: u32,
    },
    UnknownPostPosition(u8),
    InvalidUtf8Section(u32),
    InvalidFlagValue {
        section: u32,
        value: u8,
    },
    Varint {
        section: u32,
        index: u32,
        error: VarintError,
    },
    ArenaOffsetOverflow,
    ArenaIndexOutOfBounds {
        id: u32,
        offset: u64,
        length: u32,
        arena_length: u64,
    },
    LengthSumMismatch {
        expected: u64,
        actual: u64,
    },
    OmegaMismatch {
        expected: u32,
        actual: u32,
    },
    DigestMismatch,
}

impl fmt::Display for ReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FileTooShort { actual } => write!(
                formatter,
                "file is {actual} bytes, shorter than the 64-byte header"
            ),
            Self::MagicMismatch => formatter.write_str("file magic does not match HTKVOCAB"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "format version {version} is unsupported")
            }
            Self::UnknownStructuralClass(class) => {
                write!(formatter, "structural class {class} is unknown")
            }
            Self::UnknownLayout(layout) => write!(formatter, "layout {layout} is unknown"),
            Self::UnknownHashScheme(scheme) => write!(formatter, "hash scheme {scheme} is unknown"),
            Self::ReservedHeader(value) => {
                write!(formatter, "reserved header bytes are nonzero: {value}")
            }
            Self::VocabTooLarge(size) => write!(formatter, "vocabulary size {size} exceeds 2^28"),
            Self::SectionTableOutOfBounds => {
                formatter.write_str("section table extends outside the file")
            }
            Self::SectionTableOverlapsHeader => {
                formatter.write_str("section table overlaps the file header")
            }
            Self::UnknownSection(id) => {
                write!(formatter, "section id {id} is reserved and unknown")
            }
            Self::DuplicateSection(id) => {
                write!(formatter, "section id {id} appears more than once")
            }
            Self::MissingSection(id) => {
                write!(formatter, "required section {} is absent", id.value())
            }
            Self::ForbiddenSection { section, class } => write!(
                formatter,
                "section {} is forbidden for structural class {class}",
                section.value()
            ),
            Self::SectionOutOfBounds(id) => {
                write!(formatter, "section {id} extends outside the file")
            }
            Self::SectionOverlapsMetadata(id) => write!(
                formatter,
                "section {id} overlaps the header or section table"
            ),
            Self::SectionsOverlap { first, second } => {
                write!(formatter, "sections {first} and {second} overlap")
            }
            Self::MisalignedSection(id) => {
                write!(formatter, "section {id} is not aligned to 8 bytes")
            }
            Self::SectionLengthMismatch(id) => {
                write!(formatter, "section {id} length does not match its contents")
            }
            Self::DuplicateSectionEntry { section, id } => {
                write!(formatter, "section {section} contains duplicate id {id}")
            }
            Self::IdOutOfRange { section, id } => write!(
                formatter,
                "section {section} references out-of-range id {id}"
            ),
            Self::UnsortedBase => formatter
                .write_str("sentencepiece BASE entries are not strictly sorted by codepoint"),
            Self::SpecialBytesMismatch(id) => write!(
                formatter,
                "SPECIALS bytes disagree with arena bytes for id {id}"
            ),
            Self::UnknownPretokStep(kind) => {
                write!(formatter, "PRETOK step kind {kind} is unknown")
            }
            Self::UnknownNamedPattern(id) => {
                write!(formatter, "PRETOK named pattern id {id} is unknown")
            }
            Self::InvalidPretokFlags(flags) => {
                write!(
                    formatter,
                    "PRETOK byte-level flags contain unknown bits: {flags}"
                )
            }
            Self::InvalidMetaspaceReplacement(value) => {
                write!(
                    formatter,
                    "PRETOK metaspace replacement {value} is not a Unicode scalar"
                )
            }
            Self::UnknownNormStep(kind) => write!(formatter, "NORM step kind {kind} is unknown"),
            Self::UnknownDecoderStep(kind) => {
                write!(formatter, "DECODER step kind {kind} is unknown")
            }
            Self::InvalidUnicodeScalar { section, value } => write!(
                formatter,
                "section {section} contains invalid Unicode scalar {value}"
            ),
            Self::UnknownPostPosition(position) => {
                write!(formatter, "POST position {position} is unknown")
            }
            Self::InvalidUtf8Section(section) => {
                write!(formatter, "section {section} contains invalid UTF-8")
            }
            Self::InvalidFlagValue { section, value } => {
                write!(
                    formatter,
                    "section {section} contains invalid flag value {value}"
                )
            }
            Self::Varint {
                section,
                index,
                error,
            } => write!(formatter, "section {section} varint {index}: {error}"),
            Self::ArenaOffsetOverflow => {
                formatter.write_str("token lengths exceed the u32 arena offset range")
            }
            Self::ArenaIndexOutOfBounds {
                id,
                offset,
                length,
                arena_length,
            } => write!(
                formatter,
                "token id {id} spans {offset}+{length} outside arena length {arena_length}"
            ),
            Self::LengthSumMismatch { expected, actual } => write!(
                formatter,
                "token lengths sum to {actual}, arena length is {expected}"
            ),
            Self::OmegaMismatch { expected, actual } => write!(
                formatter,
                "omega is {actual}, maximum token length is {expected}"
            ),
            Self::DigestMismatch => formatter.write_str("whole-file digest does not match"),
        }
    }
}

impl std::error::Error for ReadError {}
