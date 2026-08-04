use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::hash::{Hash, Hasher};
use std::io;

use binout::{AsIs, Serializer, VByte};
use ph::fmph::{GOBuildConf, GOConf, GOFunction};
use ph::seedable_hash::BuildWyHash;
use ph::seeds::TwoToPowerBitsStatic;

use crate::{HashImage, ImageError};

type NativeFunction = GOFunction<TwoToPowerBitsStatic<4>, TwoToPowerBitsStatic<2>, BuildWyHash>;

const RELATIVE_LEVEL_SIZE: u16 = 100;
const CACHE_THRESHOLD: usize = 134_217_728;

#[derive(Clone, Copy)]
struct PortableKey<'a>(&'a [u8]);

impl Hash for PortableKey<'_> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_u64(self.0.len() as u64);
        state.write(self.0);
    }
}

#[derive(Debug)]
pub enum BuildError {
    EmptyKeySet,
    TooManyKeys,
    DuplicateKey,
    LibraryImage(io::Error),
    UnsupportedLibraryImage,
    Image(ImageError),
}

impl Display for BuildError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyKeySet => f.write_str("cannot build a hash for an empty key set"),
            Self::TooManyKeys => f.write_str("hash key count exceeds u32"),
            Self::DuplicateKey => f.write_str("hash key set contains a duplicate"),
            Self::LibraryImage(error) => write!(f, "FMPHGO image error: {error}"),
            Self::UnsupportedLibraryImage => f.write_str("unsupported FMPHGO library image"),
            Self::Image(error) => write!(f, "canonical hash image error: {error}"),
        }
    }
}

impl Error for BuildError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::LibraryImage(error) => Some(error),
            Self::Image(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ImageError> for BuildError {
    fn from(value: ImageError) -> Self {
        Self::Image(value)
    }
}

pub fn build<K: AsRef<[u8]>>(keys: &[K]) -> Result<HashImage, BuildError> {
    if keys.is_empty() {
        return Err(BuildError::EmptyKeySet);
    }
    let key_count = u32::try_from(keys.len()).map_err(|_| BuildError::TooManyKeys)?;
    let sorted = keys.iter().map(AsRef::as_ref).collect::<BTreeSet<_>>();
    if sorted.len() != keys.len() {
        return Err(BuildError::DuplicateKey);
    }
    let sorted = sorted.into_iter().map(PortableKey).collect::<Vec<_>>();

    let go_conf = GOConf::hash_bps_bpg(
        BuildWyHash,
        TwoToPowerBitsStatic::<2>,
        TwoToPowerBitsStatic::<4>,
    );
    let build_conf =
        GOBuildConf::with_lsize_ct_mt(go_conf, RELATIVE_LEVEL_SIZE, CACHE_THRESHOLD, false);
    let function = NativeFunction::from_slice_with_conf(&sorted, build_conf);
    let mut library_bytes = Vec::with_capacity(function.write_bytes());
    function
        .write(&mut library_bytes)
        .map_err(BuildError::LibraryImage)?;

    decode_library_image(key_count, &library_bytes)
}

fn decode_library_image(key_count: u32, bytes: &[u8]) -> Result<HashImage, BuildError> {
    let mut input = bytes;
    let group_size: u8 = AsIs::read(&mut input).map_err(BuildError::LibraryImage)?;
    if group_size != 16 {
        return Err(BuildError::UnsupportedLibraryImage);
    }
    let level_sizes: Box<[usize]> =
        VByte::read_array(&mut input).map_err(BuildError::LibraryImage)?;
    let level_sizes = level_sizes
        .iter()
        .map(|size| u32::try_from(*size).map_err(|_| BuildError::UnsupportedLibraryImage))
        .collect::<Result<Vec<_>, _>>()?;
    let group_count = level_sizes.iter().try_fold(0usize, |total, size| {
        total
            .checked_add(*size as usize)
            .ok_or(BuildError::UnsupportedLibraryImage)
    })?;
    let bit_word_count = group_count
        .checked_mul(16)
        .ok_or(BuildError::UnsupportedLibraryImage)?
        / 64;
    let bit_words: Box<[u64]> =
        AsIs::read_n(&mut input, bit_word_count).map_err(BuildError::LibraryImage)?;
    let seed_bits: u8 = AsIs::read(&mut input).map_err(BuildError::LibraryImage)?;
    if seed_bits != 4 {
        return Err(BuildError::UnsupportedLibraryImage);
    }
    let seed_word_count = group_count
        .checked_add(15)
        .ok_or(BuildError::UnsupportedLibraryImage)?
        / 16;
    let seed_words: Box<[u64]> =
        AsIs::read_n(&mut input, seed_word_count).map_err(BuildError::LibraryImage)?;
    if !input.is_empty() {
        return Err(BuildError::UnsupportedLibraryImage);
    }

    HashImage::from_parts(
        key_count,
        level_sizes,
        bit_words.into_vec(),
        seed_words.into_vec(),
    )
    .map_err(BuildError::Image)
}
