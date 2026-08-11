#![cfg(feature = "opt-prebuilt-pair-ranks")]

use hypertok::load_tokenizer::htk::{
    PREBUILT_PAIR_RANKS_SECTION_ID, build_prebuilt_pair_image, load_htk_slice,
};
use hypertok_converter::{Document, Section, write};
use hypertok_format::{DIGEST_RANGE, SectionId, ValidatedFile, compute_digest};

fn tracked(path: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
        .unwrap_or_else(|error| panic!("read tracked fixture {path}: {error}"))
}

fn with_prebuilt_pairs(source: &[u8]) -> Vec<u8> {
    let file = ValidatedFile::read(source).expect("validate source vocabulary");
    let mut sections = file
        .sections()
        .map(|entry| {
            let bytes = file.section(entry.id).expect("validated section").to_vec();
            match SectionId::from_known(entry.id) {
                Some(id) => Section::new(id, bytes),
                None => Section::extension(entry.id, bytes).expect("valid source extension"),
            }
        })
        .collect::<Vec<_>>();
    sections.push(
        Section::extension(
            PREBUILT_PAIR_RANKS_SECTION_ID,
            build_prebuilt_pair_image(source).expect("build pair image"),
        )
        .expect("available pair-image section"),
    );
    write(&Document {
        structural_class: file.header().structural_class,
        hash_scheme: file.header().hash_scheme,
        flags: file.header().flags,
        vocab_size: file.header().vocab_size,
        omega: file.header().omega,
        sections,
    })
    .expect("write candidate vocabulary")
}

#[test]
fn prebuilt_pairs_preserve_runtime_behavior() {
    let source = tracked("hypertok-vocab/gpt2/vocab.htk");
    let candidate = with_prebuilt_pairs(&source);
    let mut reference = load_htk_slice(&source).expect("load source vocabulary");
    let mut prebuilt = load_htk_slice(&candidate).expect("load prebuilt vocabulary");
    for text in [
        "Plain prose with punctuation.",
        "const answer = (x) => x * 42;\n",
        "\u{4e2d}\u{6587}\u{3068}\u{65e5}\u{672c}\u{8a9e}",
        "\u{1f469}\u{1f3fd}\u{200d}\u{1f4bb}\u{1f680}",
        " \t\n\n\u{feff} boundary ",
    ] {
        let expected = reference.tokenizer.encode(text);
        let actual = prebuilt.tokenizer.encode(text);
        assert_eq!(actual, expected, "encode parity for {text:?}");
        assert_eq!(prebuilt.tokenizer.decode(&actual), text.as_bytes());
    }
}

#[test]
fn digest_valid_pair_corruption_is_refused() {
    let source = tracked("hypertok-vocab/gpt2/vocab.htk");
    let mut candidate = with_prebuilt_pairs(&source);
    let entry = *ValidatedFile::read(&candidate)
        .expect("validate candidate")
        .section_entry(PREBUILT_PAIR_RANKS_SECTION_ID)
        .expect("pair-image section");
    let start = entry.offset as usize;
    let end = start + entry.length as usize;
    candidate[start + 64] ^= 1;
    let section_digest = compute_digest(&candidate[start..end]);
    candidate[start + 32..start + 64].copy_from_slice(&section_digest);
    let file_digest = compute_digest(&candidate);
    candidate[DIGEST_RANGE].copy_from_slice(&file_digest);
    assert!(
        load_htk_slice(&candidate).is_err(),
        "semantic pair corruption must remain on the untrusted refusal path"
    );
}
