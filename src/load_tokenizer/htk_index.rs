use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::mem::size_of;

#[cfg(feature = "opt-resident-diet")]
use crate::bpe::TokenBytes;
#[cfg(feature = "opt-resident-diet")]
use std::sync::Arc;

use hypertok_format::{HashScheme, SectionId, ValidatedFile};
use hypertok_hash::{
    DEFAULT_TABLE_LOAD_PERMILLE, FingerprintTable, HashImage, ImageError, TableBuildError,
    TableKey, fingerprint,
};

#[derive(Debug)]
pub enum HtkIndexError {
    MissingHashSection,
    HashImage(ImageError),
    HashKeyCount { expected: u32, actual: u32 },
    HashMissingKey(u32),
    HashIndexOutOfBounds { index: u32, key_count: u32 },
    HashDuplicateIndex(u32),
    HashPayloadIncomplete(u32),
    PayloadIdOutOfBounds { id: u32, vocab_size: u32 },
    OffsetOverflow,
    Table(TableBuildError),
}

impl Display for HtkIndexError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingHashSection => {
                formatter.write_str("hash scheme 1 requires a HASH section")
            }
            Self::HashImage(error) => write!(formatter, "invalid HASH section: {error}"),
            Self::HashKeyCount { expected, actual } => write!(
                formatter,
                "HASH key count {actual} does not match lookup key count {expected}"
            ),
            Self::HashMissingKey(id) => {
                write!(formatter, "HASH does not evaluate lookup key id {id}")
            }
            Self::HashIndexOutOfBounds { index, key_count } => write!(
                formatter,
                "HASH evaluated index {index} outside key-set size {key_count}"
            ),
            Self::HashDuplicateIndex(index) => {
                write!(formatter, "HASH maps two lookup keys to index {index}")
            }
            Self::HashPayloadIncomplete(index) => {
                write!(formatter, "HASH payload index {index} was not constructed")
            }
            Self::PayloadIdOutOfBounds { id, vocab_size } => write!(
                formatter,
                "HASH payload id {id} is outside vocabulary size {vocab_size}"
            ),
            Self::OffsetOverflow => formatter.write_str("runtime offset construction overflow"),
            Self::Table(error) => write!(formatter, "runtime lookup table error: {error}"),
        }
    }
}

impl Error for HtkIndexError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::HashImage(error) => Some(error),
            Self::Table(error) => Some(error),
            _ => None,
        }
    }
}

impl From<TableBuildError> for HtkIndexError {
    fn from(error: TableBuildError) -> Self {
        Self::Table(error)
    }
}

impl From<ImageError> for HtkIndexError {
    fn from(error: ImageError) -> Self {
        Self::HashImage(error)
    }
}

#[cfg(feature = "opt-resident-diet")]
pub(super) type HtkArena = Arc<[u8]>;
#[cfg(not(feature = "opt-resident-diet"))]
pub(super) type HtkArena = Box<[u8]>;

pub(super) fn htk_arena(bytes: Vec<u8>) -> HtkArena {
    #[cfg(feature = "opt-resident-diet")]
    {
        bytes.into()
    }
    #[cfg(not(feature = "opt-resident-diet"))]
    {
        bytes.into_boxed_slice()
    }
}

/// The measured load-built lookup index and its decode offsets.
pub struct HtkLookupIndex {
    pub(super) arena: HtkArena,
    pub(super) block_shift: u8,
    pub(super) bases: Box<[u32]>,
    pub(super) intra: Box<[u16]>,
    pub(super) backend: LookupBackend,
    pub(super) vocab_size: u32,
}

pub(super) enum LookupBackend {
    Table(FingerprintTable),
    Perfect(PerfectIndex),
}

pub(super) struct PerfectIndex {
    pub(super) image: HashImage,
    pub(super) payload: Box<[u32]>,
    pub(super) fingerprints: Box<[u8]>,
}

struct BuiltOffsets {
    block_shift: u8,
    bases: Box<[u32]>,
    intra: Box<[u16]>,
}

impl HtkLookupIndex {
    pub fn build(
        file: &ValidatedFile<'_>,
        specials: &BTreeSet<u32>,
        byte_fallback: &BTreeSet<u32>,
    ) -> Result<Self, HtkIndexError> {
        let offsets = build_offsets(file)?;
        let keys = file
            .tokens()
            .filter(|(id, bytes)| {
                !bytes.is_empty() && !specials.contains(id) && !byte_fallback.contains(id)
            })
            .map(|(id, bytes)| TableKey { id, bytes })
            .collect::<Vec<_>>();
        let backend = match file.header().hash_scheme {
            HashScheme::None => {
                LookupBackend::Table(FingerprintTable::build(&keys, DEFAULT_TABLE_LOAD_PERMILLE)?)
            }
            HashScheme::Fmphgo => LookupBackend::Perfect(build_perfect_index(file, &keys)?),
        };
        let arena = htk_arena(
            file.section(SectionId::Arena.value())
                .expect("validated file has ARENA")
                .to_vec(),
        );
        Ok(Self {
            arena,
            block_shift: offsets.block_shift,
            bases: offsets.bases,
            intra: offsets.intra,
            backend,
            vocab_size: file.header().vocab_size,
        })
    }

    pub fn lookup(&self, bytes: &[u8]) -> Option<u32> {
        let id = match &self.backend {
            LookupBackend::Table(table) => table.lookup(bytes, |id, key| {
                self.token(id).is_some_and(|token| token == key)
            })?,
            LookupBackend::Perfect(index) => {
                let evaluated = usize::try_from(index.image.evaluate(bytes)?).ok()?;
                if evaluated >= index.payload.len() {
                    return None;
                }
                if index.fingerprints[evaluated] != fingerprint(bytes) {
                    return None;
                }
                index.payload[evaluated]
            }
        };
        if id >= self.vocab_size {
            return None;
        }
        self.token(id)
            .is_some_and(|token| token == bytes)
            .then_some(id)
    }

    pub fn token(&self, id: u32) -> Option<&[u8]> {
        let id = usize::try_from(id).ok()?;
        let start = self.offset(id)?;
        let end = if id + 1 == self.intra.len() {
            self.arena.len()
        } else {
            self.offset(id + 1)?
        };
        self.arena.get(start..end)
    }

    #[cfg(feature = "opt-resident-diet")]
    pub(crate) fn token_views(&self) -> Vec<TokenBytes> {
        (0..self.vocab_size as usize)
            .map(|id| {
                let start = self.offset(id).expect("validated token start");
                let end = if id + 1 == self.intra.len() {
                    self.arena.len()
                } else {
                    self.offset(id + 1).expect("validated token end")
                };
                TokenBytes::shared(Arc::clone(&self.arena), start, end)
                    .expect("validated arena view")
            })
            .collect()
    }

    pub fn key_count(&self) -> u32 {
        match &self.backend {
            LookupBackend::Table(table) => table.key_count(),
            LookupBackend::Perfect(index) => index.image.key_count(),
        }
    }

    pub fn resident_bytes(&self) -> usize {
        self.arena.len()
            + self.bases.len() * size_of::<u32>()
            + self.intra.len() * size_of::<u16>()
            + match &self.backend {
                LookupBackend::Table(table) => table.resident_bytes(),
                LookupBackend::Perfect(index) => {
                    index.image.resident_bytes()
                        + index.payload.len() * size_of::<u32>()
                        + index.fingerprints.len()
                }
            }
    }

    pub const fn block_shift(&self) -> u8 {
        self.block_shift
    }

    fn offset(&self, id: usize) -> Option<usize> {
        let block = id >> self.block_shift;
        Some(*self.bases.get(block)? as usize + *self.intra.get(id)? as usize)
    }
}

fn build_perfect_index(
    file: &ValidatedFile<'_>,
    keys: &[TableKey<'_>],
) -> Result<PerfectIndex, HtkIndexError> {
    let bytes = file
        .section(SectionId::Hash.value())
        .ok_or(HtkIndexError::MissingHashSection)?;
    let image = HashImage::from_bytes(bytes)?;
    let key_count = u32::try_from(keys.len()).map_err(|_| HtkIndexError::HashKeyCount {
        expected: u32::MAX,
        actual: image.key_count(),
    })?;
    if image.key_count() != key_count {
        return Err(HtkIndexError::HashKeyCount {
            expected: key_count,
            actual: image.key_count(),
        });
    }
    let mut payload = vec![None; keys.len()];
    let mut fingerprints = vec![0_u8; keys.len()];
    for key in keys {
        let evaluated = image
            .evaluate(key.bytes)
            .ok_or(HtkIndexError::HashMissingKey(key.id))?;
        let id = key.id;
        install_payload(
            &mut payload,
            &mut fingerprints,
            evaluated,
            id,
            file.header().vocab_size,
            fingerprint(key.bytes),
        )?;
    }
    let payload = payload
        .into_iter()
        .enumerate()
        .map(|(index, id)| id.ok_or(HtkIndexError::HashPayloadIncomplete(index as u32)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PerfectIndex {
        image,
        payload: payload.into_boxed_slice(),
        fingerprints: fingerprints.into_boxed_slice(),
    })
}

fn install_payload(
    payload: &mut [Option<u32>],
    fingerprints: &mut [u8],
    evaluated: u32,
    id: u32,
    vocab_size: u32,
    key_fingerprint: u8,
) -> Result<(), HtkIndexError> {
    let key_count = payload.len() as u32;
    if evaluated >= key_count {
        return Err(HtkIndexError::HashIndexOutOfBounds {
            index: evaluated,
            key_count,
        });
    }
    if id >= vocab_size {
        return Err(HtkIndexError::PayloadIdOutOfBounds { id, vocab_size });
    }
    let index = evaluated as usize;
    if payload[index].replace(id).is_some() {
        return Err(HtkIndexError::HashDuplicateIndex(evaluated));
    }
    fingerprints[index] = key_fingerprint;
    Ok(())
}

fn build_offsets(file: &ValidatedFile<'_>) -> Result<BuiltOffsets, HtkIndexError> {
    let omega = u64::from(file.header().omega);
    let mut block_shift = 0_u8;
    while block_shift < 31 {
        let next = block_shift + 1;
        let span = (1_u64 << next) - 1;
        if span.saturating_mul(omega) > u64::from(u16::MAX) {
            break;
        }
        block_shift = next;
    }
    let block_size = 1_usize << block_shift;
    let mut bases = Vec::with_capacity((file.header().vocab_size as usize).div_ceil(block_size));
    let mut intra = Vec::with_capacity(file.header().vocab_size as usize);
    let mut offset = 0_u32;
    let mut base = 0_u32;
    for (id, length) in file.lengths().enumerate() {
        if id % block_size == 0 {
            base = offset;
            bases.push(base);
        }
        intra.push(u16::try_from(offset - base).map_err(|_| HtkIndexError::OffsetOverflow)?);
        offset = offset
            .checked_add(length)
            .ok_or(HtkIndexError::OffsetOverflow)?;
    }
    Ok(BuiltOffsets {
        block_shift,
        bases: bases.into_boxed_slice(),
        intra: intra.into_boxed_slice(),
    })
}
