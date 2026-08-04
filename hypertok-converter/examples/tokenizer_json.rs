use std::env;
use std::fs;
use std::path::PathBuf;

use hypertok_converter::convert_tokenizer_json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let source_path = PathBuf::from(arguments.next().ok_or("missing source path")?);
    let source_digest = arguments.next().ok_or("missing source digest")?;
    let output_path = PathBuf::from(arguments.next().ok_or("missing output path")?);
    if arguments.next().is_some() {
        return Err("expected a source path, SHA-256 digest, and output path".into());
    }

    let source = fs::read(source_path)?;
    let source_digest = parse_digest(source_digest.to_str().ok_or("digest is not UTF-8")?)?;
    let converted = convert_tokenizer_json(&source, source_digest)?;
    fs::write(output_path, &converted.bytes)?;
    println!(
        "tokenizer.json PASS: source={} specials={} vocab={} key_set={} gaps={} omega={} bytes={} priority={} inversions={} digest={}",
        converted.source_token_count,
        converted.special_token_count,
        converted.vocab_size,
        converted.key_set_size,
        converted.gap_count,
        converted.omega,
        converted.bytes.len(),
        converted.priority_present,
        converted.priority_inversions,
        encode_digest(converted.digest),
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
