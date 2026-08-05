const CLASS_TABLE: &[u8; 0x110000 / 4] = include_bytes!("generated/char_class_icu4x_2_2_0.bin");
const DS_CLASS_TABLE: &[u8; 0x110000 / 2] =
    include_bytes!("generated/deepseek_class_icu4x_2_2_0.bin");
const O200K_CLASS_TABLE: &[u8; 0x110000 / 2] =
    include_bytes!("generated/o200k_class_icu4x_2_2_0.bin");
const KIMI_CLASS_TABLE: &[u8; 0x110000 / 2] =
    include_bytes!("generated/kimi_class_icu4x_2_2_0.bin");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum CharClass {
    Letter = 0,
    Number = 1,
    Whitespace = 2,
    Other = 3,
}

#[derive(Clone, Copy)]
pub(crate) struct ClassTable(&'static [u8]);

impl ClassTable {
    #[inline]
    pub(crate) fn get() -> Self {
        Self(CLASS_TABLE)
    }

    #[inline(always)]
    pub(crate) fn class_of(self, cp: u32) -> CharClass {
        debug_assert!(cp < 0x110000);
        // SAFETY: the only constructor supplies the complete 2-bit table,
        // and every valid code point maps below its 278,528-byte length.
        let byte = unsafe { *self.0.get_unchecked((cp >> 2) as usize) };
        match (byte >> ((cp & 3) << 1)) & 3 {
            0 => CharClass::Letter,
            1 => CharClass::Number,
            2 => CharClass::Whitespace,
            _ => CharClass::Other,
        }
    }
}

#[inline(always)]
pub(crate) fn class_of(cp: u32) -> CharClass {
    ClassTable::get().class_of(cp)
}

#[inline]
pub(crate) fn is_whitespace(c: char) -> bool {
    class_of(c as u32) == CharClass::Whitespace
}

#[inline]
pub(crate) fn is_letter(c: char) -> bool {
    class_of(c as u32) == CharClass::Letter
}

#[inline]
pub(crate) fn is_number(c: char) -> bool {
    class_of(c as u32) == CharClass::Number
}

#[inline]
pub(crate) fn is_other_complete(c: char) -> bool {
    if c.is_ascii() {
        return !c.is_ascii_alphanumeric() && !c.is_ascii_whitespace();
    }
    class_of(c as u32) == CharClass::Other
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum DsCharClass {
    Letter = 0,
    Number = 1,
    Whitespace = 2,
    Mark = 3,
    PunctSym = 4,
    Other = 5,
}

#[derive(Clone, Copy)]
pub(crate) struct DsClassTable(&'static [u8]);

impl DsClassTable {
    #[inline]
    pub(crate) fn get() -> Self {
        Self(DS_CLASS_TABLE)
    }

    #[inline(always)]
    pub(crate) fn ds_class_of(self, cp: u32) -> DsCharClass {
        debug_assert!(cp < 0x110000);
        // SAFETY: the only constructor supplies the complete nibble table,
        // and every valid code point maps below its 557,056-byte length.
        let byte = unsafe { *self.0.get_unchecked((cp >> 1) as usize) };
        match (byte >> ((cp & 1) << 2)) & 0xF {
            0 => DsCharClass::Letter,
            1 => DsCharClass::Number,
            2 => DsCharClass::Whitespace,
            3 => DsCharClass::Mark,
            4 => DsCharClass::PunctSym,
            _ => DsCharClass::Other,
        }
    }

    #[inline(always)]
    pub(crate) fn class_of_marks_join(self, cp: u32) -> CharClass {
        match self.ds_class_of(cp) {
            DsCharClass::Letter | DsCharClass::Mark => CharClass::Letter,
            DsCharClass::Number => CharClass::Number,
            DsCharClass::Whitespace => CharClass::Whitespace,
            DsCharClass::PunctSym | DsCharClass::Other => CharClass::Other,
        }
    }
}

#[inline(always)]
pub(crate) fn class_of_marks_join(cp: u32) -> CharClass {
    DsClassTable::get().class_of_marks_join(cp)
}

#[inline(always)]
pub(crate) fn ds_class_of(cp: u32) -> DsCharClass {
    DsClassTable::get().ds_class_of(cp)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum O200kCharClass {
    Upper = 0,
    Lower = 1,
    Caseless = 2,
    Mark = 3,
    Number = 4,
    Whitespace = 5,
    Other = 6,
}

#[inline(always)]
pub(crate) fn o200k_class_of(cp: u32) -> O200kCharClass {
    debug_assert!(cp < 0x110000);
    // SAFETY: the included nibble table covers every code point, and the
    // caller contract restricts cp to that range.
    let byte = unsafe { *O200K_CLASS_TABLE.get_unchecked((cp >> 1) as usize) };
    match (byte >> ((cp & 1) << 2)) & 0xF {
        0 => O200kCharClass::Upper,
        1 => O200kCharClass::Lower,
        2 => O200kCharClass::Caseless,
        3 => O200kCharClass::Mark,
        4 => O200kCharClass::Number,
        5 => O200kCharClass::Whitespace,
        _ => O200kCharClass::Other,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum KimiCharClass {
    Upper = 0,
    Lower = 1,
    Caseless = 2,
    Mark = 3,
    Number = 4,
    Whitespace = 5,
    Other = 6,
    Han = 7,
    HanNumber = 8,
    HanOther = 9,
}

impl KimiCharClass {
    #[inline(always)]
    pub(crate) fn base(self) -> O200kCharClass {
        match self {
            Self::Upper => O200kCharClass::Upper,
            Self::Lower => O200kCharClass::Lower,
            Self::Caseless | Self::Han => O200kCharClass::Caseless,
            Self::Mark => O200kCharClass::Mark,
            Self::Number | Self::HanNumber => O200kCharClass::Number,
            Self::Whitespace => O200kCharClass::Whitespace,
            Self::Other | Self::HanOther => O200kCharClass::Other,
        }
    }

    #[inline(always)]
    pub(crate) fn is_han(self) -> bool {
        self as u8 >= Self::Han as u8
    }
}

#[inline(always)]
pub(crate) fn kimi_class_of(cp: u32) -> KimiCharClass {
    debug_assert!(cp < 0x110000);
    // SAFETY: the included nibble table covers every code point, and the
    // caller contract restricts cp to that range.
    let byte = unsafe { *KIMI_CLASS_TABLE.get_unchecked((cp >> 1) as usize) };
    match (byte >> ((cp & 1) << 2)) & 0xF {
        0 => KimiCharClass::Upper,
        1 => KimiCharClass::Lower,
        2 => KimiCharClass::Caseless,
        3 => KimiCharClass::Mark,
        4 => KimiCharClass::Number,
        5 => KimiCharClass::Whitespace,
        6 => KimiCharClass::Other,
        7 => KimiCharClass::Han,
        8 => KimiCharClass::HanNumber,
        _ => KimiCharClass::HanOther,
    }
}

#[inline(always)]
pub(crate) fn is_deepseek_cjk(cp: u32) -> bool {
    (0x4E00..=0x9FA5).contains(&cp) || (0x3040..=0x30FF).contains(&cp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical_whitespace(cp: u32) -> bool {
        matches!(
            cp,
            0x0009..=0x000d
                | 0x0020
                | 0x0085
                | 0x00a0
                | 0x1680
                | 0x2000..=0x200a
                | 0x2028..=0x2029
                | 0x202f
                | 0x205f
                | 0x3000
        )
    }

    #[test]
    fn every_classifier_uses_unicode_white_space() {
        for cp in 0..=char::MAX as u32 {
            let Some(value) = char::from_u32(cp) else {
                continue;
            };
            let expected = canonical_whitespace(cp);
            assert_eq!(
                value.is_whitespace(),
                expected,
                "Rust White_Space U+{cp:04X}"
            );
            assert_eq!(
                class_of(cp) == CharClass::Whitespace,
                expected,
                "base U+{cp:04X}"
            );
            assert_eq!(
                ds_class_of(cp) == DsCharClass::Whitespace,
                expected,
                "deepseek U+{cp:04X}"
            );
            assert_eq!(
                o200k_class_of(cp) == O200kCharClass::Whitespace,
                expected,
                "o200k U+{cp:04X}"
            );
            assert_eq!(
                kimi_class_of(cp).base() == O200kCharClass::Whitespace,
                expected,
                "kimi U+{cp:04X}"
            );
        }
    }

    #[test]
    fn whitespace_edge_points_are_canonical() {
        for cp in [0x200b, 0x2060, 0xfeff] {
            assert!(!canonical_whitespace(cp), "U+{cp:04X}");
            assert_ne!(class_of(cp), CharClass::Whitespace, "U+{cp:04X}");
        }
        for cp in [0x0085, 0x00a0, 0x2028, 0x202f] {
            assert!(canonical_whitespace(cp), "U+{cp:04X}");
            assert_eq!(class_of(cp), CharClass::Whitespace, "U+{cp:04X}");
        }
    }
}
