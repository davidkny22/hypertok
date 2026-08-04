//! WebAssembly `simd128` byte classifiers for the shared mask scanner.

use core::arch::wasm32::*;

use super::mask::AsciiMasks;

#[inline(always)]
fn bitmask4(vectors: [v128; 4]) -> u64 {
    let mut mask = 0u64;
    for (index, vector) in vectors.into_iter().enumerate() {
        mask |= u64::from(i8x16_bitmask(vector)) << (index * 16);
    }
    mask
}

#[inline(always)]
fn load4(bytes: &[u8], scan: usize) -> [v128; 4] {
    debug_assert!(scan + 64 <= bytes.len());
    let pointer = bytes.as_ptr();
    // SAFETY: the caller's 64-byte batch contract keeps all four unaligned
    // loads within `bytes`; wasm `v128_load` permits unaligned addresses.
    unsafe {
        [
            v128_load(pointer.add(scan).cast()),
            v128_load(pointer.add(scan + 16).cast()),
            v128_load(pointer.add(scan + 32).cast()),
            v128_load(pointer.add(scan + 48).cast()),
        ]
    }
}

#[inline(always)]
pub(crate) fn ascii_masks(bytes: &[u8], scan: usize) -> AsciiMasks {
    let vectors = load4(bytes, scan);
    let zero = u8x16_splat(0);
    let mut letters = [zero; 4];
    let mut digits = [zero; 4];
    let mut spaces = [zero; 4];
    let mut whitespace = [zero; 4];
    let mut newlines = [zero; 4];
    let mut apostrophes = [zero; 4];

    for (index, vector) in vectors.into_iter().enumerate() {
        let lowered = v128_or(vector, u8x16_splat(0x20));
        letters[index] = u8x16_le(u8x16_sub(lowered, u8x16_splat(b'a')), u8x16_splat(25));
        digits[index] = u8x16_le(u8x16_sub(vector, u8x16_splat(b'0')), u8x16_splat(9));
        spaces[index] = u8x16_eq(vector, u8x16_splat(b' '));
        whitespace[index] = u8x16_le(u8x16_sub(vector, u8x16_splat(9)), u8x16_splat(4));
        newlines[index] = v128_or(
            u8x16_eq(vector, u8x16_splat(b'\r')),
            u8x16_eq(vector, u8x16_splat(b'\n')),
        );
        apostrophes[index] = u8x16_eq(vector, u8x16_splat(b'\''));
    }

    let n = bitmask4(newlines);
    AsciiMasks {
        l: bitmask4(letters),
        d: bitmask4(digits),
        s: bitmask4(spaces),
        wt: bitmask4(whitespace) & !n,
        n,
        hi: vectors
            .into_iter()
            .enumerate()
            .fold(0u64, |mask, (index, vector)| {
                mask | (u64::from(i8x16_bitmask(vector)) << (index * 16))
            }),
        ap: bitmask4(apostrophes),
    }
}

#[inline(always)]
pub(crate) fn byte_eq_mask(bytes: &[u8], scan: usize, byte: u8) -> u64 {
    let needle = u8x16_splat(byte);
    bitmask4(load4(bytes, scan).map(|vector| u8x16_eq(vector, needle)))
}

#[inline(always)]
pub(crate) fn byte_range_mask(bytes: &[u8], scan: usize, start: u8, width: u8) -> u64 {
    let start = u8x16_splat(start);
    let width = u8x16_splat(width);
    bitmask4(load4(bytes, scan).map(|vector| u8x16_le(u8x16_sub(vector, start), width)))
}
