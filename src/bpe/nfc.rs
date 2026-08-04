use super::source_map::SourceSpan;

const IMAGE: &[u8; 19_011] = include_bytes!("generated/nfc_unicode_17_0_0.bin");

const SINGLETON_COUNT: usize = 1_035;
const PAIR_COUNT: usize = 1_046;
const COMPOSITION_COUNT: usize = 961;
const CCC_RANGE_COUNT: usize = 403;
const QC_NO_RANGE_COUNT: usize = 74;
const QC_MAYBE_RANGE_COUNT: usize = 50;

const SINGLETON_START: usize = 0;
const PAIR_START: usize = SINGLETON_START + SINGLETON_COUNT * 6;
const COMPOSITION_START: usize = PAIR_START + PAIR_COUNT * 8;
const CCC_START: usize = COMPOSITION_START + COMPOSITION_COUNT * 2;
const QC_NO_START: usize = CCC_START + CCC_RANGE_COUNT * 5;
const QC_MAYBE_START: usize = QC_NO_START + QC_NO_RANGE_COUNT * 4;
const IMAGE_END: usize = QC_MAYBE_START + QC_MAYBE_RANGE_COUNT * 4;

const HANGUL_S_BASE: u32 = 0xAC00;
const HANGUL_L_BASE: u32 = 0x1100;
const HANGUL_V_BASE: u32 = 0x1161;
const HANGUL_T_BASE: u32 = 0x11A7;
const HANGUL_L_COUNT: u32 = 19;
const HANGUL_V_COUNT: u32 = 21;
const HANGUL_T_COUNT: u32 = 28;
const HANGUL_N_COUNT: u32 = HANGUL_V_COUNT * HANGUL_T_COUNT;
const HANGUL_S_COUNT: u32 = HANGUL_L_COUNT * HANGUL_N_COUNT;

const _: () = assert!(IMAGE_END == IMAGE.len());

#[derive(Clone, Copy)]
struct Data<'a> {
    bytes: &'a [u8],
}

impl Data<'static> {
    const fn shipped() -> Self {
        Self { bytes: IMAGE }
    }
}

#[derive(Clone, Copy)]
struct Unit {
    ch: char,
    span: SourceSpan,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum QuickCheck {
    Yes,
    No,
    Maybe,
}

pub(crate) fn is_normalized(input: &str) -> bool {
    is_normalized_with(Data::shipped(), input)
}

pub(crate) fn normalize_to(input: &str, output: &mut String) {
    normalize_to_with(Data::shipped(), input, output);
}

pub(crate) fn normalize_with_spans(
    input: &str,
    byte_spans: &[SourceSpan],
) -> (String, Vec<SourceSpan>) {
    debug_assert_eq!(input.len(), byte_spans.len());
    if is_normalized(input) {
        return (input.to_owned(), byte_spans.to_vec());
    }
    let mut decomposed = Vec::with_capacity(input.chars().count() + 4);
    for (start, ch) in input.char_indices() {
        let end = start + ch.len_utf8();
        let span = union_span(&byte_spans[start..end]);
        decompose(Data::shipped(), ch, span, &mut decomposed);
    }
    reorder(Data::shipped(), &mut decomposed);
    let composed = compose_units(Data::shipped(), decomposed);
    encode_units(&composed, true)
}

fn is_normalized_with(data: Data<'_>, input: &str) -> bool {
    match quick_check_with(data, input) {
        QuickCheck::Yes => true,
        QuickCheck::No => false,
        QuickCheck::Maybe => {
            let mut normalized = String::with_capacity(input.len());
            normalize_slow_with(data, input, &mut normalized);
            normalized == input
        }
    }
}

fn quick_check_with(data: Data<'_>, input: &str) -> QuickCheck {
    let mut starter = None;
    let mut previous_ccc = 0;
    let mut result = QuickCheck::Yes;
    for ch in input.chars() {
        let codepoint = u32::from(ch);
        if range_contains(data, QC_NO_START, QC_NO_RANGE_COUNT, codepoint) {
            return QuickCheck::No;
        }
        let ccc = combining_class(data, codepoint);
        if ccc != 0 && previous_ccc > ccc {
            return QuickCheck::No;
        }
        if range_contains(data, QC_MAYBE_START, QC_MAYBE_RANGE_COUNT, codepoint) {
            if starter.is_some_and(|first| {
                (previous_ccc == 0 || previous_ccc < ccc) && compose_pair(data, first, ch).is_some()
            }) {
                return QuickCheck::No;
            }
            result = QuickCheck::Maybe;
        }
        if ccc == 0 {
            starter = Some(ch);
        }
        previous_ccc = ccc;
    }
    result
}

fn normalize_to_with(data: Data<'_>, input: &str, output: &mut String) {
    output.clear();
    if quick_check_with(data, input) == QuickCheck::Yes {
        output.push_str(input);
        return;
    }
    normalize_slow_with(data, input, output);
}

fn normalize_slow_with(data: Data<'_>, input: &str, output: &mut String) {
    let placeholder = SourceSpan { start: 0, end: 0 };
    let mut decomposed = Vec::with_capacity(input.chars().count() + 4);
    for ch in input.chars() {
        decompose(data, ch, placeholder, &mut decomposed);
    }
    reorder(data, &mut decomposed);
    let composed = compose_units(data, decomposed);
    output.reserve(composed.len());
    for unit in composed {
        output.push(unit.ch);
    }
}

fn decompose(data: Data<'_>, ch: char, span: SourceSpan, output: &mut Vec<Unit>) {
    let codepoint = u32::from(ch);
    let hangul = codepoint.wrapping_sub(HANGUL_S_BASE);
    if hangul < HANGUL_S_COUNT {
        let lead = HANGUL_L_BASE + hangul / HANGUL_N_COUNT;
        let vowel = HANGUL_V_BASE + (hangul % HANGUL_N_COUNT) / HANGUL_T_COUNT;
        push_scalar(lead, span, output);
        push_scalar(vowel, span, output);
        let trail = hangul % HANGUL_T_COUNT;
        if trail != 0 {
            push_scalar(HANGUL_T_BASE + trail, span, output);
        }
        return;
    }
    if let Some(value) = singleton_decomposition(data, codepoint) {
        decompose(data, scalar(value), span, output);
        return;
    }
    if let Some((first, second)) = pair_decomposition(data, codepoint) {
        decompose(data, scalar(first), span, output);
        decompose(data, scalar(second), span, output);
        return;
    }
    output.push(Unit { ch, span });
}

fn push_scalar(codepoint: u32, span: SourceSpan, output: &mut Vec<Unit>) {
    output.push(Unit {
        ch: scalar(codepoint),
        span,
    });
}

fn reorder(data: Data<'_>, units: &mut [Unit]) {
    for index in 1..units.len() {
        let ccc = combining_class(data, u32::from(units[index].ch));
        if ccc == 0 {
            continue;
        }
        let mut position = index;
        while position != 0 {
            let previous = combining_class(data, u32::from(units[position - 1].ch));
            if previous == 0 || previous <= ccc {
                break;
            }
            units.swap(position - 1, position);
            position -= 1;
        }
    }
}

fn compose_units(data: Data<'_>, decomposed: Vec<Unit>) -> Vec<Unit> {
    let mut output: Vec<Unit> = Vec::with_capacity(decomposed.len());
    let mut starter_index: Option<usize> = None;
    let mut previous_ccc = 0;
    for unit in decomposed {
        let ccc = combining_class(data, u32::from(unit.ch));
        if let Some(index) = starter_index
            && (previous_ccc == 0 || previous_ccc < ccc)
            && let Some(composite) = compose_pair(data, output[index].ch, unit.ch)
        {
            output[index].ch = composite;
            output[index].span = union_two(output[index].span, unit.span);
            continue;
        }
        if ccc == 0 {
            starter_index = Some(output.len());
        }
        previous_ccc = ccc;
        output.push(unit);
    }
    output
}

fn encode_units(units: &[Unit], include_spans: bool) -> (String, Vec<SourceSpan>) {
    let mut text = String::new();
    let mut spans = Vec::new();
    for unit in units {
        let start = text.len();
        text.push(unit.ch);
        if include_spans {
            spans.extend(std::iter::repeat_n(unit.span, text.len() - start));
        }
    }
    (text, spans)
}

fn singleton_decomposition(data: Data<'_>, target: u32) -> Option<u32> {
    let index = binary_search(
        SINGLETON_COUNT,
        |index| {
            let packed = read_u48(data.bytes, SINGLETON_START + index * 6);
            (packed & 0x1F_FFFF) as u32
        },
        target,
    )?;
    let packed = read_u48(data.bytes, SINGLETON_START + index * 6);
    Some(((packed >> 21) & 0x1F_FFFF) as u32)
}

fn pair_decomposition(data: Data<'_>, target: u32) -> Option<(u32, u32)> {
    let index = binary_search(PAIR_COUNT, |index| decode_pair(data, index).0, target)?;
    let (_, first, second) = decode_pair(data, index);
    Some((first, second))
}

fn compose_pair(data: Data<'_>, first: char, second: char) -> Option<char> {
    let first_codepoint = u32::from(first);
    let second_codepoint = u32::from(second);
    let lead = first_codepoint.wrapping_sub(HANGUL_L_BASE);
    let vowel = second_codepoint.wrapping_sub(HANGUL_V_BASE);
    if lead < HANGUL_L_COUNT && vowel < HANGUL_V_COUNT {
        return Some(scalar(
            HANGUL_S_BASE + (lead * HANGUL_V_COUNT + vowel) * HANGUL_T_COUNT,
        ));
    }
    let syllable = first_codepoint.wrapping_sub(HANGUL_S_BASE);
    let trail = second_codepoint.wrapping_sub(HANGUL_T_BASE);
    if syllable < HANGUL_S_COUNT
        && syllable % HANGUL_T_COUNT == 0
        && (1..HANGUL_T_COUNT).contains(&trail)
    {
        return Some(scalar(first_codepoint + trail));
    }

    let target = (first_codepoint, second_codepoint);
    let mut low = 0;
    let mut high = COMPOSITION_COUNT;
    while low < high {
        let middle = low + (high - low) / 2;
        let pair_index = usize::from(read_u16(data.bytes, COMPOSITION_START + middle * 2));
        let (composite, left, right) = decode_pair(data, pair_index);
        match (left, right).cmp(&target) {
            std::cmp::Ordering::Less => low = middle + 1,
            std::cmp::Ordering::Greater => high = middle,
            std::cmp::Ordering::Equal => return Some(scalar(composite)),
        }
    }
    None
}

fn combining_class(data: Data<'_>, codepoint: u32) -> u8 {
    let mut low = 0;
    let mut high = CCC_RANGE_COUNT;
    while low < high {
        let middle = low + (high - low) / 2;
        let packed = read_u40(data.bytes, CCC_START + middle * 5);
        let start = (packed & 0x1F_FFFF) as u32;
        let end = start + ((packed >> 21) & 0x3F) as u32;
        if codepoint < start {
            high = middle;
        } else if codepoint > end {
            low = middle + 1;
        } else {
            return ((packed >> 27) & 0xFF) as u8;
        }
    }
    0
}

fn range_contains(data: Data<'_>, start: usize, count: usize, codepoint: u32) -> bool {
    let mut low = 0;
    let mut high = count;
    while low < high {
        let middle = low + (high - low) / 2;
        let packed = read_u32(data.bytes, start + middle * 4);
        let range_start = packed & 0x1F_FFFF;
        let range_end = range_start + ((packed >> 21) & 0x3FF);
        if codepoint < range_start {
            high = middle;
        } else if codepoint > range_end {
            low = middle + 1;
        } else {
            return true;
        }
    }
    false
}

fn decode_pair(data: Data<'_>, index: usize) -> (u32, u32, u32) {
    let packed = read_u64(data.bytes, PAIR_START + index * 8);
    (
        (packed & 0x1F_FFFF) as u32,
        ((packed >> 21) & 0x1F_FFFF) as u32,
        ((packed >> 42) & 0x1F_FFFF) as u32,
    )
}

fn binary_search(count: usize, value: impl Fn(usize) -> u32, target: u32) -> Option<usize> {
    let mut low = 0;
    let mut high = count;
    while low < high {
        let middle = low + (high - low) / 2;
        match value(middle).cmp(&target) {
            std::cmp::Ordering::Less => low = middle + 1,
            std::cmp::Ordering::Greater => high = middle,
            std::cmp::Ordering::Equal => return Some(middle),
        }
    }
    None
}

fn read_u16(bytes: &[u8], start: usize) -> u16 {
    u16::from_le_bytes([bytes[start], bytes[start + 1]])
}

fn read_u32(bytes: &[u8], start: usize) -> u32 {
    u32::from_le_bytes([
        bytes[start],
        bytes[start + 1],
        bytes[start + 2],
        bytes[start + 3],
    ])
}

fn read_u40(bytes: &[u8], start: usize) -> u64 {
    u64::from_le_bytes([
        bytes[start],
        bytes[start + 1],
        bytes[start + 2],
        bytes[start + 3],
        bytes[start + 4],
        0,
        0,
        0,
    ])
}

fn read_u48(bytes: &[u8], start: usize) -> u64 {
    u64::from_le_bytes([
        bytes[start],
        bytes[start + 1],
        bytes[start + 2],
        bytes[start + 3],
        bytes[start + 4],
        bytes[start + 5],
        0,
        0,
    ])
}

fn read_u64(bytes: &[u8], start: usize) -> u64 {
    u64::from_le_bytes(
        bytes[start..start + 8]
            .try_into()
            .expect("eight-byte record"),
    )
}

fn scalar(codepoint: u32) -> char {
    char::from_u32(codepoint).expect("generated data contains only Unicode scalars")
}

fn union_span(spans: &[SourceSpan]) -> SourceSpan {
    debug_assert!(!spans.is_empty());
    spans
        .iter()
        .copied()
        .reduce(union_two)
        .unwrap_or(SourceSpan { start: 0, end: 0 })
}

fn union_two(first: SourceSpan, second: SourceSpan) -> SourceSpan {
    SourceSpan {
        start: first.start.min(second.start),
        end: first.end.max(second.end),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashSet;

    #[test]
    fn normalizes_canonical_and_hangul_cases() {
        let cases = [
            ("plain ASCII", "plain ASCII"),
            ("A\u{030A}", "\u{00C5}"),
            ("\u{212B}", "\u{00C5}"),
            ("\u{1EAD}", "\u{1EAD}"),
            ("\u{1100}\u{1161}\u{11A8}", "\u{AC01}"),
            ("q\u{0315}\u{0300}", "q\u{0300}\u{0315}"),
        ];
        for (input, expected) in cases {
            let mut actual = String::new();
            normalize_to(input, &mut actual);
            assert_eq!(actual, expected, "input {input:?}");
            assert_eq!(is_normalized(input), input == expected, "input {input:?}");
            assert!(is_normalized(expected));
        }
    }

    #[test]
    fn changed_output_unions_original_spans() {
        let input = "A\u{030A}\u{1100}\u{1161}";
        let spans: Vec<SourceSpan> = (0..input.len())
            .map(|index| SourceSpan {
                start: u32::try_from(index + 10).unwrap(),
                end: u32::try_from(index + 11).unwrap(),
            })
            .collect();
        let (output, mapped) = normalize_with_spans(input, &spans);
        assert_eq!(output, "\u{00C5}\u{AC00}");
        assert_eq!(mapped.len(), output.len());
        assert!(
            mapped[..2]
                .iter()
                .all(|span| *span == SourceSpan { start: 10, end: 13 })
        );
        assert!(
            mapped[2..]
                .iter()
                .all(|span| *span == SourceSpan { start: 13, end: 19 })
        );
    }

    #[test]
    #[ignore = "full Unicode 17.0.0 conformance gate"]
    fn exhaustive_unicode_17() {
        let directory = std::path::PathBuf::from(
            std::env::var_os("HYPERTOK_UCD_DIR").expect("HYPERTOK_UCD_DIR is required"),
        );
        let mutation = std::env::var("HYPERTOK_NFC_MUTATION").ok();
        let mut mutated = IMAGE.to_vec();
        match mutation.as_deref() {
            None => {}
            Some("decomposition") => mutated[SINGLETON_START + 3] ^= 1,
            Some("quick-check") => mutated[QC_NO_START] ^= 1,
            Some(other) => panic!("unknown HYPERTOK_NFC_MUTATION {other:?}"),
        }
        let data = Data { bytes: &mutated };
        let reference = icu::normalizer::ComposingNormalizer::new_nfc();
        let assigned = assigned_scalars(&directory.join("UnicodeData.txt"));
        assert_eq!(assigned.len(), 297_334);

        let mut input = String::with_capacity(4);
        let mut portable = String::with_capacity(12);
        let mut expected = String::with_capacity(12);
        let mut scalar_count = 0_usize;
        let mut assigned_count = 0_usize;
        for codepoint in 0..=0x10_FFFF {
            let Some(ch) = char::from_u32(codepoint) else {
                continue;
            };
            input.clear();
            input.push(ch);
            normalize_to_with(data, &input, &mut portable);
            expected.clear();
            reference
                .normalize_to(&input, &mut expected)
                .expect("writing to a String cannot fail");
            assert_eq!(
                portable, expected,
                "normalization mismatch at U+{codepoint:04X}"
            );
            assert_eq!(
                is_normalized_with(data, &input),
                reference.is_normalized(&input),
                "quick-check mismatch at U+{codepoint:04X}"
            );
            scalar_count += 1;
            assigned_count += usize::from(assigned.contains(&codepoint));
        }
        assert_eq!(scalar_count, 1_112_064);
        assert_eq!(assigned_count, 297_334);

        let mut composition_count = 0_usize;
        for position in 0..COMPOSITION_COUNT {
            let pair_index = usize::from(read_u16(data.bytes, COMPOSITION_START + position * 2));
            let (composite, first, second) = decode_pair(data, pair_index);
            assert_eq!(
                compose_pair(data, scalar(first), scalar(second)),
                Some(scalar(composite)),
                "composition mismatch for U+{first:04X} U+{second:04X}"
            );
            composition_count += 1;
        }

        let test_text = std::fs::read_to_string(directory.join("NormalizationTest.txt"))
            .expect("read NormalizationTest.txt");
        let mut rows = 0_usize;
        let mut columns = 0_usize;
        for line in test_text.lines() {
            let body = line.split('#').next().unwrap_or_default().trim();
            if body.is_empty() || body.starts_with('@') {
                continue;
            }
            let fields: Vec<&str> = body.split(';').map(str::trim).collect();
            assert!(fields.len() >= 5, "malformed normalization row {body:?}");
            let values: Vec<String> = fields[..5]
                .iter()
                .map(|field| decode_sequence(field))
                .collect();
            for (index, value) in values.iter().enumerate() {
                let normative = if index < 3 { &values[1] } else { &values[3] };
                normalize_to_with(data, value, &mut portable);
                assert_eq!(
                    &portable,
                    normative,
                    "normative row {} column {}",
                    rows + 1,
                    index + 1
                );
                expected.clear();
                reference
                    .normalize_to(value, &mut expected)
                    .expect("writing to a String cannot fail");
                assert_eq!(
                    portable,
                    expected,
                    "ICU row {} column {}",
                    rows + 1,
                    index + 1
                );
                assert_eq!(
                    is_normalized_with(data, value),
                    reference.is_normalized(value),
                    "quick-check row {} column {}",
                    rows + 1,
                    index + 1
                );
                columns += 1;
            }
            rows += 1;
        }
        assert_eq!(rows, 20_034);
        assert_eq!(columns, 100_170);
        assert_eq!(composition_count, 961);
        eprintln!(
            "nfc_conformance scalars={scalar_count} assigned={assigned_count} rows={rows} columns={columns} compositions={composition_count} image_bytes={} mutation={}",
            data.bytes.len(),
            mutation.as_deref().unwrap_or("none")
        );
    }

    fn assigned_scalars(path: &std::path::Path) -> HashSet<u32> {
        let text = std::fs::read_to_string(path).expect("read UnicodeData.txt");
        let mut assigned = HashSet::new();
        let mut range_start = None;
        for line in text.lines() {
            let fields: Vec<&str> = line.split(';').collect();
            let codepoint = u32::from_str_radix(fields[0], 16).expect("UnicodeData codepoint");
            if fields[1].ends_with(", First>") {
                range_start = Some(codepoint);
            } else if fields[1].ends_with(", Last>") {
                let start = range_start.take().expect("UnicodeData range start");
                assigned
                    .extend((start..=codepoint).filter(|value| char::from_u32(*value).is_some()));
            } else if char::from_u32(codepoint).is_some() {
                assigned.insert(codepoint);
            }
        }
        assert!(range_start.is_none());
        assigned
    }

    fn decode_sequence(field: &str) -> String {
        field
            .split_ascii_whitespace()
            .map(|value| {
                let codepoint = u32::from_str_radix(value, 16).expect("normalization codepoint");
                char::from_u32(codepoint).expect("normalization scalar")
            })
            .collect()
    }
}
