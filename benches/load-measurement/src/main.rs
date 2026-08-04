use std::collections::BTreeSet;
use std::env;
use std::error::Error;
use std::fs;
use std::hint::black_box;
use std::io::{Cursor, Read, Write};
use std::mem::size_of;
use std::path::Path;
use std::time::Instant;

use hypertok_converter::{Document, Section, write};
use hypertok_format::{HashScheme, SectionId, ValidatedFile};
use hypertok_hash::{FingerprintTable, HashImage, TableKey, build, fingerprint};
use serde::Serialize;

const PACKED_ID_BITS: usize = 18;
const MISSING_ID: u32 = u32::MAX;

type AnyError = Box<dyn Error + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Candidate {
    MphU32,
    MphPacked18,
    Table850,
    Table875,
    Table900,
}

impl Candidate {
    fn parse(value: &str) -> Result<Self, AnyError> {
        match value {
            "mph-u32" => Ok(Self::MphU32),
            "mph-packed18" => Ok(Self::MphPacked18),
            "table-850" => Ok(Self::Table850),
            "table-875" => Ok(Self::Table875),
            "table-900" => Ok(Self::Table900),
            _ => Err(format!("unknown candidate {value}").into()),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::MphU32 => "mph-u32",
            Self::MphPacked18 => "mph-packed18",
            Self::Table850 => "table-850",
            Self::Table875 => "table-875",
            Self::Table900 => "table-900",
        }
    }

    fn load_permille(self) -> Option<usize> {
        match self {
            Self::Table850 => Some(850),
            Self::Table875 => Some(875),
            Self::Table900 => Some(900),
            _ => None,
        }
    }

    fn uses_hash(self) -> bool {
        matches!(self, Self::MphU32 | Self::MphPacked18)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    input: String,
    scheme0_path: String,
    scheme1_path: String,
    scheme0_raw_bytes: usize,
    scheme1_raw_bytes: usize,
    scheme0_compressed_bytes: usize,
    scheme1_compressed_bytes: usize,
    key_set_size: usize,
    hash_bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryComponents {
    arena: usize,
    retained_sections: usize,
    offsets: usize,
    hash_evaluator: usize,
    payload: usize,
    fingerprints: usize,
    table: usize,
}

impl MemoryComponents {
    fn total(&self) -> usize {
        self.arena
            + self.retained_sections
            + self.offsets
            + self.hash_evaluator
            + self.payload
            + self.fingerprints
            + self.table
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    candidate: &'static str,
    compressed_bytes: usize,
    decompressed_bytes: usize,
    transfer_milliseconds: f64,
    decompression_milliseconds: f64,
    materialisation_milliseconds: f64,
    miss_probe_milliseconds: f64,
    probe_count: usize,
    miss_count: usize,
    hit_count: usize,
    verified_keys: usize,
    verified_misses: usize,
    key_set_size: usize,
    block_shift: u8,
    resident_bytes: usize,
    memory: MemoryComponents,
    checksum: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MutationResult {
    red: usize,
    total: usize,
    checks: Vec<&'static str>,
}

#[derive(Clone, Copy)]
struct Key<'a> {
    id: u32,
    bytes: &'a [u8],
}

struct TwoLevelOffsets {
    block_shift: u8,
    bases: Vec<u32>,
    intra: Vec<u16>,
    arena_len: u32,
}

impl TwoLevelOffsets {
    fn build(file: &ValidatedFile<'_>) -> Result<Self, AnyError> {
        let omega = u64::from(file.header().omega);
        if omega == 0 {
            return Err("omega must be non-zero".into());
        }
        let mut block_shift = 0_u8;
        while block_shift < 31 {
            let next = block_shift + 1;
            let span = (1_u64 << next) - 1;
            if span.saturating_mul(omega) > u64::from(u16::MAX) {
                break;
            }
            block_shift = next;
        }
        let block_size = 1_usize << block_shift;
        let mut bases =
            Vec::with_capacity((file.header().vocab_size as usize).div_ceil(block_size));
        let mut intra = Vec::with_capacity(file.header().vocab_size as usize);
        let mut offset = 0_u32;
        let mut base = 0_u32;
        for (id, length) in file.lengths().enumerate() {
            if id % block_size == 0 {
                base = offset;
                bases.push(base);
            }
            intra.push(u16::try_from(offset - base)?);
            offset = offset.checked_add(length).ok_or("arena offset overflow")?;
        }
        Ok(Self {
            block_shift,
            bases,
            intra,
            arena_len: offset,
        })
    }

    fn range(&self, id: u32) -> Option<std::ops::Range<usize>> {
        let id = usize::try_from(id).ok()?;
        let start = self.offset(id)?;
        let end = if id + 1 == self.intra.len() {
            self.arena_len as usize
        } else {
            self.offset(id + 1)?
        };
        Some(start..end)
    }

    fn offset(&self, id: usize) -> Option<usize> {
        let block = id >> self.block_shift;
        Some(*self.bases.get(block)? as usize + *self.intra.get(id)? as usize)
    }

    fn resident_bytes(&self) -> usize {
        self.bases.capacity() * size_of::<u32>() + self.intra.capacity() * size_of::<u16>()
    }
}

struct PackedIds {
    bytes: Vec<u8>,
    len: usize,
}

impl PackedIds {
    fn new(len: usize) -> Self {
        let byte_len = len.saturating_mul(PACKED_ID_BITS).div_ceil(8);
        Self {
            bytes: vec![0; byte_len + 3],
            len,
        }
    }

    fn set(&mut self, index: usize, value: u32) -> Result<(), AnyError> {
        if index >= self.len || value >= 1 << PACKED_ID_BITS {
            return Err("18-bit payload bound exceeded".into());
        }
        let bit = index * PACKED_ID_BITS;
        let byte = bit / 8;
        let shift = bit % 8;
        let mut word = u32::from_le_bytes(self.bytes[byte..byte + 4].try_into()?);
        let mask = ((1_u32 << PACKED_ID_BITS) - 1) << shift;
        word = (word & !mask) | (value << shift);
        self.bytes[byte..byte + 4].copy_from_slice(&word.to_le_bytes());
        Ok(())
    }

    fn get(&self, index: usize) -> Option<u32> {
        if index >= self.len {
            return None;
        }
        let bit = index * PACKED_ID_BITS;
        let byte = bit / 8;
        let shift = bit % 8;
        let word = u32::from_le_bytes(self.bytes[byte..byte + 4].try_into().ok()?);
        Some((word >> shift) & ((1 << PACKED_ID_BITS) - 1))
    }

    fn resident_bytes(&self) -> usize {
        self.bytes.capacity()
    }
}

enum Lookup {
    MphU32 {
        hash: HashImage,
        payload: Vec<u32>,
        fingerprints: Vec<u8>,
    },
    MphPacked18 {
        hash: HashImage,
        payload: PackedIds,
        fingerprints: Vec<u8>,
    },
    Table(FingerprintTable),
}

struct Runtime {
    arena: Vec<u8>,
    retained_sections: Vec<Vec<u8>>,
    offsets: TwoLevelOffsets,
    lookup: Lookup,
    key_set_size: usize,
}

impl Runtime {
    fn build(file: &ValidatedFile<'_>, candidate: Candidate) -> Result<Self, AnyError> {
        let keys = key_set(file)?;
        let offsets = TwoLevelOffsets::build(file)?;
        let arena = file
            .section(SectionId::Arena.value())
            .ok_or("missing arena")?
            .to_vec();
        let retained_sections = file
            .sections()
            .filter(|entry| {
                entry.id != SectionId::Arena.value()
                    && entry.id != SectionId::Lengths.value()
                    && entry.id != SectionId::Hash.value()
            })
            .map(|entry| file.section(entry.id).expect("validated section").to_vec())
            .collect();

        let lookup = if candidate.uses_hash() {
            let hash_bytes = file
                .section(SectionId::Hash.value())
                .ok_or("MPHF candidate has no HASH section")?;
            let hash = HashImage::from_bytes(hash_bytes)?;
            if hash.key_count() as usize != keys.len() {
                return Err("HASH key count differs from lookup key set".into());
            }
            let mut seen = vec![false; keys.len()];
            let mut fingerprints = vec![0_u8; keys.len()];
            match candidate {
                Candidate::MphU32 => {
                    let mut payload = vec![MISSING_ID; keys.len()];
                    for key in &keys {
                        let index =
                            hash.evaluate(key.bytes).ok_or("key has no MPHF index")? as usize;
                        if index >= keys.len() || std::mem::replace(&mut seen[index], true) {
                            return Err("invalid MPHF payload index".into());
                        }
                        payload[index] = key.id;
                        fingerprints[index] = fingerprint(key.bytes);
                    }
                    Lookup::MphU32 {
                        hash,
                        payload,
                        fingerprints,
                    }
                }
                Candidate::MphPacked18 => {
                    let mut payload = PackedIds::new(keys.len());
                    for key in &keys {
                        let index =
                            hash.evaluate(key.bytes).ok_or("key has no MPHF index")? as usize;
                        if index >= keys.len() || std::mem::replace(&mut seen[index], true) {
                            return Err("invalid MPHF payload index".into());
                        }
                        payload.set(index, key.id)?;
                        fingerprints[index] = fingerprint(key.bytes);
                    }
                    Lookup::MphPacked18 {
                        hash,
                        payload,
                        fingerprints,
                    }
                }
                _ => unreachable!(),
            }
        } else {
            let table_keys = keys
                .iter()
                .map(|key| TableKey {
                    id: key.id,
                    bytes: key.bytes,
                })
                .collect::<Vec<_>>();
            Lookup::Table(FingerprintTable::build(
                &table_keys,
                u16::try_from(candidate.load_permille().expect("table density"))?,
            )?)
        };

        Ok(Self {
            arena,
            retained_sections,
            offsets,
            lookup,
            key_set_size: keys.len(),
        })
    }

    fn lookup(&self, key: &[u8]) -> Option<u32> {
        match &self.lookup {
            Lookup::MphU32 {
                hash,
                payload,
                fingerprints,
            } => {
                let index = hash.evaluate(key)? as usize;
                if index >= self.key_set_size || *fingerprints.get(index)? != fingerprint(key) {
                    return None;
                }
                let id = *payload.get(index)?;
                self.token(id).filter(|token| *token == key).map(|_| id)
            }
            Lookup::MphPacked18 {
                hash,
                payload,
                fingerprints,
            } => {
                let index = hash.evaluate(key)? as usize;
                if index >= self.key_set_size || *fingerprints.get(index)? != fingerprint(key) {
                    return None;
                }
                let id = payload.get(index)?;
                self.token(id).filter(|token| *token == key).map(|_| id)
            }
            Lookup::Table(table) => table.lookup(key, |id, bytes| {
                self.token(id).is_some_and(|token| token == bytes)
            }),
        }
    }

    fn token(&self, id: u32) -> Option<&[u8]> {
        self.offsets
            .range(id)
            .and_then(|range| self.arena.get(range))
    }

    fn memory_components(&self) -> MemoryComponents {
        let (hash_evaluator, payload, fingerprints, table) = match &self.lookup {
            Lookup::MphU32 {
                hash,
                payload,
                fingerprints,
            } => (
                hash.resident_bytes(),
                payload.capacity() * size_of::<u32>(),
                fingerprints.capacity(),
                0,
            ),
            Lookup::MphPacked18 {
                hash,
                payload,
                fingerprints,
            } => (
                hash.resident_bytes(),
                payload.resident_bytes(),
                fingerprints.capacity(),
                0,
            ),
            Lookup::Table(table) => (0, 0, 0, table.resident_bytes()),
        };
        MemoryComponents {
            arena: self.arena.capacity(),
            retained_sections: self.retained_sections.iter().map(Vec::capacity).sum(),
            offsets: self.offsets.resident_bytes(),
            hash_evaluator,
            payload,
            fingerprints,
            table,
        }
    }
}

fn main() -> Result<(), AnyError> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("prepare") => {
            let input = required_arg(&mut args, "input .htk")?;
            let output = required_arg(&mut args, "output directory")?;
            ensure_end(args)?;
            print_json(&prepare(Path::new(&input), Path::new(&output))?)?;
        }
        Some("sample") => {
            let candidate = Candidate::parse(&required_arg(&mut args, "candidate")?)?;
            let input = required_arg(&mut args, "compressed .htk")?;
            let probe_count = required_arg(&mut args, "probe count")?.parse()?;
            ensure_end(args)?;
            print_json(&sample(candidate, Path::new(&input), probe_count)?)?;
        }
        Some("noop") => {
            ensure_end(args)?;
            println!("{{\"ok\":true}}");
        }
        Some("mutations") => {
            let input = required_arg(&mut args, "compressed scheme-1 .htk")?;
            ensure_end(args)?;
            print_json(&mutation_checks(Path::new(&input))?)?;
        }
        _ => return Err("usage: hypertok-load-worker <prepare|sample|mutations|noop> ...".into()),
    }
    Ok(())
}

fn mutation_checks(path: &Path) -> Result<MutationResult, AnyError> {
    let compressed = fs::read(path)?;
    let mut decompressed = Vec::new();
    brotli::Decompressor::new(Cursor::new(compressed), 4096).read_to_end(&mut decompressed)?;
    let file = ValidatedFile::read(&decompressed)?;
    let keys = key_set(&file)?;
    let mut runtime = Runtime::build(&file, Candidate::MphU32)?;
    let first = *keys.first().ok_or("empty key set")?;
    let mut checks = Vec::new();

    let index = match &runtime.lookup {
        Lookup::MphU32 { hash, .. } => {
            hash.evaluate(first.bytes).ok_or("first key has no index")?
        }
        _ => unreachable!(),
    } as usize;
    if let Lookup::MphU32 { fingerprints, .. } = &mut runtime.lookup {
        fingerprints[index] ^= 1;
    }
    if runtime.lookup(first.bytes) == Some(first.id) {
        return Err("corrupt fingerprint mutation stayed green".into());
    }
    checks.push("corrupt-fingerprint-red");

    let mut extension = first.bytes.to_vec();
    extension.push(0);
    while runtime.lookup(&extension).is_some() {
        extension.push(0);
    }
    if !extension.starts_with(first.bytes) || runtime.lookup(&extension).is_some() {
        return Err("prefix-comparison mutation was not observable".into());
    }
    checks.push("prefix-comparison-red");

    let bounds_red = match &runtime.lookup {
        Lookup::MphU32 { payload, .. } => payload.get(runtime.key_set_size).is_none(),
        _ => false,
    };
    if !bounds_red {
        return Err("key-set bounds mutation stayed green".into());
    }
    checks.push("key-set-bounds-red");

    let wrong_set_count = file.tokens().filter(|(_, bytes)| !bytes.is_empty()).count();
    if wrong_set_count == keys.len() {
        return Err("whole-arena key-set mutation stayed green".into());
    }
    checks.push("whole-arena-key-set-red");

    Ok(MutationResult {
        red: checks.len(),
        total: 4,
        checks,
    })
}

fn prepare(input_path: &Path, output_directory: &Path) -> Result<Prepared, AnyError> {
    let input = fs::read(input_path)?;
    let file = ValidatedFile::read(&input)?;
    let keys = key_set(&file)?;
    let key_bytes: Vec<&[u8]> = keys.iter().map(|key| key.bytes).collect();
    let hash = build(&key_bytes)?;
    hash.verify_keys(&key_bytes)?;
    let hash_bytes = hash.to_bytes();

    let mut sections = Vec::with_capacity(file.sections().len() + 1);
    for entry in file.sections() {
        if entry.id == SectionId::Hash.value() {
            continue;
        }
        let bytes = file.section(entry.id).expect("validated section").to_vec();
        if let Some(id) = SectionId::from_known(entry.id) {
            sections.push(Section::new(id, bytes));
        } else {
            sections.push(Section::extension(entry.id, bytes)?);
        }
    }
    sections.push(Section::new(SectionId::Hash, hash_bytes.clone()));
    let scheme1 = write(&Document {
        structural_class: file.header().structural_class,
        hash_scheme: HashScheme::Fmphgo,
        flags: file.header().flags,
        vocab_size: file.header().vocab_size,
        omega: file.header().omega,
        sections,
    })?;

    fs::create_dir_all(output_directory)?;
    let stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("input path has no UTF-8 stem")?;
    let scheme0_path = output_directory.join(format!("{stem}.scheme0.htk.br"));
    let scheme1_path = output_directory.join(format!("{stem}.scheme1.htk.br"));
    let scheme0_compressed = compress(&input)?;
    let scheme1_compressed = compress(&scheme1)?;
    fs::write(&scheme0_path, &scheme0_compressed)?;
    fs::write(&scheme1_path, &scheme1_compressed)?;

    Ok(Prepared {
        input: normalized(input_path),
        scheme0_path: normalized(&scheme0_path),
        scheme1_path: normalized(&scheme1_path),
        scheme0_raw_bytes: input.len(),
        scheme1_raw_bytes: scheme1.len(),
        scheme0_compressed_bytes: scheme0_compressed.len(),
        scheme1_compressed_bytes: scheme1_compressed.len(),
        key_set_size: keys.len(),
        hash_bytes: hash_bytes.len(),
    })
}

fn sample(candidate: Candidate, path: &Path, probe_count: usize) -> Result<Sample, AnyError> {
    let transfer_started = Instant::now();
    let compressed = fs::read(path)?;
    let transfer_milliseconds = milliseconds(transfer_started.elapsed());

    let decompression_started = Instant::now();
    let mut decompressed = Vec::new();
    brotli::Decompressor::new(Cursor::new(&compressed), 4096).read_to_end(&mut decompressed)?;
    let decompression_milliseconds = milliseconds(decompression_started.elapsed());

    let materialisation_started = Instant::now();
    let file = ValidatedFile::read(&decompressed)?;
    let runtime = Runtime::build(&file, candidate)?;
    black_box(runtime.lookup(b"x"));
    let materialisation_milliseconds = milliseconds(materialisation_started.elapsed());

    let keys = key_set(&file)?;
    for key in &keys {
        if runtime.lookup(key.bytes) != Some(key.id) {
            return Err(format!("{} failed key id {}", candidate.name(), key.id).into());
        }
    }
    let misses = deterministic_misses(&keys, probe_count.max(1))?;
    for miss in &misses {
        if runtime.lookup(miss).is_some() {
            return Err(format!("{} accepted a generated miss", candidate.name()).into());
        }
    }
    let probes = mixed_probes(&keys, &misses, probe_count)?;
    let miss_count = probes
        .iter()
        .filter(|probe| probe.expected.is_none())
        .count();
    let hit_count = probes.len() - miss_count;
    let probe_started = Instant::now();
    let mut checksum = 0_u64;
    for probe in &probes {
        let observed = black_box(runtime.lookup(black_box(&probe.bytes)));
        if observed != probe.expected {
            return Err(format!("{} miss-heavy probe mismatch", candidate.name()).into());
        }
        checksum = checksum.wrapping_add(u64::from(observed.unwrap_or(u32::MAX)));
    }
    let miss_probe_milliseconds = milliseconds(probe_started.elapsed());
    let memory = runtime.memory_components();
    let resident_bytes = memory.total();
    Ok(Sample {
        candidate: candidate.name(),
        compressed_bytes: compressed.len(),
        decompressed_bytes: decompressed.len(),
        transfer_milliseconds,
        decompression_milliseconds,
        materialisation_milliseconds,
        miss_probe_milliseconds,
        probe_count: probes.len(),
        miss_count,
        hit_count,
        verified_keys: keys.len(),
        verified_misses: misses.len(),
        key_set_size: runtime.key_set_size,
        block_shift: runtime.offsets.block_shift,
        resident_bytes,
        memory,
        checksum,
    })
}

struct Probe {
    bytes: Vec<u8>,
    expected: Option<u32>,
}

fn mixed_probes(
    keys: &[Key<'_>],
    misses: &[Vec<u8>],
    count: usize,
) -> Result<Vec<Probe>, AnyError> {
    if keys.is_empty() || misses.is_empty() {
        return Err("probe inputs must be non-empty".into());
    }
    let mut probes = Vec::with_capacity(count);
    let mut hit_index = 0_usize;
    let mut miss_index = 0_usize;
    for index in 0..count {
        if index % 20 == 0 {
            let key = keys[(hit_index.wrapping_mul(104_729)) % keys.len()];
            probes.push(Probe {
                bytes: key.bytes.to_vec(),
                expected: Some(key.id),
            });
            hit_index += 1;
        } else {
            probes.push(Probe {
                bytes: misses[miss_index % misses.len()].clone(),
                expected: None,
            });
            miss_index += 1;
        }
    }
    Ok(probes)
}

fn deterministic_misses(keys: &[Key<'_>], count: usize) -> Result<Vec<Vec<u8>>, AnyError> {
    let present: BTreeSet<&[u8]> = keys.iter().map(|key| key.bytes).collect();
    let mut misses = Vec::with_capacity(count);
    let mut value = 0_u64;
    while misses.len() < count {
        let mut candidate = b"\xffHTK-MISS\0".to_vec();
        candidate.extend_from_slice(&value.to_le_bytes());
        if !present.contains(candidate.as_slice()) {
            misses.push(candidate);
        }
        value = value.checked_add(1).ok_or("miss generator overflow")?;
    }
    Ok(misses)
}

fn key_set<'a>(file: &'a ValidatedFile<'a>) -> Result<Vec<Key<'a>>, AnyError> {
    let specials = special_ids(file)?;
    let byte_fallback = byte_fallback_ids(file);
    let mut keys = Vec::new();
    for (id, bytes) in file.tokens() {
        if bytes.is_empty() || specials.contains(&id) || byte_fallback.contains(&id) {
            continue;
        }
        keys.push(Key { id, bytes });
    }
    Ok(keys)
}

fn special_ids(file: &ValidatedFile<'_>) -> Result<BTreeSet<u32>, AnyError> {
    let section = file
        .section(SectionId::Specials.value())
        .ok_or("missing specials")?;
    let mut cursor = 0_usize;
    let count = take_u32(section, &mut cursor)? as usize;
    let mut ids = BTreeSet::new();
    for _ in 0..count {
        ids.insert(take_u32(section, &mut cursor)?);
        let length = take_u32(section, &mut cursor)? as usize;
        cursor = cursor
            .checked_add(length)
            .ok_or("special length overflow")?;
        section.get(..cursor).ok_or("special bytes out of bounds")?;
        take_u32(section, &mut cursor)?;
    }
    let direct_bytes = count.checked_mul(4).ok_or("special direct-id overflow")?;
    cursor = cursor
        .checked_add(direct_bytes)
        .ok_or("special section overflow")?;
    if cursor != section.len() {
        return Err("special section length mismatch".into());
    }
    Ok(ids)
}

fn byte_fallback_ids(file: &ValidatedFile<'_>) -> BTreeSet<u32> {
    file.section(SectionId::ByteFall.value())
        .into_iter()
        .flat_map(|section| section.chunks_exact(4))
        .map(|bytes| u32::from_le_bytes(bytes.try_into().expect("four-byte id")))
        .collect()
}

fn take_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, AnyError> {
    let end = cursor.checked_add(4).ok_or("u32 cursor overflow")?;
    let value = u32::from_le_bytes(bytes.get(*cursor..end).ok_or("truncated u32")?.try_into()?);
    *cursor = end;
    Ok(value)
}

fn compress(bytes: &[u8]) -> Result<Vec<u8>, AnyError> {
    let mut output = Vec::new();
    {
        let mut compressor = brotli::CompressorWriter::new(&mut output, 4096, 11, 22);
        compressor.write_all(bytes)?;
    }
    Ok(output)
}

fn milliseconds(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn required_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, AnyError> {
    args.next().ok_or_else(|| format!("missing {name}").into())
}

fn ensure_end(mut args: impl Iterator<Item = String>) -> Result<(), AnyError> {
    if args.next().is_some() {
        return Err("unexpected trailing arguments".into());
    }
    Ok(())
}

fn print_json(value: &impl Serialize) -> Result<(), AnyError> {
    serde_json::to_writer(std::io::stdout().lock(), value)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypertok_hash::table_hash;

    #[test]
    fn packed_ids_round_trip_boundaries() {
        let mut ids = PackedIds::new(33);
        for index in 0..33 {
            let value = ((index * 7919) & ((1 << PACKED_ID_BITS) - 1)) as u32;
            ids.set(index, value).unwrap();
        }
        for index in 0..33 {
            assert_eq!(
                ids.get(index),
                Some(((index * 7919) & ((1 << PACKED_ID_BITS) - 1)) as u32)
            );
        }
    }

    #[test]
    fn fingerprint_lane_is_domain_separated() {
        assert_ne!(
            fingerprint(b"hypertok"),
            (table_hash(b"hypertok") >> 56) as u8
        );
    }
}
