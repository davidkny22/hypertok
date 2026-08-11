use super::*;
use hypertok_converter::{Document, Section, write};
use hypertok_format::{DIGEST_RANGE, SectionId};

fn tracked(path: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
        .unwrap_or_else(|error| panic!("read tracked fixture {path}: {error}"))
}

fn with_prebuilt_built_state(source: &[u8]) -> Vec<u8> {
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
            PREBUILT_BUILT_STATE_SECTION_ID,
            build_prebuilt_built_state_image(source).expect("build built-state image"),
        )
        .expect("available built-state section"),
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
fn resolver_provenance_preserves_exact_runtime_behavior() {
    let source = tracked("hypertok-vocab/gpt2/vocab.htk");
    let candidate = with_prebuilt_built_state(&source);
    let mut reference = load_htk_slice(&source).expect("load source vocabulary");
    let mut trusted =
        load_resolver_trusted_htk_slice(&candidate).expect("load resolver-owned vocabulary");
    for text in [
        "Plain prose with punctuation.",
        "const answer = (x) => x * 42;\n",
        "\u{4e2d}\u{6587}\u{3068}\u{65e5}\u{672c}\u{8a9e}",
        "\u{1f469}\u{1f3fd}\u{200d}\u{1f4bb}\u{1f680}",
        " \t\n\n\u{feff} boundary ",
    ] {
        let expected = reference.tokenizer.encode(text);
        let actual = trusted.tokenizer.encode(text);
        assert_eq!(actual, expected, "encode parity for {text:?}");
        assert_eq!(trusted.tokenizer.decode(&actual), text.as_bytes());
    }
}

#[test]
fn only_resolver_provenance_bypasses_the_file_digest() {
    let source = tracked("hypertok-vocab/gpt2/vocab.htk");
    let mut candidate = with_prebuilt_built_state(&source);
    candidate[DIGEST_RANGE.start] ^= 1;
    assert!(
        load_htk_slice(&candidate).is_err(),
        "arbitrary bytes must retain digest refusal"
    );
    let mut trusted =
        load_resolver_trusted_htk_slice(&candidate).expect("resolver provenance skips hashing");
    let text = "resolver-owned bytes remain exact";
    let ids = trusted.tokenizer.encode(text);
    assert_eq!(trusted.tokenizer.decode(&ids), text.as_bytes());
}
