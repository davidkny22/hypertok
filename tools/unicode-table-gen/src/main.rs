use icu::properties::CodePointMapData;
use icu::properties::CodePointSetData;
use icu::properties::props::{GeneralCategory, GeneralCategoryGroup, Script, WhiteSpace};
use std::path::Path;

const CODE_POINT_COUNT: usize = 0x110000;

#[derive(Clone, Copy)]
#[repr(u8)]
enum CharClass {
    Letter = 0,
    Number = 1,
    Whitespace = 2,
    Other = 3,
}

#[derive(Clone, Copy)]
#[repr(u8)]
enum DsCharClass {
    Letter = 0,
    Number = 1,
    Whitespace = 2,
    Mark = 3,
    PunctSym = 4,
    Other = 5,
}

#[derive(Clone, Copy)]
#[repr(u8)]
enum O200kCharClass {
    Upper = 0,
    Lower = 1,
    Caseless = 2,
    Mark = 3,
    Number = 4,
    Whitespace = 5,
    Other = 6,
}

#[repr(u8)]
enum KimiCharClass {
    Han = 7,
    HanNumber = 8,
    HanOther = 9,
}

#[derive(Clone, Copy)]
#[repr(u8)]
enum CommandCharClass {
    Other = 0,
    Word = 1,
    Decimal = 2,
}

fn pack_quarters(classes: &[u8]) -> Vec<u8> {
    classes
        .chunks_exact(4)
        .map(|c| c[0] | (c[1] << 2) | (c[2] << 4) | (c[3] << 6))
        .collect()
}

fn pack_nibbles(classes: &[u8]) -> Vec<u8> {
    classes
        .chunks_exact(2)
        .map(|c| c[0] | (c[1] << 4))
        .collect()
}

fn base_classes() -> Vec<u8> {
    let mut classes = vec![CharClass::Other as u8; CODE_POINT_COUNT];
    let gc = CodePointMapData::<GeneralCategory>::new();
    for (group, class) in [
        (GeneralCategoryGroup::Letter, CharClass::Letter),
        (GeneralCategoryGroup::Number, CharClass::Number),
    ] {
        for range in gc.iter_ranges_for_group(group) {
            classes[*range.start() as usize..=*range.end() as usize].fill(class as u8);
        }
    }
    for range in CodePointSetData::new::<WhiteSpace>().iter_ranges() {
        classes[*range.start() as usize..=*range.end() as usize].fill(CharClass::Whitespace as u8);
    }
    classes
}

fn deepseek_classes() -> Vec<u8> {
    let mut classes = vec![DsCharClass::Other as u8; CODE_POINT_COUNT];
    let gc = CodePointMapData::<GeneralCategory>::new();
    for (group, class) in [
        (GeneralCategoryGroup::Letter, DsCharClass::Letter),
        (GeneralCategoryGroup::Number, DsCharClass::Number),
        (GeneralCategoryGroup::Mark, DsCharClass::Mark),
        (GeneralCategoryGroup::Punctuation, DsCharClass::PunctSym),
        (GeneralCategoryGroup::Symbol, DsCharClass::PunctSym),
    ] {
        for range in gc.iter_ranges_for_group(group) {
            classes[*range.start() as usize..=*range.end() as usize].fill(class as u8);
        }
    }
    for range in CodePointSetData::new::<WhiteSpace>().iter_ranges() {
        classes[*range.start() as usize..=*range.end() as usize]
            .fill(DsCharClass::Whitespace as u8);
    }
    classes
}

fn o200k_classes() -> Vec<u8> {
    let mut classes = vec![O200kCharClass::Other as u8; CODE_POINT_COUNT];
    let gc = CodePointMapData::<GeneralCategory>::new();
    for (category, class) in [
        (GeneralCategory::UppercaseLetter, O200kCharClass::Upper),
        (GeneralCategory::TitlecaseLetter, O200kCharClass::Upper),
        (GeneralCategory::LowercaseLetter, O200kCharClass::Lower),
        (GeneralCategory::ModifierLetter, O200kCharClass::Caseless),
        (GeneralCategory::OtherLetter, O200kCharClass::Caseless),
    ] {
        for range in gc.iter_ranges_for_value(category) {
            classes[*range.start() as usize..=*range.end() as usize].fill(class as u8);
        }
    }
    for (group, class) in [
        (GeneralCategoryGroup::Mark, O200kCharClass::Mark),
        (GeneralCategoryGroup::Number, O200kCharClass::Number),
    ] {
        for range in gc.iter_ranges_for_group(group) {
            classes[*range.start() as usize..=*range.end() as usize].fill(class as u8);
        }
    }
    for range in CodePointSetData::new::<WhiteSpace>().iter_ranges() {
        classes[*range.start() as usize..=*range.end() as usize]
            .fill(O200kCharClass::Whitespace as u8);
    }
    classes
}

fn kimi_classes(mut classes: Vec<u8>) -> Vec<u8> {
    let script = CodePointMapData::<Script>::new();
    for range in script.iter_ranges_for_value(Script::Han) {
        for cp in *range.start()..=*range.end() {
            let slot = &mut classes[cp as usize];
            *slot = match *slot {
                c if c == O200kCharClass::Number as u8 => KimiCharClass::HanNumber as u8,
                c if c == O200kCharClass::Other as u8 || c == O200kCharClass::Mark as u8 => {
                    KimiCharClass::HanOther as u8
                }
                _ => KimiCharClass::Han as u8,
            };
        }
    }
    classes
}

fn command_classes() -> Vec<u8> {
    let mut classes = vec![CommandCharClass::Other as u8; CODE_POINT_COUNT];
    let gc = CodePointMapData::<GeneralCategory>::new();
    for group in [
        GeneralCategoryGroup::Letter,
        GeneralCategoryGroup::Mark,
        GeneralCategoryGroup::Number,
    ] {
        for range in gc.iter_ranges_for_group(group) {
            classes[*range.start() as usize..=*range.end() as usize]
                .fill(CommandCharClass::Word as u8);
        }
    }
    for range in gc.iter_ranges_for_value(GeneralCategory::ConnectorPunctuation) {
        classes[*range.start() as usize..=*range.end() as usize].fill(CommandCharClass::Word as u8);
    }
    for range in gc.iter_ranges_for_value(GeneralCategory::DecimalNumber) {
        classes[*range.start() as usize..=*range.end() as usize]
            .fill(CommandCharClass::Decimal as u8);
    }
    classes
}

fn write(output: &Path, name: &str, bytes: &[u8]) {
    let path = output.join(name);
    std::fs::write(&path, bytes).unwrap_or_else(|error| {
        panic!("failed to write {}: {error}", path.display());
    });
    println!("{} {}", path.display(), bytes.len());
}

fn main() {
    let output = std::env::args_os()
        .nth(1)
        .expect("usage: hypertok-unicode-table-gen OUTPUT_DIRECTORY");
    let output = Path::new(&output);
    std::fs::create_dir_all(output).unwrap_or_else(|error| {
        panic!("failed to create {}: {error}", output.display());
    });

    let base = base_classes();
    let deepseek = deepseek_classes();
    let o200k = o200k_classes();
    let kimi = kimi_classes(o200k.clone());
    let command = command_classes();

    write(output, "char_class_icu4x_2_2_0.bin", &pack_quarters(&base));
    write(
        output,
        "deepseek_class_icu4x_2_2_0.bin",
        &pack_nibbles(&deepseek),
    );
    write(output, "o200k_class_icu4x_2_2_0.bin", &pack_nibbles(&o200k));
    write(output, "kimi_class_icu4x_2_2_0.bin", &pack_nibbles(&kimi));
    write(
        output,
        "command_class_icu4x_2_2_0.bin",
        &pack_quarters(&command),
    );
}
