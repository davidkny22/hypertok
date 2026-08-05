use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use hypertok_converter::{SpecialToken, TiktokenDefinition, convert_tiktoken};
use hypertok_format::{DIGEST_RANGE, NamedPattern, SectionId, ValidatedFile, compute_digest};

const SOURCE_DIGEST: &str = "94b5ca7dff4d00767bc256fdd1b27e5b17361d7b8a5f968547f9f23eb70d2069";
const BASE_SPECIALS: [SpecialToken<'static>; 1] = [SpecialToken {
    bytes: b"<|endoftext|>",
    id: 50_256,
    flags: 0,
}];
const EDIT_SPECIALS: [SpecialToken<'static>; 4] = [
    BASE_SPECIALS[0],
    SpecialToken {
        bytes: b"<|fim_prefix|>",
        id: 50_281,
        flags: 0,
    },
    SpecialToken {
        bytes: b"<|fim_middle|>",
        id: 50_282,
        flags: 0,
    },
    SpecialToken {
        bytes: b"<|fim_suffix|>",
        id: 50_283,
        flags: 0,
    },
];

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    let source_path = PathBuf::from(arguments.next().ok_or("missing source path")?);
    let base_output = PathBuf::from(arguments.next().ok_or("missing base output path")?);
    let edit_output = PathBuf::from(arguments.next().ok_or("missing edit output path")?);
    if arguments.next().is_some() {
        return Err("expected a source path and two output paths".into());
    }

    let source = fs::read(source_path)?;
    let digest = parse_digest(SOURCE_DIGEST)?;
    let base = convert_tiktoken(
        &source,
        digest,
        &TiktokenDefinition {
            pattern: NamedPattern::Gpt2,
            special_tokens: &BASE_SPECIALS,
        },
    )?;
    let edit = convert_tiktoken(
        &source,
        digest,
        &TiktokenDefinition {
            pattern: NamedPattern::Gpt2,
            special_tokens: &EDIT_SPECIALS,
        },
    )?;

    for (name, converted, specials) in [
        ("p50k_base", &base, BASE_SPECIALS.as_slice()),
        ("p50k_edit", &edit, EDIT_SPECIALS.as_slice()),
    ] {
        let expected = independent_source(&source, specials)?;
        independent_verify(&expected, &converted.bytes)?;
        require_mapping_mutation_red(&expected, &converted.bytes, name)?;
        println!(
            "{name} PASS: source={} specials={} vocab={} key_set={} gaps={} omega={} bytes={} mapping={}/{} mutation=RED digest={}",
            converted.source_token_count,
            converted.special_token_count,
            converted.vocab_size,
            converted.key_set_size,
            converted.gap_count,
            converted.omega,
            converted.bytes.len(),
            expected.lookup.len(),
            expected.lookup.len(),
            encode_digest(converted.digest),
        );
    }

    fs::write(base_output, &base.bytes)?;
    fs::write(edit_output, &edit.bytes)?;
    Ok(())
}

struct ExpectedMapping {
    slots: Vec<Option<Vec<u8>>>,
    lookup: BTreeMap<Vec<u8>, u32>,
}

fn independent_source(
    source: &[u8],
    specials: &[SpecialToken<'_>],
) -> Result<ExpectedMapping, Box<dyn Error>> {
    let content = source.strip_suffix(b"\n").unwrap_or(source);
    let mut rows = Vec::new();
    let mut ids = BTreeSet::new();
    let mut lookup = BTreeMap::new();
    for raw_line in content.split(|byte| *byte == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        let separator = line
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or("missing rank separator")?;
        let token = STANDARD.decode(&line[..separator])?;
        let id = std::str::from_utf8(&line[separator + 1..])?.parse::<u32>()?;
        if !ids.insert(id) || lookup.insert(token.clone(), id).is_some() {
            return Err(format!("duplicate ordinary mapping at id {id}").into());
        }
        rows.push((id, token));
    }
    let highest = rows
        .iter()
        .map(|(id, _)| *id)
        .chain(specials.iter().map(|token| token.id))
        .max()
        .ok_or("empty source")?;
    let mut slots = vec![None; highest as usize + 1];
    for (id, token) in rows {
        slots[id as usize] = Some(token);
    }
    for special in specials {
        if slots[special.id as usize]
            .replace(special.bytes.to_vec())
            .is_some()
        {
            return Err(format!("special collision at id {}", special.id).into());
        }
    }
    Ok(ExpectedMapping { slots, lookup })
}

fn independent_verify(expected: &ExpectedMapping, bytes: &[u8]) -> Result<(), Box<dyn Error>> {
    let file = ValidatedFile::read(bytes)?;
    if file.header().vocab_size as usize != expected.slots.len() {
        return Err("vocabulary size mismatch".into());
    }
    let mut emitted = BTreeMap::new();
    for (id, token) in file.tokens() {
        let source = expected.slots[id as usize].as_deref().unwrap_or_default();
        if token != source {
            return Err(format!("id-to-bytes mismatch at id {id}").into());
        }
        if expected.lookup.get(token) == Some(&id) {
            emitted.insert(token.to_vec(), id);
        }
    }
    if emitted != expected.lookup {
        return Err("bytes-to-id mapping mismatch".into());
    }
    Ok(())
}

fn require_mapping_mutation_red(
    expected: &ExpectedMapping,
    original: &[u8],
    name: &str,
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
        return Err(format!("{name} mapping mutation stayed green").into());
    }
    Ok(())
}

fn parse_digest(value: &str) -> Result<[u8; 32], Box<dyn Error>> {
    let mut output = [0_u8; 32];
    if value.len() != output.len() * 2 {
        return Err("digest must contain 64 hexadecimal digits".into());
    }
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)?;
    }
    Ok(output)
}

fn encode_digest(value: [u8; 32]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
