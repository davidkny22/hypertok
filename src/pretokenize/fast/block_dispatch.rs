//! Per-block refuge selection for the mask-scanner pretokenizers.

const BLOCK_BYTES: usize = 64;
const WORD_BYTES: usize = size_of::<u64>();
const HIGH_BITS: u64 = 0x8080_8080_8080_8080;

/// Route a homogeneous non-ASCII block through the existing scalar walker.
///
/// The mask scanner calls this only for complete 64-byte blocks. The safe
/// fixed-width conversions compile to unaligned word loads on the supported
/// targets and return after the first word containing an ASCII byte.
#[inline(always)]
pub(crate) fn prefer_scalar(bytes: &[u8], scan: usize) -> bool {
    debug_assert!(scan + BLOCK_BYTES <= bytes.len());
    for offset in (0..BLOCK_BYTES).step_by(WORD_BYTES) {
        let word = u64::from_ne_bytes(
            bytes[scan + offset..scan + offset + WORD_BYTES]
                .try_into()
                .expect("complete block word"),
        );
        if word & HIGH_BITS != HIGH_BITS {
            return false;
        }
    }
    true
}

/// Diagnostic counts for complete blocks: examined, scalar, mixed, ASCII.
///
/// This runs outside timed encoding. Its scalar count uses the exact decision
/// function called by the scanner; the other two buckets classify blocks that
/// remain on the vector path.
pub(crate) fn count_classes(bytes: &[u8]) -> [u32; 4] {
    let mut counts = [0_u32; 4];
    for scan in (0..=bytes.len().saturating_sub(BLOCK_BYTES)).step_by(BLOCK_BYTES) {
        if scan + BLOCK_BYTES > bytes.len() {
            break;
        }
        counts[0] = counts[0].saturating_add(1);
        if prefer_scalar(bytes, scan) {
            counts[1] = counts[1].saturating_add(1);
        } else if bytes[scan..scan + BLOCK_BYTES]
            .iter()
            .any(|byte| byte & 0x80 != 0)
        {
            counts[2] = counts[2].saturating_add(1);
        } else {
            counts[3] = counts[3].saturating_add(1);
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::{count_classes, prefer_scalar};

    #[test]
    fn classifies_complete_blocks() {
        let ascii = [b'a'; 64];
        let non_ascii = [0x80; 64];
        let mut mixed = [0x80; 64];
        mixed[63] = b' ';

        assert!(!prefer_scalar(&ascii, 0));
        assert!(prefer_scalar(&non_ascii, 0));
        assert!(!prefer_scalar(&mixed, 0));

        let mut joined = Vec::new();
        joined.extend_from_slice(&ascii);
        joined.extend_from_slice(&non_ascii);
        joined.extend_from_slice(&mixed);
        joined.extend_from_slice(b"tail");
        assert_eq!(count_classes(&joined), [3, 1, 1, 1]);
    }
}
