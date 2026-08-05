use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use hypertok_converter::{SpecialToken, TiktokenDefinition, convert_tiktoken};
use hypertok_format::{DIGEST_RANGE, NamedPattern, SectionId, ValidatedFile, compute_digest};

const SOURCE_DIGEST: &str = "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7";
const ORDINARY_COUNT: usize = 100_256;
const VOCAB_SIZE: usize = 100_277;
const SPECIALS: [SpecialToken<'static>; 5] = [
    SpecialToken {
        bytes: b"<|endoftext|>",
        id: 100_257,
        flags: 0,
    },
    SpecialToken {
        bytes: b"<|fim_prefix|>",
        id: 100_258,
        flags: 0,
    },
    SpecialToken {
        bytes: b"<|fim_middle|>",
        id: 100_259,
        flags: 0,
    },
    SpecialToken {
        bytes: b"<|fim_suffix|>",
        id: 100_260,
        flags: 0,
    },
    SpecialToken {
        bytes: b"<|endofprompt|>",
        id: 100_276,
        flags: 0,
    },
];

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    let source_path = PathBuf::from(arguments.next().ok_or("missing source path")?);
    let output_path = PathBuf::from(arguments.next().ok_or("missing output path")?);
    if arguments.next().is_some() {
        return Err("expected exactly a source path and an output path".into());
    }

    let source = fs::read(source_path)?;
    let definition = TiktokenDefinition {
        pattern: NamedPattern::Cl100kBase,
        special_tokens: &SPECIALS,
    };
    let converted = convert_tiktoken(&source, parse_digest(SOURCE_DIGEST)?, &definition)?;
    let expected = independent_source(&source)?;
    independent_verify(&expected, &converted.bytes)?;
    require_mapping_mutation_red(&expected, &converted.bytes)?;
    fs::write(output_path, &converted.bytes)?;
    println!(
        "cl100k_base PASS: source={} specials={} vocab={} key_set={} gaps={} omega={} bytes={} mapping={}/{} lookup={}/{} mutation=1/1 digest={}",
        converted.source_token_count,
        converted.special_token_count,
        converted.vocab_size,
        converted.key_set_size,
        converted.gap_count,
        converted.omega,
        converted.bytes.len(),
        VOCAB_SIZE,
        VOCAB_SIZE,
        ORDINARY_COUNT,
        ORDINARY_COUNT,
        encode_digest(converted.digest),
    );
    Ok(())
}

fn independent_source(source: &[u8]) -> Result<Vec<Option<Vec<u8>>>, Box<dyn Error>> {
    let mut slots = vec![None; VOCAB_SIZE];
    let content = source.strip_suffix(b"\n").unwrap_or(source);
    for (expected, raw_line) in content.split(|byte| *byte == b'\n').enumerate() {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        let separator = line
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or("missing rank separator")?;
        let token = STANDARD.decode(&line[..separator])?;
        let id = std::str::from_utf8(&line[separator + 1..])?.parse::<usize>()?;
        if id != expected || id >= ORDINARY_COUNT || slots[id].replace(token).is_some() {
            return Err(format!("invalid, non-contiguous, or duplicate ordinary id {id}").into());
        }
    }
    if slots[..ORDINARY_COUNT].iter().any(Option::is_none) {
        return Err("ordinary mapping is incomplete".into());
    }
    for special in SPECIALS {
        if slots[special.id as usize]
            .replace(special.bytes.to_vec())
            .is_some()
        {
            return Err(format!("special id {} collides", special.id).into());
        }
    }
    Ok(slots)
}

fn independent_verify(expected: &[Option<Vec<u8>>], bytes: &[u8]) -> Result<(), Box<dyn Error>> {
    let file = ValidatedFile::read(bytes)?;
    if file.header().vocab_size as usize != expected.len() {
        return Err("vocabulary size mismatch".into());
    }
    let mut source_lookup = BTreeMap::new();
    let mut emitted_lookup = BTreeMap::new();
    for (id, token) in file.tokens() {
        let source = expected[id as usize].as_deref().unwrap_or_default();
        if token != source {
            return Err(format!("id-to-bytes mismatch at id {id}").into());
        }
        if (id as usize) < ORDINARY_COUNT
            && (source_lookup.insert(source, id).is_some()
                || emitted_lookup.insert(token, id).is_some())
        {
            return Err(format!("duplicate ordinary token at id {id}").into());
        }
    }
    if source_lookup != emitted_lookup || emitted_lookup.len() != ORDINARY_COUNT {
        return Err("bytes-to-id mapping mismatch".into());
    }
    Ok(())
}

fn require_mapping_mutation_red(
    expected: &[Option<Vec<u8>>],
    original: &[u8],
) -> Result<(), Box<dyn Error>> {
    let file = ValidatedFile::read(original)?;
    let arena = file
        .section_entry(SectionId::Arena.value())
        .ok_or("missing ARENA")?;
    let mut mutation = original.to_vec();
    mutation[arena.offset as usize] ^= 1;
    mutation[DIGEST_RANGE.clone()].fill(0);
    let digest = compute_digest(&mutation);
    mutation[DIGEST_RANGE].copy_from_slice(&digest);
    if independent_verify(expected, &mutation).is_ok() {
        return Err("mapping mutation stayed green".into());
    }
    Ok(())
}

fn parse_digest(value: &str) -> Result<[u8; 32], Box<dyn Error>> {
    if value.len() != 64 {
        return Err("digest must contain 64 hexadecimal digits".into());
    }
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)?;
    }
    Ok(output)
}

fn encode_digest(value: [u8; 32]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
