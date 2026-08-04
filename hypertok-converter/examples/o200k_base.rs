use std::env;
use std::fs;
use std::path::PathBuf;
use std::{collections::BTreeMap, error::Error};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use hypertok_converter::{SpecialToken, TiktokenDefinition, convert_tiktoken};
use hypertok_format::{DIGEST_RANGE, NamedPattern, SectionId, ValidatedFile, compute_digest};

const SOURCE_DIGEST: &str = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";
const SPECIALS: [SpecialToken<'static>; 2] = [
    SpecialToken {
        bytes: b"<|endoftext|>",
        id: 199_999,
        flags: 0,
    },
    SpecialToken {
        bytes: b"<|endofprompt|>",
        id: 200_018,
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
        pattern: NamedPattern::O200kBase,
        special_tokens: &SPECIALS,
    };
    let converted = convert_tiktoken(&source, parse_digest(SOURCE_DIGEST)?, &definition)?;
    let expected = independent_source(&source)?;
    independent_verify(&expected, &converted.bytes)?;
    run_mutations(&expected, &converted.bytes)?;
    fs::write(output_path, &converted.bytes)?;
    println!(
        "o200k_base PASS: source={} specials={} vocab={} key_set={} gaps={} omega={} bytes={} mapping=200019/200019 lookup=199998/199998 mutations=3/3 digest={}",
        converted.source_token_count,
        converted.special_token_count,
        converted.vocab_size,
        converted.key_set_size,
        converted.gap_count,
        converted.omega,
        converted.bytes.len(),
        encode_digest(converted.digest)
    );
    Ok(())
}

fn parse_digest(value: &str) -> Result<[u8; 32], Box<dyn std::error::Error>> {
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

fn independent_source(source: &[u8]) -> Result<Vec<Option<Vec<u8>>>, Box<dyn Error>> {
    let mut slots = vec![None; 200_019];
    let content = source.strip_suffix(b"\n").unwrap_or(source);
    for raw_line in content.split(|byte| *byte == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        let separator = line
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or("missing rank separator")?;
        let token = STANDARD.decode(&line[..separator])?;
        let id = std::str::from_utf8(&line[separator + 1..])?.parse::<usize>()?;
        if id >= 199_998 || slots[id].replace(token).is_some() {
            return Err(format!("invalid or duplicate ordinary id {id}").into());
        }
    }
    if let Some(id) = slots[..199_998].iter().position(Option::is_none) {
        return Err(format!("ordinary id {id} is absent").into());
    }
    for special in SPECIALS {
        slots[special.id as usize] = Some(special.bytes.to_vec());
    }
    Ok(slots)
}

fn independent_verify(expected: &[Option<Vec<u8>>], bytes: &[u8]) -> Result<(), Box<dyn Error>> {
    let file = ValidatedFile::read(bytes)?;
    if file.header().vocab_size != expected.len() as u32 {
        return Err("vocabulary size mismatch".into());
    }

    let mut emitted_lookup = BTreeMap::new();
    let mut source_lookup = BTreeMap::new();
    for (id, token) in file.tokens() {
        let source_token = expected[id as usize].as_deref().unwrap_or_default();
        if token != source_token {
            return Err(format!("id-to-bytes mismatch at id {id}").into());
        }
        if id < 199_998 {
            emitted_lookup.insert(token, id);
            source_lookup.insert(source_token, id);
        }
    }
    if emitted_lookup != source_lookup || emitted_lookup.len() != 199_998 {
        return Err("bytes-to-id mapping mismatch".into());
    }
    Ok(())
}

fn run_mutations(expected: &[Option<Vec<u8>>], original: &[u8]) -> Result<(), Box<dyn Error>> {
    let file = ValidatedFile::read(original)?;
    let arena_offset = file
        .section_entry(SectionId::Arena.value())
        .ok_or("missing ARENA")?
        .offset as usize;
    let lengths_offset = file
        .section_entry(SectionId::Lengths.value())
        .ok_or("missing LENGTHS")?
        .offset as usize;

    let mut arena_mutation = original.to_vec();
    arena_mutation[arena_offset] ^= 1;
    reseal(&mut arena_mutation);
    require_red(expected, &arena_mutation, "arena byte")?;

    let mut length_mutation = original.to_vec();
    if length_mutation[lengths_offset] != 1 {
        return Err("first token length is not the expected one-byte varint".into());
    }
    length_mutation[lengths_offset] = 2;
    reseal(&mut length_mutation);
    require_red(expected, &length_mutation, "token length")?;

    let mut digest_mutation = original.to_vec();
    digest_mutation[DIGEST_RANGE.start] ^= 1;
    require_red(expected, &digest_mutation, "digest")?;
    Ok(())
}

fn require_red(
    expected: &[Option<Vec<u8>>],
    mutation: &[u8],
    name: &str,
) -> Result<(), Box<dyn Error>> {
    if independent_verify(expected, mutation).is_ok() {
        return Err(format!("{name} mutation stayed green").into());
    }
    println!("mutation {name}: RED observed");
    Ok(())
}

fn reseal(bytes: &mut [u8]) {
    bytes[DIGEST_RANGE.clone()].fill(0);
    let digest = compute_digest(bytes);
    bytes[DIGEST_RANGE].copy_from_slice(&digest);
}
