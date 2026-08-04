use hypertok::load_tokenizer::htk::{LoadedHtk, load_htk_slice};
use hypertok::load_tokenizer::htk_chunk::{ChunkConfig, ChunkError};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const WORKLOADS: [&str; 6] = [
    "english-prose.txt",
    "chinese.txt",
    "source-code.txt",
    "emoji-heavy.txt",
    "long-document.txt",
    "standard-text.txt",
];

fn main() {
    let mut args = env::args().skip(1);
    let o200k_path = required_path(&mut args, "o200k .htk path");
    let llama_path = required_path(&mut args, "Llama .htk path");
    let corpus_dir = required_path(&mut args, "corpus directory");
    let mode = args.next().unwrap_or_else(|| "gate".to_string());
    if args.next().is_some() {
        panic!("unexpected extra argument");
    }

    let mut o200k = load(&o200k_path);
    let mut llama = load(&llama_path);
    match mode.as_str() {
        "gate" => run_gate(&mut o200k, &mut llama, &corpus_dir),
        "mutation-probe" => run_mutation_probe(&mut o200k),
        value => panic!("unknown mode {value}"),
    }
}

fn run_gate(o200k: &mut LoadedHtk, llama: &mut LoadedHtk, corpus_dir: &Path) {
    let mut workload_cases = 0;
    let mut workload_chunks = 0;
    let mut workload_enlargements = 0;

    for filename in WORKLOADS {
        let source = fs::read(corpus_dir.join(filename)).expect("workload bytes");
        let byte_input = repeated_prefix(&source, 16_384, false);
        let byte_result = exact_case(o200k, &byte_input, None, &format!("o200k:{filename}"));
        workload_cases += 1;
        workload_chunks += byte_result.0;
        workload_enlargements += byte_result.1;

        let codepoint_source = std::str::from_utf8(&source).expect("UTF-8 workload");
        let normalized = codepoint_source.replace(' ', "▁");
        let codepoint_input = repeated_prefix(normalized.as_bytes(), 8_192, true);
        let codepoint_result =
            exact_case(llama, &codepoint_input, None, &format!("llama:{filename}"));
        workload_cases += 1;
        workload_chunks += codepoint_result.0;
        workload_enlargements += codepoint_result.1;
    }

    let mut adversarial_cases = 0;
    let mut adversarial_enlargements = 0;
    for (label, input, sizes) in [
        (
            "o200k:spaces",
            vec![b' '; 8_192],
            vec![None, Some(4_095), Some(1_000), Some(500)],
        ),
        ("o200k:ampersands", vec![b'&'; 3_000], vec![Some(501)]),
        (
            "o200k:phase-shifted-spaces",
            [b"a".as_slice(), vec![b' '; 8_191].as_slice()].concat(),
            vec![Some(501), Some(1_000)],
        ),
    ] {
        for size in sizes {
            let (_, enlargements) = exact_case(o200k, &input, size, label);
            adversarial_cases += 1;
            adversarial_enlargements += enlargements;
        }
    }

    let mark = "▁".repeat(2_730);
    let llama_cases = [
        ("llama:marks", mark.clone()),
        ("llama:prefix-one", format!("I{mark}")),
        ("llama:prefix-two", format!("in{mark}")),
        ("llama:tail", format!("{mark}I")),
    ];
    for (label, input) in llama_cases {
        for size in [None, Some(4_096), Some(1_000), Some(500)] {
            let (_, enlargements) = exact_case(llama, input.as_bytes(), size, label);
            adversarial_cases += 1;
            adversarial_enlargements += enlargements;
        }
    }

    assert!(
        adversarial_enlargements > 0,
        "adversarial cases never exercised enlargement"
    );
    assumption_negatives(o200k, llama);
    println!(
        "overlap-parity PASS: workloads={workload_cases}/{workload_cases} workload_chunks={workload_chunks} workload_enlargements={workload_enlargements} adversarial={adversarial_cases}/{adversarial_cases} adversarial_enlargements={adversarial_enlargements} assumption_negatives=2/2"
    );
}

fn run_mutation_probe(o200k: &mut LoadedHtk) {
    let input = [b"a".as_slice(), vec![b' '; 8_191].as_slice()].concat();
    exact_case_with_fault(o200k, &input, Some(501), "mutation-probe", true);
    println!("mutation probe unexpectedly stayed exact");
}

fn exact_case(
    loaded: &mut LoadedHtk,
    input: &[u8],
    chunk_size: Option<usize>,
    label: &str,
) -> (usize, usize) {
    exact_case_with_fault(loaded, input, chunk_size, label, false)
}

fn exact_case_with_fault(
    loaded: &mut LoadedHtk,
    input: &[u8],
    chunk_size: Option<usize>,
    label: &str,
    fault: bool,
) -> (usize, usize) {
    let unsplit_size = input.len().max((loaded.omega as usize).saturating_mul(2));
    let unsplit = loaded
        .tokenizer
        .encode_pretoken_chunked(
            &loaded.lookup_index,
            loaded.omega,
            input,
            ChunkConfig {
                chunk_size: Some(unsplit_size),
            },
        )
        .unwrap_or_else(|error| panic!("{label} unsplit failed: {error}"));
    assert_eq!(unsplit.initial_chunks, 1, "{label} unsplit geometry");

    let mut chunked = loaded
        .tokenizer
        .encode_pretoken_chunked(
            &loaded.lookup_index,
            loaded.omega,
            input,
            ChunkConfig { chunk_size },
        )
        .unwrap_or_else(|error| panic!("{label} chunked failed: {error}"));
    if fault && !chunked.ids.is_empty() {
        chunked.ids[0] ^= 1;
    }
    assert_eq!(chunked.ids, unsplit.ids, "{label} token divergence");
    assert!(
        chunked.initial_chunks > 1,
        "{label} did not engage chunking"
    );
    println!(
        "CASE {label} size={} chunks={} enlargements={} largest_span={} ids={}",
        chunk_size
            .map(|value| value.to_string())
            .unwrap_or_else(|| "default".to_string()),
        chunked.initial_chunks,
        chunked.enlargements,
        chunked.largest_encoded_span,
        chunked.ids.len()
    );
    (chunked.initial_chunks, chunked.enlargements)
}

fn assumption_negatives(o200k: &mut LoadedHtk, llama: &mut LoadedHtk) {
    let too_small = (o200k.omega as usize) * 2 - 1;
    let error = o200k
        .tokenizer
        .encode_pretoken_chunked(
            &o200k.lookup_index,
            o200k.omega,
            &[b'x'; 512],
            ChunkConfig {
                chunk_size: Some(too_small),
            },
        )
        .unwrap_err();
    assert!(matches!(error, ChunkError::ChunkTooSmall { .. }));

    let error = llama
        .tokenizer
        .encode_pretoken_chunked(
            &llama.lookup_index,
            llama.omega,
            &[0xff; 512],
            ChunkConfig::default(),
        )
        .unwrap_err();
    assert_eq!(error, ChunkError::InvalidUtf8Pretoken);
}

fn repeated_prefix(source: &[u8], minimum: usize, codepoint_edges: bool) -> Vec<u8> {
    assert!(!source.is_empty());
    let target = minimum.max(source.len().min(32_768));
    let mut output = Vec::with_capacity(target + source.len());
    while output.len() < target {
        output.extend_from_slice(source);
    }
    output.truncate(target);
    if codepoint_edges {
        while std::str::from_utf8(&output).is_err() {
            output.pop();
        }
    }
    output
}

fn load(path: &Path) -> LoadedHtk {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    load_htk_slice(&bytes).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn required_path(args: &mut impl Iterator<Item = String>, label: &str) -> PathBuf {
    PathBuf::from(args.next().unwrap_or_else(|| panic!("missing {label}")))
}
