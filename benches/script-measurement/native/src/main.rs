use hypertok::load_tokenizer::htk::{HtkTokenizer, LoadedHtk, load_htk_slice};
use hypertok::load_tokenizer::htk_chunk::{ChunkConfig, ChunkError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::error::Error;
use std::hint::black_box;
use std::path::Path;
use std::time::Instant;

const WORKLOADS: [(&str, &str); 10] = [
    ("english-prose", "english-prose.txt"),
    ("chinese", "chinese.txt"),
    ("source-code", "source-code.txt"),
    ("emoji-heavy", "emoji-heavy.txt"),
    ("long-document", "long-document.txt"),
    ("standard-text", "standard-text.txt"),
    ("script-latin", "script-latin.txt"),
    ("script-han", "script-han.txt"),
    ("script-arabic", "script-arabic.txt"),
    ("script-emoji", "script-emoji.txt"),
];

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkTelemetry {
    pretokens: usize,
    engaged_pretokens: usize,
    initial_chunks: usize,
    enlargements: usize,
    largest_encoded_span: usize,
    chunk_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Statistics {
    n: usize,
    median: f64,
    p95: f64,
    variance: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    workload: &'static str,
    workload_bytes: usize,
    environment: &'static str,
    tier: &'static str,
    simd_level: &'static str,
    chunking: bool,
    clock_regime: &'static str,
    statistics: Statistics,
    units: &'static str,
    iterations_per_sample: usize,
    bytes_per_sample: usize,
    token_count: usize,
    id_digest: String,
    chunk_telemetry: Option<ChunkTelemetry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgreementRow {
    workload: &'static str,
    token_count: usize,
    id_digest: String,
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--agreement")
    {
        return print_agreement(&arguments[1..]);
    }
    let mut args = arguments.into_iter();
    let htk_path = args.next().ok_or("missing .htk path")?;
    let corpus_path = args.next().ok_or("missing corpus path")?;
    let n: usize = args.next().ok_or("missing sample count")?.parse()?;
    let warmup: usize = args.next().ok_or("missing warmup count")?.parse()?;
    let target_bytes: usize = args.next().ok_or("missing byte target")?.parse()?;
    if args.next().is_some() || n == 0 || target_bytes == 0 {
        return Err("invalid native measurement arguments".into());
    }

    let simd_level = native_simd_level()?;
    let htk_bytes = std::fs::read(htk_path)?;
    let mut rows = Vec::with_capacity(WORKLOADS.len() * 2);
    for (workload, filename) in WORKLOADS {
        let input = std::fs::read(Path::new(&corpus_path).join(filename))?;
        let text = std::str::from_utf8(&input)?;
        for chunking in [false, true] {
            let mut loaded = load_htk_slice(&htk_bytes)?;
            let reference = loaded.tokenizer.encode(text);
            let (agreement, _) = encode_once(&mut loaded, &input, chunking)?;
            if agreement != reference {
                return Err(format!("{workload} native chunk agreement failed").into());
            }

            let iterations = iterations_for(input.len(), target_bytes);
            for _ in 0..warmup {
                for _ in 0..iterations {
                    black_box(encode_once(&mut loaded, &input, chunking)?.0);
                }
            }

            let mut samples = Vec::with_capacity(n);
            let mut last_ids = Vec::new();
            let mut last_telemetry = ChunkTelemetry::default();
            for _ in 0..n {
                let started = Instant::now();
                for _ in 0..iterations {
                    (last_ids, last_telemetry) = encode_once(&mut loaded, &input, chunking)?;
                    black_box(&last_ids);
                }
                let elapsed = started.elapsed().as_secs_f64();
                if !elapsed.is_finite() || elapsed <= 0.0 {
                    return Err("native timer produced a non-positive duration".into());
                }
                samples.push((input.len() * iterations) as f64 / elapsed / 1_000_000.0);
            }

            rows.push(Row {
                workload,
                workload_bytes: input.len(),
                environment: "hypertok-host",
                tier: "single",
                simd_level,
                chunking,
                clock_regime: "Rust Instant; single process; warm cache",
                statistics: summarize(&samples),
                units: "MB/s",
                iterations_per_sample: iterations,
                bytes_per_sample: input.len() * iterations,
                token_count: last_ids.len(),
                id_digest: id_digest(&last_ids),
                chunk_telemetry: chunking.then_some(last_telemetry),
            });
        }
    }
    println!("{}", serde_json::to_string(&rows)?);
    Ok(())
}

fn print_agreement(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let [htk_path, corpus_path] = arguments else {
        return Err("usage: --agreement .htk-path corpus-path".into());
    };
    let htk_bytes = std::fs::read(htk_path)?;
    let mut rows = Vec::with_capacity(WORKLOADS.len());
    for (workload, filename) in WORKLOADS {
        let input = std::fs::read(Path::new(corpus_path).join(filename))?;
        let text = std::str::from_utf8(&input)?;
        let mut loaded = load_htk_slice(&htk_bytes)?;
        let ids = loaded.tokenizer.encode(text);
        rows.push(AgreementRow {
            workload,
            token_count: ids.len(),
            id_digest: id_digest(&ids),
        });
    }
    println!("{}", serde_json::to_string(&rows)?);
    Ok(())
}

fn encode_once(
    loaded: &mut LoadedHtk,
    input: &[u8],
    chunking: bool,
) -> Result<(Vec<u32>, ChunkTelemetry), ChunkError> {
    if !chunking {
        let text = std::str::from_utf8(input).map_err(|_| ChunkError::InvalidUtf8Pretoken)?;
        return Ok((loaded.tokenizer.encode(text), ChunkTelemetry::default()));
    }

    let base = input.as_ptr() as usize;
    let ranges = match &loaded.tokenizer {
        HtkTokenizer::ByteBpe(tokenizer) => tokenizer
            .pretokenizer_type()
            .pretokenize(input)
            .map(|pretoken| {
                let bytes = pretoken.as_ref();
                let start = bytes.as_ptr() as usize - base;
                start..start + bytes.len()
            })
            .collect::<Vec<_>>(),
    };

    let chunk_size = usize::try_from(loaded.omega)
        .map_err(|_| ChunkError::ChunkSizeOverflow)?
        .checked_mul(2)
        .ok_or(ChunkError::ChunkSizeOverflow)?;
    let mut ids = Vec::new();
    let mut telemetry = ChunkTelemetry {
        chunk_size,
        ..ChunkTelemetry::default()
    };
    if ranges.iter().all(|range| range.len() <= chunk_size) {
        telemetry.pretokens = ranges.len();
        telemetry.initial_chunks = ranges.len();
        telemetry.largest_encoded_span = ranges.iter().map(|range| range.len()).max().unwrap_or(0);
        match &mut loaded.tokenizer {
            HtkTokenizer::ByteBpe(tokenizer) => {
                let scheme = tokenizer.pretokenizer_type();
                tokenizer.memoized_encode_flat(scheme.pretokenize(input), &mut ids);
            }
        }
        return Ok((ids, telemetry));
    }
    for range in ranges {
        let pretoken = &input[range];
        telemetry.pretokens += 1;
        telemetry.largest_encoded_span = telemetry.largest_encoded_span.max(pretoken.len());
        if pretoken.len() <= chunk_size {
            match &mut loaded.tokenizer {
                HtkTokenizer::ByteBpe(tokenizer) => {
                    let scheme = tokenizer.pretokenizer_type();
                    tokenizer.memoized_encode_flat(scheme.pretokenize(pretoken), &mut ids);
                }
            }
            telemetry.initial_chunks += 1;
            continue;
        }
        let result = loaded.tokenizer.encode_pretoken_chunked(
            &loaded.lookup_index,
            loaded.omega,
            pretoken,
            ChunkConfig {
                chunk_size: Some(chunk_size),
            },
        )?;
        telemetry.engaged_pretokens += usize::from(result.initial_chunks > 1);
        telemetry.initial_chunks += result.initial_chunks;
        telemetry.enlargements += result.enlargements;
        telemetry.largest_encoded_span = telemetry
            .largest_encoded_span
            .max(result.largest_encoded_span);
        ids.extend(result.ids);
    }
    Ok((ids, telemetry))
}

fn iterations_for(bytes: usize, target: usize) -> usize {
    target.div_ceil(bytes).clamp(1, 512)
}

fn summarize(samples: &[f64]) -> Statistics {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    let median = if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    };
    let p95 = sorted[(sorted.len() * 95).div_ceil(100) - 1];
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let variance = samples
        .iter()
        .map(|sample| (sample - mean).powi(2))
        .sum::<f64>()
        / samples.len() as f64;
    Statistics {
        n: samples.len(),
        median,
        p95,
        variance,
    }
}

fn id_digest(ids: &[u32]) -> String {
    let mut digest = Sha256::new();
    for id in ids {
        digest.update(id.to_le_bytes());
    }
    format!("{:x}", digest.finalize())
}

#[cfg(feature = "scalar")]
fn native_simd_level() -> Result<&'static str, Box<dyn Error>> {
    Ok("scalar")
}

#[cfg(not(feature = "scalar"))]
fn native_simd_level() -> Result<&'static str, Box<dyn Error>> {
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx512f")
            && std::arch::is_x86_feature_detected!("avx512bw")
            && std::arch::is_x86_feature_detected!("avx512vl")
            && std::arch::is_x86_feature_detected!("bmi1")
            && std::arch::is_x86_feature_detected!("bmi2")
            && std::arch::is_x86_feature_detected!("lzcnt")
            && std::arch::is_x86_feature_detected!("popcnt")
        {
            return Ok("avx512");
        }
        if std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("bmi1")
            && std::arch::is_x86_feature_detected!("bmi2")
            && std::arch::is_x86_feature_detected!("lzcnt")
            && std::arch::is_x86_feature_detected!("popcnt")
        {
            return Ok("avx2");
        }
    }
    Err("native SIMD measurement requested on a host without the scanner tier".into())
}
