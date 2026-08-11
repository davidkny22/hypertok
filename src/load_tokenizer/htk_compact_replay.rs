use super::*;

const REPLAY_MAGIC: [u8; 4] = *b"HTKR";
const REPLAY_VERSION: u16 = 1;
const REPLAY_HEADER_LEN: usize = 64;

pub(crate) struct PrebuiltReplayPairs {
    entries: Box<[(u32, u32)]>,
}

impl HtkWorkerModel {
    pub(crate) fn to_prebuilt_replay_bytes(&self) -> Result<Vec<u8>, WorkerImageError> {
        let pair_ranks = self
            .pair_ranks
            .as_ref()
            .ok_or(WorkerImageError::MissingPairTable)?;
        let id_mask = (1_u64 << PAIR_ID_BITS) - 1;
        let mut entries = pair_ranks
            .slots
            .iter()
            .filter(|packed| **packed != u64::MAX)
            .map(|packed| {
                let merged = (packed & id_mask) as u32;
                let key = packed >> PAIR_ID_BITS;
                let left = (key >> PAIR_ID_BITS) as u32;
                let right = (key & id_mask) as u32;
                (merged, left, right)
            })
            .collect::<Vec<_>>();
        entries.sort_unstable_by_key(|entry| entry.0);
        if entries.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
            return Err(WorkerImageError::DuplicateMergePair);
        }

        let entry_count =
            u32::try_from(entries.len()).map_err(|_| WorkerImageError::LengthOverflow)?;
        let mut bytes = vec![0_u8; REPLAY_HEADER_LEN];
        bytes[0..4].copy_from_slice(&REPLAY_MAGIC);
        bytes[4..6].copy_from_slice(&REPLAY_VERSION.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.index.vocab_size.to_le_bytes());
        bytes[12..16].copy_from_slice(&entry_count.to_le_bytes());
        for (_, left, right) in entries {
            write_u32_leb128(left, &mut bytes);
            write_u32_leb128(right, &mut bytes);
        }
        let digest = compute_digest(&bytes);
        bytes[32..64].copy_from_slice(&digest);
        Ok(bytes)
    }
}

impl PrebuiltReplayPairs {
    pub(crate) fn from_bytes(
        bytes: &[u8],
        expected_vocab_size: u32,
    ) -> Result<Self, WorkerImageError> {
        let entries = Self::parse_header_and_entries(bytes, Some(expected_vocab_size))?;
        if compute_digest(bytes) != bytes[32..64] {
            return Err(WorkerImageError::DigestMismatch);
        }
        Ok(Self { entries })
    }

    #[cfg(feature = "opt-resolver-provenance")]
    pub(crate) fn from_resolver_trusted_bytes(bytes: &[u8]) -> Result<Self, WorkerImageError> {
        let entries = Self::parse_header_and_entries(bytes, None)?;
        Ok(Self { entries })
    }

    fn parse_header_and_entries(
        bytes: &[u8],
        expected_vocab_size: Option<u32>,
    ) -> Result<Box<[(u32, u32)]>, WorkerImageError> {
        if bytes.len() < REPLAY_HEADER_LEN {
            return Err(WorkerImageError::Truncated);
        }
        if let Some(expected_vocab_size) = expected_vocab_size {
            if bytes[0..4] != REPLAY_MAGIC {
                return Err(WorkerImageError::BadMagic);
            }
            let version = u16::from_le_bytes(bytes[4..6].try_into().expect("fixed version field"));
            if version != REPLAY_VERSION {
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
        }
        let entry_count =
            u32::from_le_bytes(bytes[12..16].try_into().expect("fixed count field")) as usize;
        let mut cursor = REPLAY_HEADER_LEN;
        let mut entries = Vec::with_capacity(entry_count);
        for _ in 0..entry_count {
            let left = read_u32_leb128(bytes, &mut cursor)?;
            let right = read_u32_leb128(bytes, &mut cursor)?;
            entries.push((left, right));
        }
        if cursor != bytes.len() {
            return Err(WorkerImageError::LengthMismatch);
        }
        Ok(entries.into_boxed_slice())
    }

    pub(crate) fn into_entries(self) -> Box<[(u32, u32)]> {
        self.entries
    }
}

fn write_u32_leb128(mut value: u32, output: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            output.push(byte);
            return;
        }
        output.push(byte | 0x80);
    }
}

fn read_u32_leb128(bytes: &[u8], cursor: &mut usize) -> Result<u32, WorkerImageError> {
    let mut value = 0_u32;
    for shift in [0, 7, 14, 21, 28] {
        let byte = *bytes.get(*cursor).ok_or(WorkerImageError::Truncated)?;
        *cursor += 1;
        if shift == 28 && byte > 0x0f {
            return Err(WorkerImageError::PairIdOverflow);
        }
        value |= u32::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(WorkerImageError::PairIdOverflow)
}
