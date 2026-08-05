use icu::properties::CodePointSetData;
use icu::properties::props::{
    EnumeratedProperty, GeneralCategory, GeneralCategoryGroup, Script, WhiteSpace,
};

const CLASS_TABLE: &[u8; 0x110000 / 4] =
    include_bytes!("../../../../src/pretokenize/generated/char_class_icu4x_2_2_0.bin");
const DS_CLASS_TABLE: &[u8; 0x110000 / 2] =
    include_bytes!("../../../../src/pretokenize/generated/deepseek_class_icu4x_2_2_0.bin");
const O200K_CLASS_TABLE: &[u8; 0x110000 / 2] =
    include_bytes!("../../../../src/pretokenize/generated/o200k_class_icu4x_2_2_0.bin");
const KIMI_CLASS_TABLE: &[u8; 0x110000 / 2] =
    include_bytes!("../../../../src/pretokenize/generated/kimi_class_icu4x_2_2_0.bin");
const COMMAND_CLASS_TABLE: &[u8; 0x110000 / 4] =
    include_bytes!("../../../../src/pretokenize/generated/command_class_icu4x_2_2_0.bin");

fn quarter(table: &[u8], cp: u32) -> u8 {
    (table[(cp >> 2) as usize] >> ((cp & 3) << 1)) & 3
}

fn nibble(table: &[u8], cp: u32) -> u8 {
    (table[(cp >> 1) as usize] >> ((cp & 1) << 2)) & 0xF
}

fn main() {
    let whitespace = CodePointSetData::new::<WhiteSpace>();
    let mut checked = 0usize;
    for cp in 0..=char::MAX as u32 {
        let Some(c) = char::from_u32(cp) else {
            continue;
        };
        checked += 1;
        let gc = GeneralCategory::for_char(c);
        let is_whitespace = whitespace.contains(c);

        let base = if GeneralCategoryGroup::Letter.contains(gc) {
            0
        } else if GeneralCategoryGroup::Number.contains(gc) {
            1
        } else if is_whitespace {
            2
        } else {
            3
        };
        assert_eq!(quarter(CLASS_TABLE, cp), base, "base U+{cp:04X}");

        let deepseek = if GeneralCategoryGroup::Letter.contains(gc) {
            0
        } else if GeneralCategoryGroup::Number.contains(gc) {
            1
        } else if is_whitespace {
            2
        } else if GeneralCategoryGroup::Mark.contains(gc) {
            3
        } else if GeneralCategoryGroup::Punctuation.contains(gc)
            || GeneralCategoryGroup::Symbol.contains(gc)
        {
            4
        } else {
            5
        };
        assert_eq!(nibble(DS_CLASS_TABLE, cp), deepseek, "deepseek U+{cp:04X}");

        let o200k = match gc {
            GeneralCategory::UppercaseLetter | GeneralCategory::TitlecaseLetter => 0,
            GeneralCategory::LowercaseLetter => 1,
            GeneralCategory::ModifierLetter | GeneralCategory::OtherLetter => 2,
            _ if GeneralCategoryGroup::Mark.contains(gc) => 3,
            _ if GeneralCategoryGroup::Number.contains(gc) => 4,
            _ if is_whitespace => 5,
            _ => 6,
        };
        assert_eq!(nibble(O200K_CLASS_TABLE, cp), o200k, "o200k U+{cp:04X}");

        let kimi = if Script::for_char(c) == Script::Han {
            match o200k {
                4 => 8,
                3 | 6 => 9,
                _ => 7,
            }
        } else {
            o200k
        };
        assert_eq!(nibble(KIMI_CLASS_TABLE, cp), kimi, "kimi U+{cp:04X}");

        let command = if gc == GeneralCategory::DecimalNumber {
            2
        } else if GeneralCategoryGroup::Letter.contains(gc)
            || GeneralCategoryGroup::Mark.contains(gc)
            || GeneralCategoryGroup::Number.contains(gc)
            || gc == GeneralCategory::ConnectorPunctuation
        {
            1
        } else {
            0
        };
        assert_eq!(
            quarter(COMMAND_CLASS_TABLE, cp),
            command,
            "command U+{cp:04X}"
        );
    }
    assert_eq!(checked, 1_112_064);
    println!("verified {checked} Unicode scalar values across five tables");
}
