use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::io;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use hypertok_converter::{TiktokenDefinition, convert_tiktoken};
use hypertok_format::{DIGEST_RANGE, NamedPattern, SectionId, ValidatedFile, compute_digest};
use hypertok_hash::{
    DEFAULT_TABLE_LOAD_PERMILLE, FingerprintTable, HashImage, TableKey, build, fingerprint,
    table_hash,
};
use sha2::{Digest, Sha256};

const MUTATIONS: [&str; 6] = [
    "drop-length",
    "arena-byte",
    "hash-entry",
    "fingerprint-entry",
    "digest",
    "prefix-comparison",
];

type GateResult<T = ()> = Result<T, Box<dyn Error>>;
type MappingFixture = (Vec<u8>, Vec<Vec<u8>>);
type TableFixture = (FingerprintTable, Vec<Vec<u8>>);
type PrefixFixture = (FingerprintTable, Vec<u8>, Vec<u8>);

fn main() {
    let mode = env::var("HYPERTOK_FORMAT_LOOKUP_FAULT").unwrap_or_else(|_| "baseline".to_owned());
    if let Err(error) = run(&mode) {
        eprintln!("{mode} RED: {error}");
        std::process::exit(1);
    }
}

fn run(mode: &str) -> GateResult {
    match mode {
        "baseline" => baseline(),
        "drop-length" => dropped_length(),
        "arena-byte" => perturbed_arena(),
        "hash-entry" => corrupted_hash_entry(),
        "fingerprint-entry" => corrupted_fingerprint_entry(),
        "digest" => corrupted_digest(),
        "prefix-comparison" => prefix_comparison(),
        value => Err(failure(format!(
            "unknown mode {value}; expected baseline or {MUTATIONS:?}"
        ))),
    }
}

fn baseline() -> GateResult {
    let (bytes, expected) = converted_fixture()?;
    verify_mapping(&bytes, &expected)?;

    let keys = hash_keys();
    let image = build(&keys)?;
    image.verify_keys(&keys)?;

    let (table, table_keys) = fingerprint_table()?;
    verify_table(&table, &table_keys)?;

    let (prefix_table, token, query) = prefix_fixture()?;
    if prefix_table
        .lookup(&query, |id, bytes| id == 0 && token == bytes)
        .is_some()
    {
        return Err(failure("exact comparison accepted a strict prefix"));
    }

    let digest = ValidatedFile::read(&bytes)?.header().digest;
    println!(
        "mutation-teeth baseline PASS: mapping={}/{}; hash={}/{}; fingerprints={}/{}; prefix_miss=1/1; digest={}",
        expected.len(),
        expected.len(),
        keys.len(),
        keys.len(),
        table_keys.len(),
        table_keys.len(),
        hex(&digest)
    );
    Ok(())
}

fn dropped_length() -> GateResult {
    let (mut bytes, _expected) = converted_fixture()?;
    let entry = table_entry(&bytes, SectionId::Lengths.value())?;
    let length = read_u64(&bytes, entry + 8)?;
    if length == 0 {
        return Err(failure("LENGTHS section is empty"));
    }
    put_u64(&mut bytes, entry + 8, length - 1)?;
    reseal(&mut bytes);
    ValidatedFile::read(&bytes)?;
    Ok(())
}

fn perturbed_arena() -> GateResult {
    let (mut bytes, expected) = converted_fixture()?;
    let file = ValidatedFile::read(&bytes)?;
    let arena = file
        .section_entry(SectionId::Arena.value())
        .ok_or_else(|| failure("ARENA section is absent"))?;
    let last = usize::try_from(arena.offset)? + usize::try_from(arena.length)? - 1;
    if bytes[last] != b'a' {
        return Err(failure("fixture's final arena byte is not 'a'"));
    }
    bytes[last] = b'b';
    reseal(&mut bytes);
    ValidatedFile::read(&bytes)?;
    verify_mapping(&bytes, &expected)
}

fn corrupted_hash_entry() -> GateResult {
    let keys = hash_keys();
    let mut bytes = build(&keys)?.to_bytes();
    let level_count = usize::try_from(read_u32(&bytes, 16)?)?;
    let bit_word_count = usize::try_from(read_u32(&bytes, 20)?)?;
    let start = 32 + level_count * 4;
    let end = start + bit_word_count * 8;
    let position = (start..end)
        .find(|index| bytes[*index] != 0)
        .ok_or_else(|| failure("hash image has no occupied bit"))?;
    let mask = 1_u8 << bytes[position].trailing_zeros();
    bytes[position] ^= mask;
    let image = HashImage::from_bytes(&bytes)?;
    image.verify_keys(&keys)?;
    Ok(())
}

fn corrupted_fingerprint_entry() -> GateResult {
    let (table, keys) = fingerprint_table()?;
    let mut bytes = table.to_bytes();
    let slot = bytes[16..]
        .chunks_exact(8)
        .position(|raw| raw[7] == 1)
        .ok_or_else(|| failure("fingerprint table has no occupied slot"))?;
    bytes[16 + slot * 8 + 6] ^= 1;
    let corrupted = FingerprintTable::from_bytes(&bytes, keys.len() as u32)?;
    verify_table(&corrupted, &keys)
}

fn corrupted_digest() -> GateResult {
    let (mut bytes, _expected) = converted_fixture()?;
    bytes[DIGEST_RANGE.start] ^= 1;
    ValidatedFile::read(&bytes)?;
    Ok(())
}

fn prefix_comparison() -> GateResult {
    let (table, token, query) = prefix_fixture()?;
    if table
        .lookup(&query, |id, bytes| id == 0 && token.starts_with(bytes))
        .is_some()
    {
        return Err(failure("prefix comparison accepted a strict prefix"));
    }
    Ok(())
}

fn converted_fixture() -> GateResult<MappingFixture> {
    let mut source = String::new();
    let mut expected = Vec::new();
    for rank in 0_u32..256 {
        let token = vec![rank as u8];
        source.push_str(&STANDARD.encode(&token));
        source.push(' ');
        source.push_str(&rank.to_string());
        source.push('\n');
        expected.push(token);
    }
    source.push_str(&STANDARD.encode(b"aa"));
    source.push_str(" 256\n");
    expected.push(b"aa".to_vec());

    let source = source.into_bytes();
    let definition = TiktokenDefinition {
        pattern: NamedPattern::O200kBase,
        special_tokens: &[],
    };
    let conversion = convert_tiktoken(&source, Sha256::digest(&source).into(), &definition)?;
    Ok((conversion.bytes, expected))
}

fn verify_mapping(bytes: &[u8], expected: &[Vec<u8>]) -> GateResult {
    let file = ValidatedFile::read(bytes)?;
    if file.header().vocab_size as usize != expected.len() {
        return Err(failure("vocabulary size changed"));
    }
    let mut source_lookup = BTreeMap::new();
    let mut emitted_lookup = BTreeMap::new();
    for (id, token) in file.tokens() {
        let source = &expected[id as usize];
        if token != source {
            return Err(failure(format!("id-to-bytes mismatch at id {id}")));
        }
        if source_lookup.insert(source.as_slice(), id).is_some()
            || emitted_lookup.insert(token, id).is_some()
        {
            return Err(failure("duplicate mapping"));
        }
    }
    if source_lookup != emitted_lookup || emitted_lookup.len() != expected.len() {
        return Err(failure("bytes-to-id mapping changed"));
    }
    Ok(())
}

fn hash_keys() -> Vec<Vec<u8>> {
    (0..512)
        .map(|index| format!("hash-key-{index:04}").into_bytes())
        .collect()
}

fn fingerprint_table() -> GateResult<TableFixture> {
    let keys: Vec<_> = (0..128)
        .map(|index| format!("table-key-{index:04}").into_bytes())
        .collect();
    let borrowed: Vec<_> = keys
        .iter()
        .enumerate()
        .map(|(id, bytes)| TableKey {
            id: id as u32,
            bytes,
        })
        .collect();
    let table = FingerprintTable::build(&borrowed, DEFAULT_TABLE_LOAD_PERMILLE)?;
    Ok((table, keys))
}

fn verify_table(table: &FingerprintTable, keys: &[Vec<u8>]) -> GateResult {
    for (id, key) in keys.iter().enumerate() {
        let found = table.lookup(key, |candidate, bytes| {
            keys[candidate as usize].as_slice() == bytes
        });
        if found != Some(id as u32) {
            return Err(failure(format!("fingerprint lookup mismatch at id {id}")));
        }
    }
    Ok(())
}

fn prefix_fixture() -> GateResult<PrefixFixture> {
    let (token, query) = (0..1_000_000_u32)
        .find_map(|index| {
            let query = format!("prefix-{index}").into_bytes();
            let mut token = query.clone();
            token.extend_from_slice(b"-suffix");
            (fingerprint(&query) == fingerprint(&token)
                && bucket(table_hash(&query), 2) == bucket(table_hash(&token), 2))
            .then_some((token, query))
        })
        .ok_or_else(|| failure("no deterministic prefix collision found"))?;
    let keys = [TableKey {
        id: 0,
        bytes: &token,
    }];
    let table = FingerprintTable::build(&keys, DEFAULT_TABLE_LOAD_PERMILLE)?;
    Ok((table, token, query))
}

fn bucket(value: u64, range: usize) -> usize {
    ((u128::from(value) * range as u128) >> 64) as usize
}

fn table_entry(bytes: &[u8], wanted: u32) -> GateResult<usize> {
    let count = usize::try_from(read_u32(bytes, 24)?)?;
    let start = usize::try_from(read_u32(bytes, 28)?)?;
    for index in 0..count {
        let entry = start + index * 16;
        if read_u32(bytes, entry)? == wanted {
            return Ok(entry);
        }
    }
    Err(failure(format!("section {wanted} is absent")))
}

fn read_u32(bytes: &[u8], offset: usize) -> GateResult<u32> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or_else(|| failure("u32 read is out of bounds"))?
            .try_into()?,
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> GateResult<u64> {
    Ok(u64::from_le_bytes(
        bytes
            .get(offset..offset + 8)
            .ok_or_else(|| failure("u64 read is out of bounds"))?
            .try_into()?,
    ))
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) -> GateResult {
    bytes
        .get_mut(offset..offset + 8)
        .ok_or_else(|| failure("u64 write is out of bounds"))?
        .copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn reseal(bytes: &mut [u8]) {
    bytes[DIGEST_RANGE.clone()].fill(0);
    let digest = compute_digest(bytes);
    bytes[DIGEST_RANGE].copy_from_slice(&digest);
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn failure(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(io::Error::other(message.into()))
}
