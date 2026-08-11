use super::*;

const BUILT_STATE_MAGIC: [u8; 4] = *b"HTKS";
const BUILT_STATE_VERSION: u16 = 1;
const BUILT_STATE_HEADER_LEN: usize = 64;
const PAIR_RECORD_LEN: usize = 12;

pub(crate) struct PrebuiltPairSlots {
    slot_count: usize,
    entries: Box<[(u32, u64)]>,
}

impl PrebuiltPairSlots {
    pub(crate) fn into_parts(self) -> (usize, Box<[(u32, u64)]>) {
        (self.slot_count, self.entries)
    }
}

pub(crate) struct PrebuiltBuiltState {
    lookup_image: Box<[u8]>,
    pair_slots: PrebuiltPairSlots,
}

impl PrebuiltBuiltState {
    pub(crate) fn to_bytes(
        vocab_size: u32,
        lookup_image: &[u8],
        pair_slot_count: usize,
        pair_entries: &[(u32, u64)],
    ) -> Result<Vec<u8>, WorkerImageError> {
        let slot_count =
            u32::try_from(pair_slot_count).map_err(|_| WorkerImageError::LengthOverflow)?;
        let entry_count =
            u32::try_from(pair_entries.len()).map_err(|_| WorkerImageError::LengthOverflow)?;
        let lookup_len =
            u32::try_from(lookup_image.len()).map_err(|_| WorkerImageError::LengthOverflow)?;
        let payload_len = lookup_image
            .len()
            .checked_add(
                pair_entries
                    .len()
                    .checked_mul(PAIR_RECORD_LEN)
                    .ok_or(WorkerImageError::LengthOverflow)?,
            )
            .ok_or(WorkerImageError::LengthOverflow)?;
        let mut bytes = vec![0_u8; BUILT_STATE_HEADER_LEN];
        bytes[0..4].copy_from_slice(&BUILT_STATE_MAGIC);
        bytes[4..6].copy_from_slice(&BUILT_STATE_VERSION.to_le_bytes());
        bytes[8..12].copy_from_slice(&vocab_size.to_le_bytes());
        bytes[12..16].copy_from_slice(&slot_count.to_le_bytes());
        bytes[16..20].copy_from_slice(&entry_count.to_le_bytes());
        bytes[20..24].copy_from_slice(&lookup_len.to_le_bytes());
        bytes.reserve(payload_len);
        bytes.extend_from_slice(lookup_image);
        for &(slot, packed) in pair_entries {
            bytes.extend_from_slice(&slot.to_le_bytes());
            bytes.extend_from_slice(&packed.to_le_bytes());
        }
        let digest = compute_digest(&bytes);
        bytes[32..64].copy_from_slice(&digest);
        Ok(bytes)
    }

    pub(crate) fn from_bytes(
        bytes: &[u8],
        expected_vocab_size: u32,
    ) -> Result<Self, WorkerImageError> {
        if bytes.len() < BUILT_STATE_HEADER_LEN {
            return Err(WorkerImageError::Truncated);
        }
        if bytes[0..4] != BUILT_STATE_MAGIC {
            return Err(WorkerImageError::BadMagic);
        }
        let version = u16::from_le_bytes(bytes[4..6].try_into().expect("fixed version field"));
        if version != BUILT_STATE_VERSION {
            return Err(WorkerImageError::UnsupportedVersion(version));
        }
        if bytes[6..8]
            .iter()
            .chain(&bytes[24..32])
            .any(|byte| *byte != 0)
        {
            return Err(WorkerImageError::NonZeroReserved);
        }
        let vocab_size = u32::from_le_bytes(bytes[8..12].try_into().expect("fixed size field"));
        if vocab_size != expected_vocab_size {
            return Err(WorkerImageError::LengthMismatch);
        }
        let slot_count = read_count(bytes, 12)?;
        let entry_count = read_count(bytes, 16)?;
        let lookup_len = read_count(bytes, 20)?;
        let expected_len = BUILT_STATE_HEADER_LEN
            .checked_add(lookup_len)
            .and_then(|length| length.checked_add(entry_count.checked_mul(PAIR_RECORD_LEN)?))
            .ok_or(WorkerImageError::LengthOverflow)?;
        if bytes.len() != expected_len || compute_digest(bytes) != bytes[32..64] {
            return Err(WorkerImageError::DigestMismatch);
        }
        let mut cursor = BUILT_STATE_HEADER_LEN;
        let lookup_image = take(bytes, &mut cursor, lookup_len)?
            .to_vec()
            .into_boxed_slice();
        let mut entries = Vec::with_capacity(entry_count);
        for _ in 0..entry_count {
            let slot = read_u32(bytes, cursor)?;
            cursor += 4;
            let packed = u64::from_le_bytes(
                take(bytes, &mut cursor, 8)?
                    .try_into()
                    .expect("fixed pair record"),
            );
            if packed == u64::MAX {
                return Err(WorkerImageError::PairIdOverflow);
            }
            entries.push((slot, packed));
        }
        Ok(Self {
            lookup_image,
            pair_slots: PrebuiltPairSlots {
                slot_count,
                entries: entries.into_boxed_slice(),
            },
        })
    }

    pub(crate) fn into_parts(self) -> (Box<[u8]>, PrebuiltPairSlots) {
        (self.lookup_image, self.pair_slots)
    }
}
