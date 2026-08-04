use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::hash::Hasher;

const MAGIC: [u8; 4] = *b"HFGO";
const VERSION: u16 = 1;
const HASHER_WYHASH: u8 = 1;
const GROUP_BITS: u8 = 4;
const GROUP_SIZE: usize = 1 << GROUP_BITS;
const SEED_BITS: u8 = 4;
const SEEDS_PER_WORD: usize = 64 / SEED_BITS as usize;
const HEADER_SIZE: usize = 32;
const FINGERPRINT_SEED: u64 = 0x4854_4b46_5052_4e54;
const TABLE_SEED: u64 = 0x4854_4b54_4142_4c45;

/// Derive the runtime fingerprint from a domain-separated hash lane.
///
/// The MPHF construction never consumes this lane, so an evaluated index does
/// not condition the fingerprint bits used to reject misses.
pub fn fingerprint(key: &[u8]) -> u8 {
    (hash_key(key, FINGERPRINT_SEED) >> 56) as u8
}

/// Hash a key for the load-built table with pinned wire-independent semantics.
pub fn table_hash(key: &[u8]) -> u64 {
    hash_key(key, TABLE_SEED)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImageError {
    Truncated,
    TrailingBytes,
    BadMagic,
    UnsupportedVersion(u16),
    UnsupportedHasher(u8),
    UnsupportedGroupBits(u8),
    UnsupportedSeedBits(u8),
    NonZeroReserved,
    EmptyLevels,
    ZeroLevel,
    CountOverflow,
    InconsistentBitWords,
    InconsistentSeedWords,
    NonZeroSeedPadding,
    KeyCountMismatch { declared: u32, observed: u32 },
}

impl Display for ImageError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => f.write_str("truncated hash image"),
            Self::TrailingBytes => f.write_str("trailing bytes in hash image"),
            Self::BadMagic => f.write_str("bad hash image magic"),
            Self::UnsupportedVersion(value) => write!(f, "unsupported hash image version {value}"),
            Self::UnsupportedHasher(value) => write!(f, "unsupported hash image hasher {value}"),
            Self::UnsupportedGroupBits(value) => {
                write!(f, "unsupported hash image group width {value}")
            }
            Self::UnsupportedSeedBits(value) => {
                write!(f, "unsupported hash image seed width {value}")
            }
            Self::NonZeroReserved => f.write_str("non-zero reserved hash image field"),
            Self::EmptyLevels => f.write_str("hash image has no levels"),
            Self::ZeroLevel => f.write_str("hash image contains an empty level"),
            Self::CountOverflow => f.write_str("hash image count overflow"),
            Self::InconsistentBitWords => f.write_str("hash image bit-word count is inconsistent"),
            Self::InconsistentSeedWords => {
                f.write_str("hash image seed-word count is inconsistent")
            }
            Self::NonZeroSeedPadding => f.write_str("hash image has non-zero seed padding"),
            Self::KeyCountMismatch { declared, observed } => {
                write!(
                    f,
                    "hash image declares {declared} keys but contains {observed} set bits"
                )
            }
        }
    }
}

impl Error for ImageError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VerifyError {
    KeyCount { expected: u32, observed: usize },
    MissingKey { position: usize },
    IndexOutOfRange { position: usize, index: u32 },
    DuplicateIndex { position: usize, index: u32 },
}

impl Display for VerifyError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::KeyCount { expected, observed } => {
                write!(
                    f,
                    "hash expects {expected} keys but verifier received {observed}"
                )
            }
            Self::MissingKey { position } => write!(f, "key {position} has no hash index"),
            Self::IndexOutOfRange { position, index } => {
                write!(f, "key {position} produced out-of-range index {index}")
            }
            Self::DuplicateIndex { position, index } => {
                write!(f, "key {position} duplicated index {index}")
            }
        }
    }
}

impl Error for VerifyError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HashImage {
    key_count: u32,
    level_sizes: Vec<u32>,
    bit_words: Vec<u64>,
    seed_words: Vec<u64>,
    rank_before_word: Vec<u32>,
}

impl HashImage {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ImageError> {
        if bytes.len() < HEADER_SIZE {
            return Err(ImageError::Truncated);
        }
        if bytes[0..4] != MAGIC {
            return Err(ImageError::BadMagic);
        }

        let version = read_u16(bytes, 4)?;
        if version != VERSION {
            return Err(ImageError::UnsupportedVersion(version));
        }
        if bytes[6] != HASHER_WYHASH {
            return Err(ImageError::UnsupportedHasher(bytes[6]));
        }
        if bytes[7] != GROUP_BITS {
            return Err(ImageError::UnsupportedGroupBits(bytes[7]));
        }
        if bytes[8] != SEED_BITS {
            return Err(ImageError::UnsupportedSeedBits(bytes[8]));
        }
        if bytes[9..12].iter().any(|value| *value != 0) || read_u32(bytes, 28)? != 0 {
            return Err(ImageError::NonZeroReserved);
        }

        let key_count = read_u32(bytes, 12)?;
        let level_count =
            usize::try_from(read_u32(bytes, 16)?).map_err(|_| ImageError::CountOverflow)?;
        let bit_word_count =
            usize::try_from(read_u32(bytes, 20)?).map_err(|_| ImageError::CountOverflow)?;
        let seed_word_count =
            usize::try_from(read_u32(bytes, 24)?).map_err(|_| ImageError::CountOverflow)?;
        if level_count == 0 {
            return Err(ImageError::EmptyLevels);
        }

        let levels_bytes = level_count
            .checked_mul(4)
            .ok_or(ImageError::CountOverflow)?;
        let bit_bytes = bit_word_count
            .checked_mul(8)
            .ok_or(ImageError::CountOverflow)?;
        let seed_bytes = seed_word_count
            .checked_mul(8)
            .ok_or(ImageError::CountOverflow)?;
        let expected_len = HEADER_SIZE
            .checked_add(levels_bytes)
            .and_then(|value| value.checked_add(bit_bytes))
            .and_then(|value| value.checked_add(seed_bytes))
            .ok_or(ImageError::CountOverflow)?;
        if bytes.len() < expected_len {
            return Err(ImageError::Truncated);
        }
        if bytes.len() > expected_len {
            return Err(ImageError::TrailingBytes);
        }

        let mut cursor = HEADER_SIZE;
        let mut level_sizes = Vec::with_capacity(level_count);
        for _ in 0..level_count {
            let size = read_u32(bytes, cursor)?;
            if size == 0 {
                return Err(ImageError::ZeroLevel);
            }
            level_sizes.push(size);
            cursor += 4;
        }
        let mut bit_words = Vec::with_capacity(bit_word_count);
        for _ in 0..bit_word_count {
            bit_words.push(read_u64(bytes, cursor)?);
            cursor += 8;
        }
        let mut seed_words = Vec::with_capacity(seed_word_count);
        for _ in 0..seed_word_count {
            seed_words.push(read_u64(bytes, cursor)?);
            cursor += 8;
        }

        Self::from_parts(key_count, level_sizes, bit_words, seed_words)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let capacity = HEADER_SIZE
            + self.level_sizes.len() * 4
            + self.bit_words.len() * 8
            + self.seed_words.len() * 8;
        let mut bytes = Vec::with_capacity(capacity);
        bytes.extend_from_slice(&MAGIC);
        bytes.extend_from_slice(&VERSION.to_le_bytes());
        bytes.push(HASHER_WYHASH);
        bytes.push(GROUP_BITS);
        bytes.push(SEED_BITS);
        bytes.extend_from_slice(&[0; 3]);
        bytes.extend_from_slice(&self.key_count.to_le_bytes());
        bytes.extend_from_slice(&(self.level_sizes.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(self.bit_words.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(self.seed_words.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        for value in &self.level_sizes {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in &self.bit_words {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in &self.seed_words {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    pub fn key_count(&self) -> u32 {
        self.key_count
    }

    /// Heap bytes retained by the owned evaluator after parsing.
    pub fn resident_bytes(&self) -> usize {
        self.level_sizes.capacity() * size_of::<u32>()
            + self.bit_words.capacity() * size_of::<u64>()
            + self.seed_words.capacity() * size_of::<u64>()
            + self.rank_before_word.capacity() * size_of::<u32>()
    }

    pub fn evaluate(&self, key: &[u8]) -> Option<u32> {
        let mut groups_before = 0usize;
        for (level, level_groups) in self.level_sizes.iter().copied().enumerate() {
            let hash = hash_key(key, level as u64);
            let level_groups = level_groups as usize;
            let group_in_level = map64(hash, level_groups as u64) as usize;
            let group = groups_before + group_in_level;
            let seed_word = self.seed_words[group / SEEDS_PER_WORD];
            let seed_shift = (group % SEEDS_PER_WORD) * SEED_BITS as usize;
            let seed = ((seed_word >> seed_shift) & 0x0f) as u32;
            let bit_in_group = mix32((hash as u32) ^ seed) as usize & (GROUP_SIZE - 1);
            let bit_index = group * GROUP_SIZE + bit_in_group;
            let word_index = bit_index / 64;
            let bit_in_word = bit_index % 64;
            let word = self.bit_words[word_index];
            let bit_mask = 1u64 << bit_in_word;
            if word & bit_mask != 0 {
                let lower_mask = bit_mask - 1;
                let index = self.rank_before_word[word_index] + (word & lower_mask).count_ones();
                return Some(index);
            }
            groups_before += level_groups;
        }
        None
    }

    pub fn verify_keys<K: AsRef<[u8]>>(&self, keys: &[K]) -> Result<(), VerifyError> {
        if keys.len() != self.key_count as usize {
            return Err(VerifyError::KeyCount {
                expected: self.key_count,
                observed: keys.len(),
            });
        }
        let mut seen = vec![false; self.key_count as usize];
        for (position, key) in keys.iter().enumerate() {
            let Some(index) = self.evaluate(key.as_ref()) else {
                return Err(VerifyError::MissingKey { position });
            };
            if index >= self.key_count {
                return Err(VerifyError::IndexOutOfRange { position, index });
            }
            if std::mem::replace(&mut seen[index as usize], true) {
                return Err(VerifyError::DuplicateIndex { position, index });
            }
        }
        Ok(())
    }

    pub(crate) fn from_parts(
        key_count: u32,
        level_sizes: Vec<u32>,
        bit_words: Vec<u64>,
        seed_words: Vec<u64>,
    ) -> Result<Self, ImageError> {
        if level_sizes.is_empty() {
            return Err(ImageError::EmptyLevels);
        }
        if level_sizes.contains(&0) {
            return Err(ImageError::ZeroLevel);
        }
        let group_count = level_sizes.iter().try_fold(0usize, |total, size| {
            total
                .checked_add(*size as usize)
                .ok_or(ImageError::CountOverflow)
        })?;
        let bit_count = group_count
            .checked_mul(GROUP_SIZE)
            .ok_or(ImageError::CountOverflow)?;
        if bit_count % 64 != 0 || bit_words.len() != bit_count / 64 {
            return Err(ImageError::InconsistentBitWords);
        }
        let expected_seed_words = group_count
            .checked_add(SEEDS_PER_WORD - 1)
            .ok_or(ImageError::CountOverflow)?
            / SEEDS_PER_WORD;
        if seed_words.len() != expected_seed_words {
            return Err(ImageError::InconsistentSeedWords);
        }
        let used_seeds_in_last_word = group_count % SEEDS_PER_WORD;
        if used_seeds_in_last_word != 0 {
            let used_bits = used_seeds_in_last_word * SEED_BITS as usize;
            if seed_words
                .last()
                .is_some_and(|word| *word >> used_bits != 0)
            {
                return Err(ImageError::NonZeroSeedPadding);
            }
        }

        let mut rank_before_word = Vec::with_capacity(bit_words.len());
        let mut observed = 0u32;
        for word in &bit_words {
            rank_before_word.push(observed);
            observed = observed
                .checked_add(word.count_ones())
                .ok_or(ImageError::CountOverflow)?;
        }
        if observed != key_count {
            return Err(ImageError::KeyCountMismatch {
                declared: key_count,
                observed,
            });
        }

        Ok(Self {
            key_count,
            level_sizes,
            bit_words,
            seed_words,
            rank_before_word,
        })
    }
}

fn hash_key(key: &[u8], seed: u64) -> u64 {
    let mut hasher = wyhash::WyHash::with_seed(seed);
    hasher.write_u64(key.len() as u64);
    hasher.write(key);
    hasher.finish()
}

fn map64(value: u64, range: u64) -> u64 {
    ((value as u128 * range as u128) >> 64) as u64
}

fn mix32(mut value: u32) -> u32 {
    value = (value ^ (value >> 16)).wrapping_mul(0x21f0_aaad);
    value = (value ^ (value >> 15)).wrapping_mul(0xd35a_2d97);
    value ^ (value >> 15)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, ImageError> {
    let source = bytes.get(offset..offset + 2).ok_or(ImageError::Truncated)?;
    Ok(u16::from_le_bytes([source[0], source[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, ImageError> {
    let source = bytes.get(offset..offset + 4).ok_or(ImageError::Truncated)?;
    Ok(u32::from_le_bytes(
        source.try_into().map_err(|_| ImageError::Truncated)?,
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, ImageError> {
    let source = bytes.get(offset..offset + 8).ok_or(ImageError::Truncated)?;
    Ok(u64::from_le_bytes(
        source.try_into().map_err(|_| ImageError::Truncated)?,
    ))
}
