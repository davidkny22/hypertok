//! WebAssembly relaxed-SIMD byte classifier for the shared mask scanner.

use core::arch::wasm32::*;

use super::mask::AsciiMasks;

const LETTER_FIRST: u8 = 0x80;
const LETTER_LAST: u8 = 0x40;
const DIGIT: u8 = 0x20;
const SPACE: u8 = 0x10;
const WHITESPACE: u8 = 0x08;
const NEWLINE: u8 = 0x04;
const APOSTROPHE: u8 = 0x02;
const SLASH: u8 = 0x01;

pub(crate) struct RelaxedAsciiMasks {
    pub(crate) ascii: AsciiMasks,
    pub(crate) up: u64,
    pub(crate) sl: u64,
}

#[inline(always)]
fn low_nibble_flags() -> v128 {
    u8x16(
        LETTER_LAST | DIGIT | SPACE,
        LETTER_FIRST | LETTER_LAST | DIGIT,
        LETTER_FIRST | LETTER_LAST | DIGIT,
        LETTER_FIRST | LETTER_LAST | DIGIT,
        LETTER_FIRST | LETTER_LAST | DIGIT,
        LETTER_FIRST | LETTER_LAST | DIGIT,
        LETTER_FIRST | LETTER_LAST | DIGIT,
        LETTER_FIRST | LETTER_LAST | DIGIT | APOSTROPHE,
        LETTER_FIRST | LETTER_LAST | DIGIT,
        LETTER_FIRST | LETTER_LAST | DIGIT | WHITESPACE,
        LETTER_FIRST | LETTER_LAST | WHITESPACE | NEWLINE,
        LETTER_FIRST | WHITESPACE,
        LETTER_FIRST | WHITESPACE,
        LETTER_FIRST | WHITESPACE | NEWLINE,
        LETTER_FIRST,
        LETTER_FIRST | SLASH,
    )
}

#[inline(always)]
fn high_nibble_flags() -> v128 {
    u8x16(
        WHITESPACE | NEWLINE,
        0,
        SPACE | APOSTROPHE | SLASH,
        DIGIT,
        LETTER_FIRST,
        LETTER_LAST,
        LETTER_FIRST,
        LETTER_LAST,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    )
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
fn shifted_bitmask(flags: v128, shift: u32) -> u16 {
    i8x16_bitmask(i8x16_shl(flags, shift)) as u16
}

#[inline(always)]
pub(crate) fn ascii_masks(bytes: &[u8], scan: usize) -> RelaxedAsciiMasks {
    let low_table = low_nibble_flags();
    let high_table = high_nibble_flags();
    let nibble_mask = u8x16_splat(0x0f);
    let letter_first = u8x16_splat(LETTER_FIRST);
    let letter_last = u8x16_splat(LETTER_LAST);
    let zero = u8x16_splat(0);
    let uppercase_bound = u8x16_splat(b'[');

    let mut letters = 0u64;
    let mut digits = 0u64;
    let mut spaces = 0u64;
    let mut whitespace = 0u64;
    let mut newlines = 0u64;
    let mut high_bytes = 0u64;
    let mut apostrophes = 0u64;
    let mut uppercase = 0u64;
    let mut slashes = 0u64;

    for (index, vector) in load4(bytes, scan).into_iter().enumerate() {
        let low = v128_and(vector, nibble_mask);
        let high = u8x16_shr(vector, 4);
        // Both index vectors are restricted to 0..=15, where relaxed swizzle
        // is exactly the ordinary table lookup on every conforming engine.
        let low_flags = i8x16_relaxed_swizzle(low_table, low);
        let high_flags = i8x16_relaxed_swizzle(high_table, high);
        let flags = v128_and(low_flags, high_flags);

        let first_letters = v128_and(flags, letter_first);
        let last_letters = i8x16_shl(v128_and(flags, letter_last), 1);
        let letter_lanes = v128_or(first_letters, last_letters);
        let uppercase_selector = u8x16_lt(vector, uppercase_bound);
        // The comparison produces only all-one and all-zero lanes. Under that
        // precondition relaxed lane select is exactly a bitwise select.
        let uppercase_lanes = i8x16_relaxed_laneselect(letter_lanes, zero, uppercase_selector);

        let offset = index * 16;
        letters |= u64::from(i8x16_bitmask(letter_lanes)) << offset;
        digits |= u64::from(shifted_bitmask(flags, 2)) << offset;
        spaces |= u64::from(shifted_bitmask(flags, 3)) << offset;
        whitespace |= u64::from(shifted_bitmask(flags, 4)) << offset;
        newlines |= u64::from(shifted_bitmask(flags, 5)) << offset;
        high_bytes |= u64::from(i8x16_bitmask(vector)) << offset;
        apostrophes |= u64::from(shifted_bitmask(flags, 6)) << offset;
        uppercase |= u64::from(i8x16_bitmask(uppercase_lanes)) << offset;
        slashes |= u64::from(shifted_bitmask(flags, 7)) << offset;
    }

    RelaxedAsciiMasks {
        ascii: AsciiMasks {
            l: letters,
            d: digits,
            s: spaces,
            wt: whitespace & !newlines,
            n: newlines,
            hi: high_bytes,
            ap: apostrophes,
        },
        up: uppercase,
        sl: slashes,
    }
}
