use hypertok::load_tokenizer::htk::{HtkTokenizer, load_htk_slice};
use hypertok_format::{StructuralClass, ValidatedFile};

fn tracked(path: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
        .unwrap_or_else(|error| panic!("read tracked fixture {path}: {error}"))
}

#[test]
fn byte_bpe_fixture_has_stable_mapping_and_runtime_output() {
    let bytes = tracked("hypertok-vocab/o200k/vocab.htk");
    let file = ValidatedFile::read(&bytes).expect("validate tracked byte-BPE fixture");
    assert_eq!(file.header().structural_class, StructuralClass::ByteBpe);
    assert_eq!(file.header().vocab_size, 200_019);

    let mut loaded = load_htk_slice(&bytes).expect("load tracked byte-BPE fixture");
    assert!(matches!(&loaded.tokenizer, HtkTokenizer::ByteBpe(_)));
    assert_eq!(loaded.lookup_index.key_count(), 199_998);
    for (text, expected) in [
        ("hello world", vec![24_912, 2_375]),
        (
            "Natural language processing needs exact bytes.",
            vec![68_650, 6_439, 12_323, 4_414, 6_354, 11_643, 13],
        ),
        ("\u{4e2d}\u{6587}", vec![10_667]),
        (
            "\u{1f469}\u{1f3fd}\u{200d}\u{1f4bb}",
            vec![28_823, 102, 52_622, 121, 2_524, 31_446, 119],
        ),
    ] {
        let ids = loaded.tokenizer.encode(text);
        assert_eq!(ids, expected, "stable byte-BPE ids for {text:?}");
        assert_eq!(loaded.tokenizer.decode(&ids), text.as_bytes());
    }
}

#[test]
fn sentencepiece_fixture_has_stable_merge_prefix_and_runtime_output() {
    let bytes = tracked("tests/fixtures/sentencepiece.htk");
    let file = ValidatedFile::read(&bytes).expect("validate tracked SentencePiece fixture");
    assert_eq!(
        file.header().structural_class,
        StructuralClass::SentencePieceBpe
    );
    assert_eq!(file.header().vocab_size, 261);

    let mut loaded = load_htk_slice(&bytes).expect("load tracked SentencePiece fixture");
    assert!(matches!(&loaded.tokenizer, HtkTokenizer::SentencePiece(_)));
    assert_eq!(loaded.prepend_ids, [259]);
    assert!(loaded.append_ids.is_empty());
    assert_eq!(loaded.lookup_index.lookup(b"ab"), Some(258));
    assert_eq!(loaded.lookup_index.token(258), Some(b"ab".as_slice()));

    for text in ["ab", "hello world", "Unicode: \u{4e2d}\u{6587} caf\u{e9}", "line one\nline two"] {
        let ids = loaded.tokenizer.encode(text);
        if text == "ab" {
            assert_eq!(ids, [258]);
        }
        assert_eq!(loaded.tokenizer.decode(&ids), text.as_bytes());
    }
}
