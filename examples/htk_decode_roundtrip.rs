use hypertok::load_tokenizer::htk::{HtkDecodeError, LoadedHtk, load_htk_slice};
use std::env;
use std::fs;

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    assert!(
        args.len() >= 12,
        "usage: htk_decode_roundtrip O200K_HTK LLAMA_HTK CORPUS..."
    );
    let mut o200k =
        load_htk_slice(&fs::read(&args[0]).expect("read o200k .htk")).expect("load o200k .htk");
    let mut llama =
        load_htk_slice(&fs::read(&args[1]).expect("read Llama .htk")).expect("load Llama .htk");
    let mut corpus = args[2..]
        .iter()
        .map(|path| fs::read_to_string(path).expect("read UTF-8 corpus file"))
        .collect::<Vec<_>>();
    corpus.extend(boundaries());
    assert_eq!(corpus.len(), 19, "decode corpus size changed");

    let mut bytes = 0_usize;
    let mut ids = 0_usize;
    for loaded in [&mut o200k, &mut llama] {
        for text in &corpus {
            let encoded = loaded.tokenizer.encode(text);
            let decoded = loaded.decode_text(&encoded).expect("decode encoded text");
            assert_eq!(&decoded, text, "decode round trip diverged");
            bytes += text.len();
            ids += encoded.len();
        }
    }

    assert_eq!(
        o200k.decode_text(&[u32::MAX]),
        Err(HtkDecodeError::UnknownTokenId(u32::MAX))
    );
    assert_eq!(
        llama.decode_text(&[u32::MAX]),
        Err(HtkDecodeError::UnknownTokenId(u32::MAX))
    );
    let gap = (0..o200k.tokenizer.vocab_size() as u32)
        .find(|&id| o200k.lookup_index.token(id) == Some(&[][..]))
        .expect("o200k sparse id gap");
    assert_eq!(
        o200k.decode_text(&[gap]),
        Err(HtkDecodeError::UnknownTokenId(gap))
    );
    let byte_id = o200k
        .lookup_index
        .lookup(&[0xff])
        .expect("single-byte 0xff token");
    assert_eq!(o200k.decode_text(&[byte_id]).unwrap(), "\u{fffd}");

    println!(
        "decode-native PASS: classes=2/2 cases={} bytes={bytes} ids={ids} negatives=4/4",
        corpus.len() * 2,
    );
}

fn boundaries() -> Vec<String> {
    vec![
        String::new(),
        "alpha".to_string(),
        "a".repeat(255),
        "a".repeat(256),
        "a".repeat(257),
        "alpha\0beta".to_string(),
        "\u{4e2d}\u{6587}\u{1f642}\u{7ec8}".repeat(64),
        "a".repeat(10_000),
        format!(
            "{}{} {}",
            "alpha beta gamma delta epsilon ".repeat(400),
            "a".repeat(10_000),
            "\u{7ec8}"
        ),
    ]
}
