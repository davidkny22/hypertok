use gigatoken_rs::Tokenizer;
use gigatoken_rs::load_tokenizer::tiktoken::load_tiktoken;
use gigatoken_rs::pretokenize::PretokenizerType;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::error::Error;
use std::hint::black_box;
use std::path::Path;
use std::time::Instant;

const REFERENCE: &str = "gigatoken";
const REFERENCE_VERSION: &str = env!("GIGATOKEN_REFERENCE_VERSION");
const REFERENCE_COMMIT: &str = env!("GIGATOKEN_REFERENCE_COMMIT");
const SOURCE_DIGEST: &str = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";

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
    reference: &'static str,
    reference_version: &'static str,
    reference_commit: &'static str,
    source_digest: &'static str,
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
    chunk_telemetry: Option<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgreementRow {
    workload: &'static str,
    reference: &'static str,
    reference_version: &'static str,
    reference_commit: &'static str,
    source_digest: &'static str,
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
    measure(&arguments)
}

fn print_agreement(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let [source_path, corpus_path] = arguments else {
        return Err("usage: --agreement source-path corpus-path".into());
    };
    verify_source(source_path)?;
    let mut tokenizer = load_reference(source_path)?;
    let mut rows = Vec::with_capacity(WORKLOADS.len());
    for (workload, filename) in WORKLOADS {
        let input = std::fs::read(Path::new(corpus_path).join(filename))?;
        let ids = encode_once(&mut tokenizer, &input);
        rows.push(AgreementRow {
            workload,
            reference: REFERENCE,
            reference_version: REFERENCE_VERSION,
            reference_commit: REFERENCE_COMMIT,
            source_digest: SOURCE_DIGEST,
            token_count: ids.len(),
            id_digest: id_digest(&ids),
        });
    }
    println!("{}", serde_json::to_string(&rows)?);
    Ok(())
}

fn measure(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let [source_path, corpus_path, n, warmup, target_bytes] = arguments else {
        return Err("usage: source-path corpus-path n warmup target-bytes".into());
    };
    let n: usize = n.parse()?;
    let warmup: usize = warmup.parse()?;
    let target_bytes: usize = target_bytes.parse()?;
    if n == 0 || target_bytes == 0 {
        return Err("invalid gigatoken reference measurement arguments".into());
    }
    verify_source(source_path)?;
    let mut tokenizer = load_reference(source_path)?;
    let simd_level = native_simd_level();
    let mut rows = Vec::with_capacity(WORKLOADS.len());
    for (workload, filename) in WORKLOADS {
        let input = std::fs::read(Path::new(corpus_path).join(filename))?;
        let agreement = encode_once(&mut tokenizer, &input);
        let iterations = iterations_for(input.len(), target_bytes);
        for _ in 0..warmup {
            for _ in 0..iterations {
                black_box(encode_once(&mut tokenizer, &input));
            }
        }

        let mut samples = Vec::with_capacity(n);
        let mut last_ids = Vec::new();
        for _ in 0..n {
            let started = Instant::now();
            for _ in 0..iterations {
                last_ids = encode_once(&mut tokenizer, &input);
                black_box(&last_ids);
            }
            let elapsed = started.elapsed().as_secs_f64();
            if !elapsed.is_finite() || elapsed <= 0.0 {
                return Err("gigatoken reference timer produced a non-positive duration".into());
            }
            samples.push((input.len() * iterations) as f64 / elapsed / 1_000_000.0);
        }
        if last_ids != agreement {
            return Err(format!("{workload} output changed during measurement").into());
        }
        rows.push(Row {
            workload,
            workload_bytes: input.len(),
            environment: "gigatoken-native",
            reference: REFERENCE,
            reference_version: REFERENCE_VERSION,
            reference_commit: REFERENCE_COMMIT,
            source_digest: SOURCE_DIGEST,
            tier: "single",
            simd_level,
            chunking: false,
            clock_regime: "Rust Instant; single process; warm cache",
            statistics: summarize(&samples),
            units: "MB/s",
            iterations_per_sample: iterations,
            bytes_per_sample: input.len() * iterations,
            token_count: last_ids.len(),
            id_digest: id_digest(&last_ids),
            chunk_telemetry: None,
        });
    }
    println!("{}", serde_json::to_string(&rows)?);
    Ok(())
}

fn load_reference(path: impl AsRef<Path>) -> Result<Tokenizer, Box<dyn Error>> {
    Ok(load_tiktoken(path, PretokenizerType::O200k, Vec::new())?)
}

fn verify_source(path: impl AsRef<Path>) -> Result<(), Box<dyn Error>> {
    let bytes = std::fs::read(path)?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    if digest != SOURCE_DIGEST {
        return Err(format!("gigatoken reference source digest mismatch: {digest}").into());
    }
    Ok(())
}

fn encode_once(tokenizer: &mut Tokenizer, input: &[u8]) -> Vec<u32> {
    let mut ids = Vec::new();
    tokenizer.encode_with_added_tokens_flat(input, &mut ids);
    ids
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

fn native_simd_level() -> &'static str {
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
            return "avx512";
        }
        if std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("bmi1")
            && std::arch::is_x86_feature_detected!("bmi2")
            && std::arch::is_x86_feature_detected!("lzcnt")
            && std::arch::is_x86_feature_detected!("popcnt")
        {
            return "avx2";
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
        return "neon";
    }
    "scalar"
}
