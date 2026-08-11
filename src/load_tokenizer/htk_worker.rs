use super::htk_index::{HtkLookupIndex, LookupBackend, PerfectIndex, htk_arena};
use crate::bpe::{MergeScratch, bpe_merge_symbols_by_rank};
use crate::pretokenize::PretokenizerType;
use crate::token::TokenId;
use hypertok_format::compute_digest;
use hypertok_hash::{FingerprintTable, HashImage, ImageError, TableImageError};
use rustc_hash::FxBuildHasher;
use std::collections::HashMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

const MAGIC: [u8; 4] = *b"HTKW";
const VERSION: u16 = 1;
const HEADER_LEN: usize = 112;
const BACKEND_TABLE: u8 = 0;
const BACKEND_PERFECT: u8 = 1;
const PAIR_ID_BITS: u32 = 21;

#[cfg(feature = "opt-prebuilt-pair-ranks")]
#[path = "htk_pair_image.rs"]
mod pair_image;

#[cfg(feature = "opt-prebuilt-pair-ranks")]
pub(crate) use pair_image::PrebuiltPairEntries;

#[cfg(feature = "opt-prebuilt-built-state")]
#[path = "htk_built_state.rs"]
mod built_state;

#[cfg(feature = "opt-prebuilt-built-state")]
pub(crate) use built_state::{PrebuiltBuiltState, PrebuiltPairSlots};

#[derive(Debug)]
pub(crate) enum WorkerImageError {
    Truncated,
    BadMagic,
    UnsupportedVersion(u16),
    UnknownBackend(u8),
    UnknownPretokenizer(u8),
    NonZeroReserved,
    LengthOverflow,
    LengthMismatch,
    DigestMismatch,
    SourceDigestMismatch,
    InvalidBlockShift(u8),
    BaseCount,
    OffsetOutOfBounds,
    OffsetOrder,
    BackendKeyCount,
    InvalidByteToken(u8),
    InvalidMergeToken(u32),
    DuplicateMergePair,
    PairIdOverflow,
    PairTableClustering,
    MissingPairTable,
    Table(TableImageError),
    Perfect(ImageError),
}

impl Display for WorkerImageError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => formatter.write_str("worker model image is truncated"),
            Self::BadMagic => formatter.write_str("worker model image has bad magic"),
            Self::UnsupportedVersion(version) => {
                write!(
                    formatter,
                    "unsupported worker model image version {version}"
                )
            }
            Self::UnknownBackend(tag) => write!(formatter, "unknown worker index backend {tag}"),
            Self::UnknownPretokenizer(tag) => {
                write!(formatter, "unknown worker pretokenizer tag {tag}")
            }
            Self::NonZeroReserved => formatter.write_str("worker model reserved bytes are nonzero"),
            Self::LengthOverflow => formatter.write_str("worker model image length overflow"),
            Self::LengthMismatch => formatter.write_str("worker model image length mismatch"),
            Self::DigestMismatch => formatter.write_str("worker model image digest mismatch"),
            Self::SourceDigestMismatch => {
                formatter.write_str("worker model source digest mismatch")
            }
            Self::InvalidBlockShift(shift) => {
                write!(formatter, "worker model block shift {shift} is invalid")
            }
            Self::BaseCount => formatter.write_str("worker model base count is inconsistent"),
            Self::OffsetOutOfBounds => {
                formatter.write_str("worker model token offset is outside the arena")
            }
            Self::OffsetOrder => formatter.write_str("worker model token offsets are not ordered"),
            Self::BackendKeyCount => {
                formatter.write_str("worker model backend key count is inconsistent")
            }
            Self::InvalidByteToken(byte) => {
                write!(formatter, "worker model has no exact token for byte {byte}")
            }
            Self::InvalidMergeToken(id) => {
                write!(
                    formatter,
                    "worker model token {id} does not reconstruct from one final merge"
                )
            }
            Self::DuplicateMergePair => {
                formatter.write_str("worker model has a duplicate merge pair")
            }
            Self::PairIdOverflow => {
                formatter.write_str("worker model token id exceeds pair-table capacity")
            }
            Self::PairTableClustering => {
                formatter.write_str("worker model pair table clusters excessively")
            }
            Self::MissingPairTable => {
                formatter.write_str("worker model has no resident pair table")
            }
            Self::Table(error) => write!(formatter, "invalid worker table image: {error}"),
            Self::Perfect(error) => write!(formatter, "invalid worker perfect index: {error}"),
        }
    }
}

impl Error for WorkerImageError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Table(error) => Some(error),
            Self::Perfect(error) => Some(error),
            _ => None,
        }
    }
}

impl From<TableImageError> for WorkerImageError {
    fn from(error: TableImageError) -> Self {
        Self::Table(error)
    }
}

impl From<ImageError> for WorkerImageError {
    fn from(error: ImageError) -> Self {
        Self::Perfect(error)
    }
}

pub(crate) struct HtkWorkerModel {
    index: HtkLookupIndex,
    pretokenizer: PretokenizerType,
    omega: u32,
    source_digest: [u8; 32],
    byte_ids: [u32; 256],
    pair_ranks: Option<WorkerPairTable>,
}

impl HtkWorkerModel {
    pub(crate) fn new(
        index: HtkLookupIndex,
        pretokenizer: PretokenizerType,
        omega: u32,
        source_digest: [u8; 32],
    ) -> Result<Self, WorkerImageError> {
        let byte_ids = crate::cold_construction::measure("worker-byte-ids", || byte_ids(&index))?;
        let pair_ranks = crate::cold_construction::measure("worker-pair-table", || {
            WorkerPairTable::build(&index, &byte_ids)
        })?;
        Ok(Self {
            index,
            pretokenizer,
            omega,
            source_digest,
            byte_ids,
            pair_ranks: Some(pair_ranks),
        })
    }

    #[cfg(feature = "opt-cold-diet")]
    pub(crate) fn new_transfer_source(
        index: HtkLookupIndex,
        pretokenizer: PretokenizerType,
        omega: u32,
        source_digest: [u8; 32],
    ) -> Result<Self, WorkerImageError> {
        let byte_ids = crate::cold_construction::measure("worker-byte-ids", || byte_ids(&index))?;
        Ok(Self {
            index,
            pretokenizer,
            omega,
            source_digest,
            byte_ids,
            pair_ranks: None,
        })
    }

    pub(crate) fn to_bytes(&self) -> Vec<u8> {
        let (backend_tag, backend_bytes) =
            crate::cold_construction::measure("worker-image-backend-serialization", || {
                encode_backend(&self.index.backend)
            });
        let mut bytes = crate::cold_construction::measure("worker-image-allocation", || {
            Vec::with_capacity(
                HEADER_LEN
                    + self.index.arena.len()
                    + self.index.bases.len() * 4
                    + self.index.intra.len() * 2
                    + backend_bytes.len()
                    + self.byte_ids.len() * 4,
            )
        });
        crate::cold_construction::measure("worker-image-header", || {
            bytes.extend_from_slice(&MAGIC);
            bytes.extend_from_slice(&VERSION.to_le_bytes());
            bytes.push(backend_tag);
            bytes.push(pretokenizer_tag(self.pretokenizer));
            bytes.push(self.index.block_shift);
            bytes.extend_from_slice(&[0; 3]);
            bytes.extend_from_slice(&self.index.vocab_size.to_le_bytes());
            bytes.extend_from_slice(&self.index.key_count().to_le_bytes());
            bytes.extend_from_slice(&self.omega.to_le_bytes());
            bytes.extend_from_slice(&(self.index.arena.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&(self.index.bases.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&[0; 32]);
            bytes.extend_from_slice(&self.source_digest);
            bytes.extend_from_slice(&(self.index.intra.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&(backend_bytes.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&(self.byte_ids.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&0_u32.to_le_bytes());
            debug_assert_eq!(bytes.len(), HEADER_LEN);
        });
        crate::cold_construction::measure("worker-image-arena-copy", || {
            bytes.extend_from_slice(&self.index.arena);
        });
        crate::cold_construction::measure("worker-image-offset-copy", || {
            for value in &self.index.bases {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            for value in &self.index.intra {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        });
        crate::cold_construction::measure("worker-image-backend-copy", || {
            bytes.extend_from_slice(&backend_bytes);
        });
        crate::cold_construction::measure("worker-image-byte-id-copy", || {
            for value in self.byte_ids {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        });
        crate::cold_construction::measure("worker-image-digest", || {
            let digest = compute_digest(&bytes);
            bytes[32..64].copy_from_slice(&digest);
        });
        bytes
    }

    pub(crate) fn from_bytes(
        bytes: &[u8],
        expected_source_digest: &[u8],
    ) -> Result<Self, WorkerImageError> {
        if bytes.len() < HEADER_LEN {
            return Err(WorkerImageError::Truncated);
        }
        if bytes[0..4] != MAGIC {
            return Err(WorkerImageError::BadMagic);
        }
        let version = read_u16(bytes, 4)?;
        if version != VERSION {
            return Err(WorkerImageError::UnsupportedVersion(version));
        }
        let backend_tag = bytes[6];
        let pretokenizer = pretokenizer_from_tag(bytes[7])?;
        let block_shift = bytes[8];
        if bytes[9..12].iter().any(|value| *value != 0) || read_u32(bytes, 108)? != 0 {
            return Err(WorkerImageError::NonZeroReserved);
        }
        if block_shift >= usize::BITS as u8 {
            return Err(WorkerImageError::InvalidBlockShift(block_shift));
        }
        let vocab_size = read_u32(bytes, 12)?;
        let key_count = read_u32(bytes, 16)?;
        let omega = read_u32(bytes, 20)?;
        let arena_len = read_count(bytes, 24)?;
        let bases_len = read_count(bytes, 28)?;
        let image_digest: [u8; 32] = bytes[32..64].try_into().expect("fixed digest");
        let source_digest: [u8; 32] = bytes[64..96].try_into().expect("fixed digest");
        if expected_source_digest != source_digest {
            return Err(WorkerImageError::SourceDigestMismatch);
        }
        if compute_digest(bytes) != image_digest {
            return Err(WorkerImageError::DigestMismatch);
        }
        let intra_len = read_count(bytes, 96)?;
        let backend_len = read_count(bytes, 100)?;
        let byte_id_len = read_count(bytes, 104)?;
        if intra_len != vocab_size as usize || byte_id_len != 256 {
            return Err(WorkerImageError::LengthMismatch);
        }
        let expected_bases = (vocab_size as usize).div_ceil(1_usize << block_shift);
        if bases_len != expected_bases {
            return Err(WorkerImageError::BaseCount);
        }
        let total_len = HEADER_LEN
            .checked_add(arena_len)
            .and_then(|value| value.checked_add(bases_len.checked_mul(4)?))
            .and_then(|value| value.checked_add(intra_len.checked_mul(2)?))
            .and_then(|value| value.checked_add(backend_len))
            .and_then(|value| value.checked_add(byte_id_len.checked_mul(4)?))
            .ok_or(WorkerImageError::LengthOverflow)?;
        if bytes.len() != total_len {
            return Err(WorkerImageError::LengthMismatch);
        }
        let mut cursor = HEADER_LEN;
        let arena = htk_arena(take(bytes, &mut cursor, arena_len)?.to_vec());
        let bases = read_u32_array(bytes, &mut cursor, bases_len)?.into_boxed_slice();
        let intra = read_u16_array(bytes, &mut cursor, intra_len)?.into_boxed_slice();
        validate_offsets(&arena, block_shift, &bases, &intra)?;
        let backend_bytes = take(bytes, &mut cursor, backend_len)?;
        let backend = decode_backend(backend_tag, backend_bytes, vocab_size, key_count)?;
        let byte_ids_vec = read_u32_array(bytes, &mut cursor, byte_id_len)?;
        let byte_ids: [u32; 256] = byte_ids_vec
            .try_into()
            .map_err(|_| WorkerImageError::LengthMismatch)?;
        let index = HtkLookupIndex {
            arena,
            block_shift,
            bases,
            intra,
            backend,
            vocab_size,
        };
        validate_byte_ids(&index, &byte_ids)?;
        let pair_ranks = crate::cold_construction::measure("worker-pair-table", || {
            WorkerPairTable::build(&index, &byte_ids)
        })?;
        Ok(Self {
            index,
            pretokenizer,
            omega,
            source_digest,
            byte_ids,
            pair_ranks: Some(pair_ranks),
        })
    }

    pub(crate) fn pretokenizer(&self) -> PretokenizerType {
        self.pretokenizer
    }

    pub(crate) fn omega(&self) -> u32 {
        self.omega
    }

    pub(crate) fn vocab_size(&self) -> usize {
        self.index.vocab_size as usize
    }

    pub(crate) fn source_digest(&self) -> [u8; 32] {
        self.source_digest
    }

    pub(crate) fn token_length(&self, id: u32) -> Option<usize> {
        self.index.token(id).map(<[u8]>::len)
    }
}

pub(crate) struct HtkWorkerEncoder {
    model: Arc<HtkWorkerModel>,
    merge_scratch: MergeScratch,
    #[cfg(feature = "opt-scratch-reuse")]
    symbol_scratch: Vec<TokenId>,
}

impl HtkWorkerEncoder {
    pub(crate) fn new(model: Arc<HtkWorkerModel>) -> Self {
        Self {
            model,
            merge_scratch: MergeScratch::default(),
            #[cfg(feature = "opt-scratch-reuse")]
            symbol_scratch: Vec::new(),
        }
    }

    pub(crate) fn model(&self) -> &Arc<HtkWorkerModel> {
        &self.model
    }

    pub(crate) fn encode_pretoken(&mut self, bytes: &[u8]) -> Vec<u32> {
        let mut symbols = bytes
            .iter()
            .map(|byte| TokenId(self.model.byte_ids[*byte as usize]))
            .collect::<Vec<_>>();
        let model = &self.model;
        let pair_ranks = model
            .pair_ranks
            .as_ref()
            .expect("worker encoders require an imported pair table");
        bpe_merge_symbols_by_rank(
            &|left, right| pair_ranks.rank(left, right),
            &mut symbols,
            &mut self.merge_scratch,
        );
        symbols.into_iter().map(|id| id.0).collect()
    }

    #[cfg(feature = "opt-scratch-reuse")]
    pub(crate) fn encode_pretoken_into(&mut self, bytes: &[u8], out: &mut Vec<u32>) {
        self.symbol_scratch.clear();
        self.symbol_scratch.extend(
            bytes
                .iter()
                .map(|byte| TokenId(self.model.byte_ids[*byte as usize])),
        );
        let model = &self.model;
        let pair_ranks = model
            .pair_ranks
            .as_ref()
            .expect("worker encoders require an imported pair table");
        bpe_merge_symbols_by_rank(
            &|left, right| pair_ranks.rank(left, right),
            &mut self.symbol_scratch,
            &mut self.merge_scratch,
        );
        out.clear();
        out.extend(self.symbol_scratch.iter().map(|id| id.0));
    }
}

pub(crate) struct WorkerPairTable {
    slots: Box<[u64]>,
    mask: usize,
    shift: u32,
}

impl WorkerPairTable {
    fn build(index: &HtkLookupIndex, byte_ids: &[u32; 256]) -> Result<Self, WorkerImageError> {
        let id_limit = 1_u32 << PAIR_ID_BITS;
        if index.vocab_size > id_limit || byte_ids.iter().any(|id| *id >= id_limit) {
            return Err(WorkerImageError::PairIdOverflow);
        }
        let mut merges = HashMap::with_hasher(FxBuildHasher);
        let mut scratch = MergeScratch::default();
        for id in 0..index.vocab_size {
            let Some(token) = index.token(id) else {
                continue;
            };
            if token.len() < 2 || index.lookup(token) != Some(id) {
                continue;
            }
            let mut symbols = token
                .iter()
                .map(|byte| TokenId(byte_ids[*byte as usize]))
                .collect::<Vec<_>>();
            bpe_merge_symbols_by_rank(
                &|left, right| {
                    merges
                        .get(&(left, right))
                        .map_or(u32::MAX, |merged: &TokenId| merged.0)
                },
                &mut symbols,
                &mut scratch,
            );
            if symbols.len() != 2 {
                return Err(WorkerImageError::InvalidMergeToken(id));
            }
            if merges
                .insert((symbols[0], symbols[1]), TokenId(id))
                .is_some()
            {
                return Err(WorkerImageError::DuplicateMergePair);
            }
        }

        let slot_count = (merges.len().max(1) * 2).next_power_of_two().max(64);
        let shift = 64 - slot_count.trailing_zeros();
        let mask = slot_count - 1;
        let mut slots = vec![u64::MAX; slot_count].into_boxed_slice();
        for (&(left, right), &merged) in &merges {
            if (left.0 | right.0 | merged.0) >= id_limit {
                return Err(WorkerImageError::PairIdOverflow);
            }
            let key = ((left.0 as u64) << PAIR_ID_BITS) | right.0 as u64;
            let mut slot = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> shift) as usize;
            let mut displacement = 0;
            while slots[slot] != u64::MAX {
                slot = (slot + 1) & mask;
                displacement += 1;
                if displacement > 64 {
                    return Err(WorkerImageError::PairTableClustering);
                }
            }
            slots[slot] = (key << PAIR_ID_BITS) | merged.0 as u64;
        }
        Ok(Self { slots, mask, shift })
    }

    #[inline(always)]
    fn rank(&self, left: TokenId, right: TokenId) -> u32 {
        let key = ((left.0 as u64) << PAIR_ID_BITS) | right.0 as u64;
        let mut slot = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
        loop {
            let packed = self.slots[slot];
            if packed >> PAIR_ID_BITS == key {
                return (packed & ((1 << PAIR_ID_BITS) - 1)) as u32;
            }
            if packed == u64::MAX {
                return u32::MAX;
            }
            slot = (slot + 1) & self.mask;
        }
    }
}

fn encode_backend(backend: &LookupBackend) -> (u8, Vec<u8>) {
    match backend {
        LookupBackend::Table(table) => (BACKEND_TABLE, table.to_bytes()),
        LookupBackend::Perfect(index) => {
            let hash = index.image.to_bytes();
            let mut bytes = Vec::with_capacity(
                16 + hash.len() + index.payload.len() * 4 + index.fingerprints.len(),
            );
            bytes.extend_from_slice(&(hash.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&(index.payload.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&(index.fingerprints.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&0_u32.to_le_bytes());
            bytes.extend_from_slice(&hash);
            for id in &index.payload {
                bytes.extend_from_slice(&id.to_le_bytes());
            }
            bytes.extend_from_slice(&index.fingerprints);
            (BACKEND_PERFECT, bytes)
        }
    }
}

fn decode_backend(
    tag: u8,
    bytes: &[u8],
    vocab_size: u32,
    key_count: u32,
) -> Result<LookupBackend, WorkerImageError> {
    match tag {
        BACKEND_TABLE => {
            let table = FingerprintTable::from_bytes(bytes, vocab_size)?;
            if table.key_count() != key_count {
                return Err(WorkerImageError::BackendKeyCount);
            }
            Ok(LookupBackend::Table(table))
        }
        BACKEND_PERFECT => {
            if bytes.len() < 16 || bytes[12..16].iter().any(|value| *value != 0) {
                return Err(WorkerImageError::Truncated);
            }
            let hash_len = read_count(bytes, 0)?;
            let payload_len = read_count(bytes, 4)?;
            let fingerprint_len = read_count(bytes, 8)?;
            if payload_len != key_count as usize || fingerprint_len != payload_len {
                return Err(WorkerImageError::BackendKeyCount);
            }
            let expected = 16_usize
                .checked_add(hash_len)
                .and_then(|value| value.checked_add(payload_len.checked_mul(4)?))
                .and_then(|value| value.checked_add(fingerprint_len))
                .ok_or(WorkerImageError::LengthOverflow)?;
            if bytes.len() != expected {
                return Err(WorkerImageError::LengthMismatch);
            }
            let mut cursor = 16;
            let image = HashImage::from_bytes(take(bytes, &mut cursor, hash_len)?)?;
            if image.key_count() != key_count {
                return Err(WorkerImageError::BackendKeyCount);
            }
            let payload = read_u32_array(bytes, &mut cursor, payload_len)?;
            if payload.iter().any(|id| *id >= vocab_size) {
                return Err(WorkerImageError::BackendKeyCount);
            }
            let fingerprints = take(bytes, &mut cursor, fingerprint_len)?.to_vec();
            Ok(LookupBackend::Perfect(PerfectIndex {
                image,
                payload: payload.into_boxed_slice(),
                fingerprints: fingerprints.into_boxed_slice(),
            }))
        }
        value => Err(WorkerImageError::UnknownBackend(value)),
    }
}

fn byte_ids(index: &HtkLookupIndex) -> Result<[u32; 256], WorkerImageError> {
    let mut ids = [0_u32; 256];
    for byte in 0_u8..=u8::MAX {
        ids[byte as usize] = index
            .lookup(std::slice::from_ref(&byte))
            .ok_or(WorkerImageError::InvalidByteToken(byte))?;
    }
    Ok(ids)
}

fn validate_byte_ids(
    index: &HtkLookupIndex,
    byte_ids: &[u32; 256],
) -> Result<(), WorkerImageError> {
    for byte in 0_u8..=u8::MAX {
        let id = byte_ids[byte as usize];
        if index.token(id) != Some(std::slice::from_ref(&byte)) {
            return Err(WorkerImageError::InvalidByteToken(byte));
        }
    }
    Ok(())
}

fn validate_offsets(
    arena: &[u8],
    block_shift: u8,
    bases: &[u32],
    intra: &[u16],
) -> Result<(), WorkerImageError> {
    let mut previous = 0_usize;
    for id in 0..intra.len() {
        let block = id >> block_shift;
        let offset = bases
            .get(block)
            .map(|base| *base as usize + intra[id] as usize)
            .ok_or(WorkerImageError::OffsetOutOfBounds)?;
        if offset > arena.len() {
            return Err(WorkerImageError::OffsetOutOfBounds);
        }
        if (id == 0 && offset != 0) || (id != 0 && offset < previous) {
            return Err(WorkerImageError::OffsetOrder);
        }
        if id & ((1_usize << block_shift) - 1) == 0 && intra[id] != 0 {
            return Err(WorkerImageError::OffsetOrder);
        }
        previous = offset;
    }
    Ok(())
}

fn pretokenizer_tag(value: PretokenizerType) -> u8 {
    match value {
        PretokenizerType::GPT2 => 0,
        PretokenizerType::GPT4 => 1,
        PretokenizerType::Qwen2 => 2,
        PretokenizerType::Qwen35 => 3,
        PretokenizerType::Olmo3 => 4,
        PretokenizerType::DeepSeekV3 => 5,
        PretokenizerType::O200k => 6,
        PretokenizerType::Nemotron => 7,
        PretokenizerType::Kimi => 8,
        PretokenizerType::CohereCommand => 9,
    }
}

fn pretokenizer_from_tag(tag: u8) -> Result<PretokenizerType, WorkerImageError> {
    Ok(match tag {
        0 => PretokenizerType::GPT2,
        1 => PretokenizerType::GPT4,
        2 => PretokenizerType::Qwen2,
        3 => PretokenizerType::Qwen35,
        4 => PretokenizerType::Olmo3,
        5 => PretokenizerType::DeepSeekV3,
        6 => PretokenizerType::O200k,
        7 => PretokenizerType::Nemotron,
        8 => PretokenizerType::Kimi,
        9 => PretokenizerType::CohereCommand,
        value => return Err(WorkerImageError::UnknownPretokenizer(value)),
    })
}

fn read_count(bytes: &[u8], offset: usize) -> Result<usize, WorkerImageError> {
    usize::try_from(read_u32(bytes, offset)?).map_err(|_| WorkerImageError::LengthOverflow)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, WorkerImageError> {
    let raw = bytes
        .get(offset..offset + 2)
        .ok_or(WorkerImageError::Truncated)?;
    Ok(u16::from_le_bytes(raw.try_into().expect("fixed field")))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, WorkerImageError> {
    let raw = bytes
        .get(offset..offset + 4)
        .ok_or(WorkerImageError::Truncated)?;
    Ok(u32::from_le_bytes(raw.try_into().expect("fixed field")))
}

fn take<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    length: usize,
) -> Result<&'a [u8], WorkerImageError> {
    let end = cursor
        .checked_add(length)
        .ok_or(WorkerImageError::LengthOverflow)?;
    let value = bytes.get(*cursor..end).ok_or(WorkerImageError::Truncated)?;
    *cursor = end;
    Ok(value)
}

fn read_u32_array(
    bytes: &[u8],
    cursor: &mut usize,
    count: usize,
) -> Result<Vec<u32>, WorkerImageError> {
    let raw = take(
        bytes,
        cursor,
        count
            .checked_mul(4)
            .ok_or(WorkerImageError::LengthOverflow)?,
    )?;
    Ok(raw
        .chunks_exact(4)
        .map(|value| u32::from_le_bytes(value.try_into().expect("fixed array item")))
        .collect())
}

fn read_u16_array(
    bytes: &[u8],
    cursor: &mut usize,
    count: usize,
) -> Result<Vec<u16>, WorkerImageError> {
    let raw = take(
        bytes,
        cursor,
        count
            .checked_mul(2)
            .ok_or(WorkerImageError::LengthOverflow)?,
    )?;
    Ok(raw
        .chunks_exact(2)
        .map(|value| u16::from_le_bytes(value.try_into().expect("fixed array item")))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypertok_hash::{DEFAULT_TABLE_LOAD_PERMILLE, TableKey};

    fn model() -> HtkWorkerModel {
        let arena = htk_arena((0_u8..=u8::MAX).collect());
        let keys = arena
            .iter()
            .enumerate()
            .map(|(id, byte)| TableKey {
                id: id as u32,
                bytes: std::slice::from_ref(byte),
            })
            .collect::<Vec<_>>();
        let table = FingerprintTable::build(&keys, DEFAULT_TABLE_LOAD_PERMILLE).unwrap();
        HtkWorkerModel::new(
            HtkLookupIndex {
                arena,
                block_shift: 8,
                bases: vec![0].into_boxed_slice(),
                intra: (0_u16..=255).collect::<Vec<_>>().into_boxed_slice(),
                backend: LookupBackend::Table(table),
                vocab_size: 256,
            },
            PretokenizerType::GPT2,
            1,
            [7; 32],
        )
        .unwrap()
    }

    fn merged_model() -> HtkWorkerModel {
        let mut arena = (0_u8..=u8::MAX).collect::<Vec<_>>();
        arena.extend_from_slice(b"ab");
        let arena = htk_arena(arena);
        let mut keys = (0..256)
            .map(|id| TableKey {
                id: id as u32,
                bytes: &arena[id..id + 1],
            })
            .collect::<Vec<_>>();
        keys.push(TableKey {
            id: 256,
            bytes: &arena[256..258],
        });
        let table = FingerprintTable::build(&keys, DEFAULT_TABLE_LOAD_PERMILLE).unwrap();
        let mut intra = (0_u16..=255).collect::<Vec<_>>();
        intra.push(0);
        HtkWorkerModel::new(
            HtkLookupIndex {
                arena,
                block_shift: 8,
                bases: vec![0, 256].into_boxed_slice(),
                intra: intra.into_boxed_slice(),
                backend: LookupBackend::Table(table),
                vocab_size: 257,
            },
            PretokenizerType::GPT2,
            2,
            [9; 32],
        )
        .unwrap()
    }

    fn redigest(image: &mut [u8]) {
        image[32..64].fill(0);
        let digest = compute_digest(image);
        image[32..64].copy_from_slice(&digest);
    }

    #[test]
    fn worker_image_round_trip_is_load_bearing() {
        let image = model().to_bytes();
        let restored = Arc::new(HtkWorkerModel::from_bytes(&image, &[7; 32]).unwrap());
        let mut encoder = HtkWorkerEncoder::new(restored);
        assert_eq!(encoder.encode_pretoken(b"ab"), vec![97, 98]);
        assert_eq!(encoder.encode_pretoken(b"ab"), vec![97, 98]);
    }

    #[test]
    fn transferred_worker_uses_rebuilt_pair_ranks() {
        let image = merged_model().to_bytes();
        let restored = Arc::new(HtkWorkerModel::from_bytes(&image, &[9; 32]).unwrap());
        let mut encoder = HtkWorkerEncoder::new(restored);
        assert_eq!(encoder.encode_pretoken(b"ab"), vec![256]);
        assert_eq!(encoder.encode_pretoken(b"zabz"), vec![122, 256, 122]);
    }

    #[cfg(feature = "opt-cold-diet")]
    #[test]
    fn transfer_source_defers_only_the_resident_pair_table() {
        let eager = merged_model();
        let HtkWorkerModel {
            index,
            pretokenizer,
            omega,
            source_digest,
            ..
        } = eager;
        let deferred =
            HtkWorkerModel::new_transfer_source(index, pretokenizer, omega, source_digest).unwrap();
        assert!(deferred.pair_ranks.is_none());

        let image = deferred.to_bytes();
        let restored = Arc::new(HtkWorkerModel::from_bytes(&image, &[9; 32]).unwrap());
        assert!(restored.pair_ranks.is_some());
        let mut encoder = HtkWorkerEncoder::new(restored);
        assert_eq!(encoder.encode_pretoken(b"zabz"), vec![122, 256, 122]);
    }

    #[test]
    fn identity_and_length_mutations_are_refused() {
        let image = model().to_bytes();
        assert!(HtkWorkerModel::from_bytes(&image[..100], &[7; 32]).is_err());
        assert!(HtkWorkerModel::from_bytes(&image, &[8; 32]).is_err());

        let mut corrupted = image.clone();
        *corrupted.last_mut().unwrap() ^= 1;
        assert!(HtkWorkerModel::from_bytes(&corrupted, &[7; 32]).is_err());

        let mut trailing = image;
        trailing.push(0);
        redigest(&mut trailing);
        assert!(HtkWorkerModel::from_bytes(&trailing, &[7; 32]).is_err());
    }

    #[test]
    fn header_mutations_are_refused() {
        for (offset, value) in [(4, 2), (6, 9), (7, 10), (9, 1)] {
            let mut image = model().to_bytes();
            image[offset] = value;
            redigest(&mut image);
            assert!(HtkWorkerModel::from_bytes(&image, &[7; 32]).is_err());
        }
    }

    #[test]
    fn geometry_and_id_mutations_are_refused() {
        let mut bad_base_count = model().to_bytes();
        bad_base_count[28..32].copy_from_slice(&2_u32.to_le_bytes());
        redigest(&mut bad_base_count);
        assert!(HtkWorkerModel::from_bytes(&bad_base_count, &[7; 32]).is_err());

        let mut bad_offset = model().to_bytes();
        let intra_start = HEADER_LEN + 256 + 4;
        bad_offset[intra_start + 2..intra_start + 4].copy_from_slice(&300_u16.to_le_bytes());
        redigest(&mut bad_offset);
        assert!(HtkWorkerModel::from_bytes(&bad_offset, &[7; 32]).is_err());

        let mut bad_byte_id = model().to_bytes();
        let byte_ids_start = bad_byte_id.len() - 256 * 4;
        bad_byte_id[byte_ids_start..byte_ids_start + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        redigest(&mut bad_byte_id);
        assert!(HtkWorkerModel::from_bytes(&bad_byte_id, &[7; 32]).is_err());
    }
}
