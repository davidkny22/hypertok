use super::*;

const PAIR_MAGIC: [u8; 4] = *b"HTKP";
const PAIR_VERSION: u16 = 1;
const PAIR_HEADER_LEN: usize = 64;

pub(crate) struct PrebuiltPairEntries {
    entries: Box<[u64]>,
}

impl HtkWorkerModel {
    pub(crate) fn to_prebuilt_pair_bytes(&self) -> Result<Vec<u8>, WorkerImageError> {
        let pair_ranks = self
            .pair_ranks
            .as_ref()
            .ok_or(WorkerImageError::MissingPairTable)?;
        let vocab_size = self.index.vocab_size;
        let entry_count = u32::try_from(
            pair_ranks
                .slots
                .iter()
                .filter(|slot| **slot != u64::MAX)
                .count(),
        )
        .map_err(|_| WorkerImageError::LengthOverflow)?;
        let mut bytes = vec![0_u8; PAIR_HEADER_LEN];
        bytes[0..4].copy_from_slice(&PAIR_MAGIC);
        bytes[4..6].copy_from_slice(&PAIR_VERSION.to_le_bytes());
        bytes[8..12].copy_from_slice(&vocab_size.to_le_bytes());
        bytes[12..16].copy_from_slice(&entry_count.to_le_bytes());
        bytes.reserve(entry_count as usize * 8);
        for &slot in pair_ranks.slots.iter().filter(|slot| **slot != u64::MAX) {
            bytes.extend_from_slice(&slot.to_le_bytes());
        }
        let digest = compute_digest(&bytes);
        bytes[32..64].copy_from_slice(&digest);
        Ok(bytes)
    }
}

impl PrebuiltPairEntries {
    pub(crate) fn from_bytes(
        bytes: &[u8],
        expected_vocab_size: u32,
    ) -> Result<Self, WorkerImageError> {
        if bytes.len() < PAIR_HEADER_LEN {
            return Err(WorkerImageError::Truncated);
        }
        if bytes[0..4] != PAIR_MAGIC {
            return Err(WorkerImageError::BadMagic);
        }
        let version = u16::from_le_bytes(bytes[4..6].try_into().expect("fixed version field"));
        if version != PAIR_VERSION {
            return Err(WorkerImageError::UnsupportedVersion(version));
        }
        if bytes[6..8]
            .iter()
            .chain(&bytes[16..32])
            .any(|byte| *byte != 0)
        {
            return Err(WorkerImageError::NonZeroReserved);
        }
        let vocab_size = u32::from_le_bytes(bytes[8..12].try_into().expect("fixed size field"));
        if vocab_size != expected_vocab_size {
            return Err(WorkerImageError::LengthMismatch);
        }
        let entry_count = u32::from_le_bytes(bytes[12..16].try_into().expect("fixed count field"));
        let entry_count =
            usize::try_from(entry_count).map_err(|_| WorkerImageError::LengthOverflow)?;
        let expected_len = PAIR_HEADER_LEN
            .checked_add(
                entry_count
                    .checked_mul(8)
                    .ok_or(WorkerImageError::LengthOverflow)?,
            )
            .ok_or(WorkerImageError::LengthOverflow)?;
        if bytes.len() != expected_len || compute_digest(bytes) != bytes[32..64] {
            return Err(WorkerImageError::DigestMismatch);
        }
        let entries = bytes[PAIR_HEADER_LEN..]
            .chunks_exact(8)
            .map(|chunk| u64::from_le_bytes(chunk.try_into().expect("fixed slot field")))
            .collect::<Vec<_>>()
            .into_boxed_slice();
        if entries.iter().any(|entry| *entry == u64::MAX) {
            return Err(WorkerImageError::PairIdOverflow);
        }
        Ok(Self { entries })
    }

    pub(crate) fn into_entries(self) -> Box<[u64]> {
        self.entries
    }
}
