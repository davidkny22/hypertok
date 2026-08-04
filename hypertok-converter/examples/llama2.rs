use std::env;
use std::fs;
use std::path::PathBuf;

use hypertok_converter::convert_tokenizer_json;

const SOURCE_DIGEST: [u8; 32] = [
    0xbc, 0xd0, 0x4f, 0x0e, 0xad, 0xf9, 0x02, 0x87, 0xbd, 0x26, 0xe1, 0xa1, 0x83, 0xac, 0x48, 0x7d,
    0x8a, 0x14, 0x1b, 0x09, 0xb0, 0x6a, 0xec, 0xb7, 0x72, 0x5b, 0xbd, 0xd3, 0x43, 0x64, 0x0f, 0x2e,
];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let source_path = PathBuf::from(arguments.next().ok_or("missing source path")?);
    let output_path = PathBuf::from(arguments.next().ok_or("missing output path")?);
    if arguments.next().is_some() {
        return Err("expected exactly a source path and an output path".into());
    }
    let source = fs::read(source_path)?;
    let converted = convert_tokenizer_json(&source, SOURCE_DIGEST)?;
    fs::write(output_path, &converted.bytes)?;
    println!(
        "llama2 PASS: vocab={} key_set={} omega={} bytes={} priority={} inversions={} digest={}",
        converted.vocab_size,
        converted.key_set_size,
        converted.omega,
        converted.bytes.len(),
        converted.priority_present,
        converted.priority_inversions,
        converted
            .digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    Ok(())
}
