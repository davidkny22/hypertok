use core::fmt;

use hypertok_format::{
    DIGEST_RANGE, FORMAT_VERSION, HEADER_LEN, HashScheme, MAGIC, MAX_VOCAB_SIZE, ReadError,
    SECTION_TABLE_ENTRY_LEN, SectionId, StructuralClass, ValidatedFile, compute_digest,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Section {
    id: u32,
    bytes: Vec<u8>,
}

impl Section {
    pub fn new(id: SectionId, bytes: Vec<u8>) -> Self {
        Self {
            id: id.value(),
            bytes,
        }
    }

    pub fn extension(id: u32, bytes: Vec<u8>) -> Result<Self, WriteError> {
        if id < 1024 || id == SectionId::Hash.value() {
            return Err(WriteError::InvalidExtensionId(id));
        }
        Ok(Self { id, bytes })
    }

    pub const fn id(&self) -> u32 {
        self.id
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Document {
    pub structural_class: StructuralClass,
    pub hash_scheme: HashScheme,
    pub flags: u8,
    pub vocab_size: u32,
    pub omega: u32,
    pub sections: Vec<Section>,
}

#[derive(Debug)]
pub enum WriteError {
    InvalidExtensionId(u32),
    DuplicateSection(u32),
    TooManySections(usize),
    VocabTooLarge(u32),
    FileTooLarge,
    SelfValidation(ReadError),
}

impl fmt::Display for WriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidExtensionId(id) => {
                write!(formatter, "extension section id {id} is not available")
            }
            Self::DuplicateSection(id) => {
                write!(formatter, "section id {id} was supplied more than once")
            }
            Self::TooManySections(count) => write!(formatter, "section count {count} exceeds u32"),
            Self::VocabTooLarge(size) => write!(formatter, "vocabulary size {size} exceeds 2^28"),
            Self::FileTooLarge => {
                formatter.write_str("emitted file exceeds addressable format bounds")
            }
            Self::SelfValidation(error) => write!(
                formatter,
                "emitted file failed read-back validation: {error}"
            ),
        }
    }
}

impl std::error::Error for WriteError {}

pub fn write(document: &Document) -> Result<Vec<u8>, WriteError> {
    if document.vocab_size > MAX_VOCAB_SIZE {
        return Err(WriteError::VocabTooLarge(document.vocab_size));
    }
    let section_count = u32::try_from(document.sections.len())
        .map_err(|_| WriteError::TooManySections(document.sections.len()))?;

    let mut sections: Vec<&Section> = document.sections.iter().collect();
    sections.sort_unstable_by_key(|section| emission_key(section.id));
    for pair in sections.windows(2) {
        if pair[0].id == pair[1].id {
            return Err(WriteError::DuplicateSection(pair[0].id));
        }
    }

    let table_len = document
        .sections
        .len()
        .checked_mul(SECTION_TABLE_ENTRY_LEN)
        .ok_or(WriteError::FileTooLarge)?;
    let payload_start = HEADER_LEN
        .checked_add(table_len)
        .ok_or(WriteError::FileTooLarge)?;
    let mut output = vec![0_u8; payload_start];
    let mut entries = Vec::with_capacity(sections.len());

    for section in sections {
        pad_to_eight(&mut output)?;
        let offset = u32::try_from(output.len()).map_err(|_| WriteError::FileTooLarge)?;
        let length = u64::try_from(section.bytes.len()).map_err(|_| WriteError::FileTooLarge)?;
        entries.push((section.id, offset, length));
        output.extend_from_slice(&section.bytes);
    }

    output[..8].copy_from_slice(&MAGIC);
    output[8..10].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
    output[10] = document.structural_class as u8;
    output[11] = 0;
    output[12] = document.hash_scheme as u8;
    output[13] = document.flags;
    output[14..16].fill(0);
    output[16..20].copy_from_slice(&document.vocab_size.to_le_bytes());
    output[20..24].copy_from_slice(&document.omega.to_le_bytes());
    output[24..28].copy_from_slice(&section_count.to_le_bytes());
    output[28..32].copy_from_slice(&(HEADER_LEN as u32).to_le_bytes());
    output[DIGEST_RANGE.clone()].fill(0);

    for (index, (id, offset, length)) in entries.into_iter().enumerate() {
        let start = HEADER_LEN + index * SECTION_TABLE_ENTRY_LEN;
        output[start..start + 4].copy_from_slice(&id.to_le_bytes());
        output[start + 4..start + 8].copy_from_slice(&offset.to_le_bytes());
        output[start + 8..start + 16].copy_from_slice(&length.to_le_bytes());
    }

    let digest = compute_digest(&output);
    output[DIGEST_RANGE.clone()].copy_from_slice(&digest);
    ValidatedFile::read(&output).map_err(WriteError::SelfValidation)?;
    Ok(output)
}

fn emission_key(id: u32) -> (u8, u32) {
    match id {
        value if value == SectionId::Lengths.value() => (0, 0),
        value if value == SectionId::Hash.value() => (1, 0),
        value if value == SectionId::Arena.value() => (2, 0),
        value => (3, value),
    }
}

fn pad_to_eight(output: &mut Vec<u8>) -> Result<(), WriteError> {
    let aligned = output
        .len()
        .checked_add(7)
        .ok_or(WriteError::FileTooLarge)?
        & !7;
    output.resize(aligned, 0);
    Ok(())
}
