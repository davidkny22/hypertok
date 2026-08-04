use crate::ReadError;

pub const MAGIC: [u8; 8] = *b"HTKVOCAB";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 64;
pub const SECTION_TABLE_ENTRY_LEN: usize = 16;
pub const MAX_VOCAB_SIZE: u32 = 1 << 28;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum StructuralClass {
    ByteBpe = 0,
    SentencePieceBpe = 1,
}

impl TryFrom<u8> for StructuralClass {
    type Error = ReadError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::ByteBpe),
            1 => Ok(Self::SentencePieceBpe),
            _ => Err(ReadError::UnknownStructuralClass(value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum HashScheme {
    None = 0,
    Fmphgo = 1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PretokStepKind {
    NamedPattern = 0,
    ByteLevel = 1,
    Metaspace = 2,
    Identity = 3,
}

impl PretokStepKind {
    pub const fn value(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum NamedPattern {
    O200kBase = 1,
    Qwen35 = 2,
    Nemotron = 3,
    DeepSeekV3 = 4,
    Kimi = 5,
    Gpt2 = 6,
}

impl NamedPattern {
    pub const fn value(self) -> u32 {
        self as u32
    }
}

impl TryFrom<u32> for NamedPattern {
    type Error = ReadError;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::O200kBase),
            2 => Ok(Self::Qwen35),
            3 => Ok(Self::Nemotron),
            4 => Ok(Self::DeepSeekV3),
            5 => Ok(Self::Kimi),
            6 => Ok(Self::Gpt2),
            _ => Err(ReadError::UnknownNamedPattern(value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum NormStepKind {
    Nfc = 0,
    Replace = 1,
    Prepend = 2,
    StripWhitespace = 3,
    CollapseWhitespaceRuns = 4,
}

impl NormStepKind {
    pub const fn value(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum DecoderStepKind {
    Replace = 0,
    ByteFallback = 1,
    Fuse = 2,
    Strip = 3,
}

impl DecoderStepKind {
    pub const fn value(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PostPosition {
    Prepend = 0,
    Append = 1,
}

impl PostPosition {
    pub const fn value(self) -> u8 {
        self as u8
    }
}

impl TryFrom<u8> for HashScheme {
    type Error = ReadError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::None),
            1 => Ok(Self::Fmphgo),
            _ => Err(ReadError::UnknownHashScheme(value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
#[repr(u32)]
pub enum SectionId {
    Base = 1,
    Arena = 2,
    Lengths = 3,
    Specials = 4,
    Pretok = 5,
    Norm = 6,
    Decoder = 7,
    Post = 8,
    ByteFall = 9,
    Affix = 10,
    Unk = 11,
    Priority = 12,
    Hash = 1024,
}

impl SectionId {
    pub const UNIVERSAL_REQUIRED: [Self; 5] = [
        Self::Base,
        Self::Arena,
        Self::Lengths,
        Self::Specials,
        Self::Pretok,
    ];

    pub const fn value(self) -> u32 {
        self as u32
    }

    pub const fn requires_alignment(self) -> bool {
        matches!(
            self,
            Self::Base | Self::ByteFall | Self::Hash | Self::Priority
        )
    }

    pub const fn from_known(value: u32) -> Option<Self> {
        match value {
            1 => Some(Self::Base),
            2 => Some(Self::Arena),
            3 => Some(Self::Lengths),
            4 => Some(Self::Specials),
            5 => Some(Self::Pretok),
            6 => Some(Self::Norm),
            7 => Some(Self::Decoder),
            8 => Some(Self::Post),
            9 => Some(Self::ByteFall),
            10 => Some(Self::Affix),
            11 => Some(Self::Unk),
            12 => Some(Self::Priority),
            1024 => Some(Self::Hash),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Header {
    pub structural_class: StructuralClass,
    pub hash_scheme: HashScheme,
    pub flags: u8,
    pub vocab_size: u32,
    pub omega: u32,
    pub section_count: u32,
    pub section_table_offset: u32,
    pub digest: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SectionEntry {
    pub id: u32,
    pub offset: u32,
    pub length: u64,
}
