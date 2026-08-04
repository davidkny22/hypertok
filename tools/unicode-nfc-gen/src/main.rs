use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};

const UNICODE_DATA: Input = Input {
    name: "UnicodeData.txt",
    bytes: 2_198_209,
    sha256: "2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c",
};
const COMPOSITION_EXCLUSIONS: Input = Input {
    name: "CompositionExclusions.txt",
    bytes: 9_007,
    sha256: "2f239196ef3b5b61db5cc476e9bd80f534d15aa1b74e1be1dea5d042a344c85f",
};
const DERIVED_NORMALIZATION: Input = Input {
    name: "DerivedNormalizationProps.txt",
    bytes: 1_377_582,
    sha256: "71fd6a206a2c0cdd41feb6b7f656aa31091db45e9cedc926985d718397f9e488",
};

const EXPECTED_SINGLETONS: usize = 1_035;
const EXPECTED_PAIRS: usize = 1_046;
const EXPECTED_COMPOSITIONS: usize = 961;
const EXPECTED_CCC_CODEPOINTS: usize = 968;
const EXPECTED_CCC_RANGES: usize = 403;
const EXPECTED_EXPLICIT_EXCLUSIONS: usize = 81;
const EXPECTED_FULL_EXCLUSIONS: usize = 1_120;
const EXPECTED_QC_NO_CODEPOINTS: usize = 1_120;
const EXPECTED_QC_NO_RANGES: usize = 74;
const EXPECTED_QC_MAYBE_CODEPOINTS: usize = 132;
const EXPECTED_QC_MAYBE_RANGES: usize = 50;
const EXPECTED_ASSIGNED_SCALARS: usize = 297_334;
const EXPECTED_IMAGE_BYTES: usize = 19_011;

#[derive(Clone, Copy)]
struct Input {
    name: &'static str,
    bytes: usize,
    sha256: &'static str,
}

#[derive(Clone, Copy, Debug)]
struct Pair {
    composite: u32,
    first: u32,
    second: u32,
}

#[derive(Clone, Copy, Debug)]
struct Range {
    start: u32,
    end: u32,
    value: u8,
}

#[derive(Default)]
struct UnicodeInventory {
    singletons: Vec<(u32, u32)>,
    pairs: Vec<Pair>,
    combining: Vec<(u32, u8)>,
    assigned_scalars: usize,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let input_dir = PathBuf::from(
        args.next()
            .ok_or("usage: unicode-nfc-gen <Unicode 17.0.0 UCD directory> <output image>")?,
    );
    let output = PathBuf::from(
        args.next()
            .ok_or("usage: unicode-nfc-gen <Unicode 17.0.0 UCD directory> <output image>")?,
    );
    if args.next().is_some() {
        return Err("unexpected extra argument".into());
    }

    let unicode_data = read_checked(&input_dir, UNICODE_DATA)?;
    let explicit_data = read_checked(&input_dir, COMPOSITION_EXCLUSIONS)?;
    let derived_data = read_checked(&input_dir, DERIVED_NORMALIZATION)?;

    let mut inventory = parse_unicode_data(&unicode_data)?;
    let explicit_exclusions = parse_codepoint_set(&explicit_data)?;
    let (full_exclusions, qc_no, qc_maybe) = parse_derived_normalization(&derived_data)?;
    let ccc_ranges = combine_ranges(&inventory.combining);

    inventory.singletons.sort_unstable_by_key(|entry| entry.0);
    inventory
        .pairs
        .sort_unstable_by_key(|entry| entry.composite);
    validate_inventory(
        &inventory,
        &explicit_exclusions,
        &full_exclusions,
        &ccc_ranges,
        &qc_no,
        &qc_maybe,
    )?;

    let mut composition_indexes: Vec<u16> = inventory
        .pairs
        .iter()
        .enumerate()
        .filter(|(_, pair)| !full_exclusions.contains(&pair.composite))
        .map(|(index, _)| u16::try_from(index).expect("pair count fits u16"))
        .collect();
    composition_indexes.sort_unstable_by_key(|&index| {
        let pair = inventory.pairs[usize::from(index)];
        (pair.first, pair.second)
    });

    let image = pack_image(
        &inventory.singletons,
        &inventory.pairs,
        &composition_indexes,
        &ccc_ranges,
        &qc_no,
        &qc_maybe,
    )?;
    if image.len() != EXPECTED_IMAGE_BYTES {
        return Err(format!(
            "packed image is {} bytes, expected {EXPECTED_IMAGE_BYTES}",
            image.len()
        )
        .into());
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&output, &image)?;
    println!(
        "unicode=17.0.0 decompositions={} singletons={} pairs={} compositions={} ccc={} ccc_ranges={} explicit_exclusions={} full_exclusions={} qc_no={} qc_maybe={} assigned_scalars={} image_bytes={} image_sha256={}",
        inventory.singletons.len() + inventory.pairs.len(),
        inventory.singletons.len(),
        inventory.pairs.len(),
        composition_indexes.len(),
        inventory.combining.len(),
        ccc_ranges.len(),
        explicit_exclusions.len(),
        full_exclusions.len(),
        range_cardinality(&qc_no),
        range_cardinality(&qc_maybe),
        inventory.assigned_scalars,
        image.len(),
        hex_digest(&image),
    );
    Ok(())
}

fn read_checked(dir: &Path, input: Input) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let path = dir.join(input.name);
    let bytes = fs::read(&path)?;
    if bytes.len() != input.bytes {
        return Err(format!(
            "{} is {} bytes, expected {}",
            path.display(),
            bytes.len(),
            input.bytes
        )
        .into());
    }
    let digest = hex_digest(&bytes);
    if digest != input.sha256 {
        return Err(format!(
            "{} has SHA-256 {digest}, expected {}",
            path.display(),
            input.sha256
        )
        .into());
    }
    Ok(bytes)
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            write!(output, "{byte:02x}").expect("writing to a String cannot fail");
            output
        })
}

fn parse_unicode_data(bytes: &[u8]) -> Result<UnicodeInventory, Box<dyn std::error::Error>> {
    let text = std::str::from_utf8(bytes)?;
    let mut inventory = UnicodeInventory::default();
    let mut range_start = None;
    for (line_number, line) in text.lines().enumerate() {
        let fields: Vec<&str> = line.split(';').collect();
        if fields.len() != 15 {
            return Err(format!(
                "UnicodeData line {} has {} fields",
                line_number + 1,
                fields.len()
            )
            .into());
        }
        let codepoint = parse_hex(fields[0])?;
        let name = fields[1];
        if name.ends_with(", First>") {
            if range_start.replace(codepoint).is_some() {
                return Err(format!("nested UnicodeData range at line {}", line_number + 1).into());
            }
            continue;
        }
        if name.ends_with(", Last>") {
            let start = range_start
                .take()
                .ok_or_else(|| format!("range end without start at line {}", line_number + 1))?;
            inventory.assigned_scalars += scalar_count(start, codepoint)?;
            continue;
        }
        if is_scalar(codepoint) {
            inventory.assigned_scalars += 1;
        }
        let ccc: u8 = fields[3].parse()?;
        if ccc != 0 {
            inventory.combining.push((codepoint, ccc));
        }
        let decomposition = fields[5];
        if decomposition.is_empty() || decomposition.starts_with('<') {
            continue;
        }
        let values: Vec<u32> = decomposition
            .split_ascii_whitespace()
            .map(parse_hex)
            .collect::<Result<_, _>>()?;
        match values.as_slice() {
            [value] => inventory.singletons.push((codepoint, *value)),
            [first, second] => inventory.pairs.push(Pair {
                composite: codepoint,
                first: *first,
                second: *second,
            }),
            _ => {
                return Err(format!(
                    "canonical decomposition for U+{codepoint:04X} has {} scalars",
                    values.len()
                )
                .into());
            }
        }
    }
    if range_start.is_some() {
        return Err("unterminated UnicodeData range".into());
    }
    Ok(inventory)
}

fn scalar_count(start: u32, end: u32) -> Result<usize, Box<dyn std::error::Error>> {
    if start > end || end > 0x10_FFFF {
        return Err(format!("invalid UnicodeData range U+{start:04X}..U+{end:04X}").into());
    }
    let total = usize::try_from(end - start + 1)?;
    let surrogate_start = start.max(0xD800);
    let surrogate_end = end.min(0xDFFF);
    let surrogates = if surrogate_start <= surrogate_end {
        usize::try_from(surrogate_end - surrogate_start + 1)?
    } else {
        0
    };
    Ok(total - surrogates)
}

fn is_scalar(codepoint: u32) -> bool {
    codepoint <= 0x10_FFFF && !(0xD800..=0xDFFF).contains(&codepoint)
}

fn parse_codepoint_set(bytes: &[u8]) -> Result<HashSet<u32>, Box<dyn std::error::Error>> {
    let text = std::str::from_utf8(bytes)?;
    let mut values = HashSet::new();
    for line in text.lines() {
        let field = line.split('#').next().unwrap_or_default().trim();
        if field.is_empty() {
            continue;
        }
        let (start, end) = parse_range(field)?;
        values.extend(start..=end);
    }
    Ok(values)
}

type DerivedData = (HashSet<u32>, Vec<Range>, Vec<Range>);

fn parse_derived_normalization(bytes: &[u8]) -> Result<DerivedData, Box<dyn std::error::Error>> {
    let text = std::str::from_utf8(bytes)?;
    let mut full_exclusions = HashSet::new();
    let mut qc_no = Vec::new();
    let mut qc_maybe = Vec::new();
    for line in text.lines() {
        let body = line.split('#').next().unwrap_or_default().trim();
        if body.is_empty() {
            continue;
        }
        let fields: Vec<&str> = body.split(';').map(str::trim).collect();
        let (start, end) = parse_range(fields[0])?;
        match fields.get(1).copied() {
            Some("Full_Composition_Exclusion") => full_exclusions.extend(start..=end),
            Some("NFC_QC") => match fields.get(2).copied() {
                Some("N") => qc_no.push(Range {
                    start,
                    end,
                    value: 0,
                }),
                Some("M") => qc_maybe.push(Range {
                    start,
                    end,
                    value: 0,
                }),
                _ => {}
            },
            _ => {}
        }
    }
    Ok((full_exclusions, qc_no, qc_maybe))
}

fn parse_range(field: &str) -> Result<(u32, u32), Box<dyn std::error::Error>> {
    let mut parts = field.split("..");
    let start = parse_hex(parts.next().ok_or("empty codepoint range")?.trim())?;
    let end = parts
        .next()
        .map_or(Ok(start), |value| parse_hex(value.trim()))?;
    if parts.next().is_some() || start > end || !is_scalar(start) || !is_scalar(end) {
        return Err(format!("invalid scalar range {field:?}").into());
    }
    Ok((start, end))
}

fn parse_hex(value: &str) -> Result<u32, std::num::ParseIntError> {
    u32::from_str_radix(value, 16)
}

fn combine_ranges(values: &[(u32, u8)]) -> Vec<Range> {
    let mut ranges: Vec<Range> = Vec::new();
    for &(codepoint, value) in values {
        if let Some(last) = ranges.last_mut()
            && last.end + 1 == codepoint
            && last.value == value
        {
            last.end = codepoint;
        } else {
            ranges.push(Range {
                start: codepoint,
                end: codepoint,
                value,
            });
        }
    }
    ranges
}

fn range_cardinality(ranges: &[Range]) -> usize {
    ranges
        .iter()
        .map(|range| usize::try_from(range.end - range.start + 1).expect("range fits usize"))
        .sum()
}

fn validate_inventory(
    inventory: &UnicodeInventory,
    explicit_exclusions: &HashSet<u32>,
    full_exclusions: &HashSet<u32>,
    ccc_ranges: &[Range],
    qc_no: &[Range],
    qc_maybe: &[Range],
) -> Result<(), Box<dyn std::error::Error>> {
    let checks = [
        (
            "singletons",
            inventory.singletons.len(),
            EXPECTED_SINGLETONS,
        ),
        ("pairs", inventory.pairs.len(), EXPECTED_PAIRS),
        (
            "combining codepoints",
            inventory.combining.len(),
            EXPECTED_CCC_CODEPOINTS,
        ),
        ("combining ranges", ccc_ranges.len(), EXPECTED_CCC_RANGES),
        (
            "explicit exclusions",
            explicit_exclusions.len(),
            EXPECTED_EXPLICIT_EXCLUSIONS,
        ),
        (
            "full exclusions",
            full_exclusions.len(),
            EXPECTED_FULL_EXCLUSIONS,
        ),
        ("quick-check No ranges", qc_no.len(), EXPECTED_QC_NO_RANGES),
        (
            "quick-check No codepoints",
            range_cardinality(qc_no),
            EXPECTED_QC_NO_CODEPOINTS,
        ),
        (
            "quick-check Maybe ranges",
            qc_maybe.len(),
            EXPECTED_QC_MAYBE_RANGES,
        ),
        (
            "quick-check Maybe codepoints",
            range_cardinality(qc_maybe),
            EXPECTED_QC_MAYBE_CODEPOINTS,
        ),
        (
            "assigned scalars",
            inventory.assigned_scalars,
            EXPECTED_ASSIGNED_SCALARS,
        ),
    ];
    for (name, actual, expected) in checks {
        if actual != expected {
            return Err(format!("{name}: got {actual}, expected {expected}").into());
        }
    }
    let compositions = inventory
        .pairs
        .iter()
        .filter(|pair| !full_exclusions.contains(&pair.composite))
        .count();
    if compositions != EXPECTED_COMPOSITIONS {
        return Err(
            format!("compositions: got {compositions}, expected {EXPECTED_COMPOSITIONS}").into(),
        );
    }
    if inventory
        .singletons
        .windows(2)
        .any(|window| window[0].0 >= window[1].0)
        || inventory
            .pairs
            .windows(2)
            .any(|window| window[0].composite >= window[1].composite)
    {
        return Err("decomposition records are not strictly sorted".into());
    }
    Ok(())
}

fn pack_image(
    singletons: &[(u32, u32)],
    pairs: &[Pair],
    composition_indexes: &[u16],
    ccc_ranges: &[Range],
    qc_no: &[Range],
    qc_maybe: &[Range],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut image = Vec::with_capacity(EXPECTED_IMAGE_BYTES);
    for &(composite, value) in singletons {
        let packed = u64::from(composite) | (u64::from(value) << 21);
        image.extend_from_slice(&packed.to_le_bytes()[..6]);
    }
    for pair in pairs {
        let packed = u64::from(pair.composite)
            | (u64::from(pair.first) << 21)
            | (u64::from(pair.second) << 42);
        image.extend_from_slice(&packed.to_le_bytes());
    }
    for &index in composition_indexes {
        image.extend_from_slice(&index.to_le_bytes());
    }
    for range in ccc_ranges {
        let length = range.end - range.start + 1;
        if length > 64 {
            return Err(format!("combining-class range length {length} exceeds 64").into());
        }
        let packed =
            u64::from(range.start) | (u64::from(length - 1) << 21) | (u64::from(range.value) << 27);
        image.extend_from_slice(&packed.to_le_bytes()[..5]);
    }
    for range in qc_no.iter().chain(qc_maybe) {
        let length = range.end - range.start + 1;
        if length > 1_024 {
            return Err(format!("quick-check range length {length} exceeds 1,024").into());
        }
        let packed = range.start | ((length - 1) << 21);
        image.extend_from_slice(&packed.to_le_bytes());
    }
    Ok(image)
}
