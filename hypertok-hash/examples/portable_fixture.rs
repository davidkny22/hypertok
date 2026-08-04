#![cfg(all(feature = "builder", not(target_arch = "wasm32")))]

use std::env;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use hypertok_hash::build;

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let output = PathBuf::from(args.next().ok_or("missing output directory")?);
    let count = args
        .next()
        .ok_or("missing key count")?
        .to_string_lossy()
        .parse::<usize>()?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    if count == 0 || count > u32::MAX as usize {
        return Err("key count must be in 1..=u32::MAX".into());
    }

    let keys = fixture_keys(count);
    let image = build(&keys)?;
    image.verify_keys(&keys)?;

    let mut reversed = keys.clone();
    reversed.reverse();
    if image.to_bytes() != build(&reversed)?.to_bytes() {
        return Err("construction changed with key order".into());
    }

    let image_bytes = image.to_bytes();
    let mut input_bytes = Vec::new();
    input_bytes.extend_from_slice(&(keys.len() as u32).to_le_bytes());
    for key in &keys {
        input_bytes.extend_from_slice(&(key.len() as u32).to_le_bytes());
        input_bytes.extend_from_slice(key);
        input_bytes.extend_from_slice(
            &image
                .evaluate(key)
                .ok_or("constructed key has no index")?
                .to_le_bytes(),
        );
    }

    fs::create_dir_all(&output)?;
    fs::write(output.join("image.bin"), image_bytes)?;
    fs::write(output.join("inputs.bin"), input_bytes)?;
    Ok(())
}

fn fixture_keys(count: usize) -> Vec<Vec<u8>> {
    (0..count)
        .map(|index| {
            let mut state = (index as u64)
                .wrapping_mul(0x9e37_79b9_7f4a_7c15)
                .wrapping_add(0xd1b5_4a32_d192_ed03);
            let length = 4 + index % 253;
            let mut key = Vec::with_capacity(length);
            key.extend_from_slice(&(index as u32).to_le_bytes());
            while key.len() < length {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                key.push(state as u8);
            }
            key
        })
        .collect()
}
