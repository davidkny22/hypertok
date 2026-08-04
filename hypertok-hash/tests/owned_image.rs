#![cfg(all(feature = "builder", not(target_arch = "wasm32")))]

use hypertok_hash::{BuildError, HashImage, ImageError, build};

fn keys(count: usize) -> Vec<Vec<u8>> {
    (0..count)
        .map(|index| format!("token/{index:08}/{}", index.wrapping_mul(2_654_435_761)).into_bytes())
        .collect()
}

#[test]
fn construction_is_deterministic_and_order_independent() {
    let keys = keys(4_096);
    let forward = build(&keys).unwrap().to_bytes();
    let mut reverse = keys.clone();
    reverse.reverse();
    let backward = build(&reverse).unwrap().to_bytes();
    assert_eq!(forward, backward);
}

#[test]
fn canonical_round_trip_is_a_permutation() {
    let keys = keys(8_192);
    let built = build(&keys).unwrap();
    let bytes = built.to_bytes();
    let read = HashImage::from_bytes(&bytes).unwrap();
    assert_eq!(read.to_bytes(), bytes);
    read.verify_keys(&keys).unwrap();
}

#[test]
fn misses_never_escape_the_declared_range() {
    let keys = keys(4_096);
    let image = build(&keys).unwrap();
    for index in 0..16_384 {
        let miss = format!("missing/{index:08}");
        assert!(
            image
                .evaluate(miss.as_bytes())
                .is_none_or(|value| value < image.key_count())
        );
    }
}

#[test]
fn duplicate_keys_are_refused() {
    let keys = [b"same".as_slice(), b"same".as_slice()];
    assert!(matches!(build(&keys), Err(BuildError::DuplicateKey)));
}

#[test]
fn malformed_and_mutated_images_are_detected() {
    let keys = keys(1_024);
    let bytes = build(&keys).unwrap().to_bytes();

    for end in 0..bytes.len() {
        assert!(HashImage::from_bytes(&bytes[..end]).is_err());
    }

    let mut bad_magic = bytes.clone();
    bad_magic[0] ^= 1;
    assert_eq!(HashImage::from_bytes(&bad_magic), Err(ImageError::BadMagic));

    let mut bad_reserved = bytes.clone();
    bad_reserved[9] = 1;
    assert_eq!(
        HashImage::from_bytes(&bad_reserved),
        Err(ImageError::NonZeroReserved)
    );

    let level_count = u32::from_le_bytes(bytes[16..20].try_into().unwrap()) as usize;
    let bit_words_offset = 32 + level_count * 4;
    let mut bad_bit = bytes;
    bad_bit[bit_words_offset] ^= 1;
    assert!(matches!(
        HashImage::from_bytes(&bad_bit),
        Err(ImageError::KeyCountMismatch { .. })
    ));
}
