use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;

use hypertok_converter::{SpecialToken, TiktokenDefinition, convert_tiktoken};
use hypertok_format::NamedPattern;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const SOURCE_DIGEST: &str = "b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103";
const CONFIG_DIGEST: &str = "5d0803c94db9cd78763499e0956c95fd5a225c14a727e5a6cf5db3f96f010a6e";
const ORDINARY_COUNT: u32 = 163_584;
const SPECIAL_COUNT: u32 = 256;

#[derive(Deserialize)]
struct TokenizerConfig {
    added_tokens_decoder: BTreeMap<String, AddedTokenConfig>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddedTokenConfig {
    content: String,
    lstrip: bool,
    normalized: bool,
    rstrip: bool,
    single_word: bool,
    #[serde(rename = "special")]
    _special: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let source_path = PathBuf::from(arguments.next().ok_or("missing rank source path")?);
    let config_path = PathBuf::from(arguments.next().ok_or("missing tokenizer config path")?);
    let output_path = PathBuf::from(arguments.next().ok_or("missing output path")?);
    if arguments.next().is_some() {
        return Err("expected rank source, tokenizer config, and output paths".into());
    }

    let source = fs::read(source_path)?;
    let config_bytes = fs::read(config_path)?;
    verify_digest(&config_bytes, CONFIG_DIGEST, "tokenizer config")?;
    let config: TokenizerConfig = serde_json::from_slice(&config_bytes)?;
    if config.added_tokens_decoder.len() != 16 {
        return Err("Kimi tokenizer config must carry 16 named overrides".into());
    }

    let mut overrides = BTreeMap::new();
    let mut override_flags = BTreeMap::new();
    for (raw_id, token) in config.added_tokens_decoder {
        let id = raw_id.parse::<u32>()?;
        if !(ORDINARY_COUNT..ORDINARY_COUNT + SPECIAL_COUNT).contains(&id) {
            return Err(format!("Kimi override id {id} is outside the special range").into());
        }
        let flags = u32::from(token.lstrip)
            | (u32::from(token.rstrip) << 1)
            | (u32::from(token.single_word) << 2)
            | (u32::from(token.normalized) << 3);
        overrides.insert(id, token.content.into_bytes());
        override_flags.insert(id, flags);
    }

    let mut owned = Vec::with_capacity(SPECIAL_COUNT as usize);
    for id in ORDINARY_COUNT..ORDINARY_COUNT + SPECIAL_COUNT {
        let bytes = overrides
            .remove(&id)
            .unwrap_or_else(|| format!("<|reserved_token_{id}|>").into_bytes());
        let flags = override_flags.remove(&id).unwrap_or(0);
        owned.push((id, bytes, flags));
    }
    let specials: Vec<_> = owned
        .iter()
        .map(|(id, bytes, flags)| SpecialToken {
            bytes,
            id: *id,
            flags: *flags,
        })
        .collect();
    let definition = TiktokenDefinition {
        pattern: NamedPattern::Kimi,
        special_tokens: &specials,
    };
    let converted = convert_tiktoken(&source, parse_digest(SOURCE_DIGEST)?, &definition)?;
    fs::write(output_path, &converted.bytes)?;
    println!(
        "Kimi K3 PASS: source={} specials={} vocab={} key_set={} gaps={} omega={} bytes={} digest={}",
        converted.source_token_count,
        converted.special_token_count,
        converted.vocab_size,
        converted.key_set_size,
        converted.gap_count,
        converted.omega,
        converted.bytes.len(),
        encode_digest(converted.digest),
    );
    Ok(())
}

fn verify_digest(
    bytes: &[u8],
    expected: &str,
    name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if encode_digest(Sha256::digest(bytes).into()) != expected {
        return Err(format!("{name} digest mismatch").into());
    }
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
