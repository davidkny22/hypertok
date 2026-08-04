use core::ops::Range;

use sha2::{Digest, Sha256};

pub const DIGEST_RANGE: Range<usize> = 32..64;

pub fn compute_digest(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    let prefix_end = DIGEST_RANGE.start.min(bytes.len());
    hasher.update(&bytes[..prefix_end]);

    if bytes.len() > DIGEST_RANGE.start {
        let zero_count = (bytes.len() - DIGEST_RANGE.start).min(DIGEST_RANGE.len());
        hasher.update([0_u8; 32].get(..zero_count).expect("bounded zero range"));
    }
    if bytes.len() > DIGEST_RANGE.end {
        hasher.update(&bytes[DIGEST_RANGE.end..]);
    }

    hasher.finalize().into()
}
