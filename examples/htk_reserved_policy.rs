use hypertok::load_tokenizer::htk::{HtkReservedError, HtkTokenizer, load_htk_slice};
use std::env;
use std::fs;

const END_TEXT: &str = "<|endoftext|>";
const END_PROMPT: &str = "<|endofprompt|>";
const END_TEXT_ID: u32 = 199_999;
const END_PROMPT_ID: u32 = 200_018;

fn main() {
    let args = env::args().collect::<Vec<_>>();
    assert_eq!(args.len(), 2, "usage: htk_reserved_policy O200K_HTK");
    let bytes = fs::read(&args[1]).expect("read o200k .htk");
    let mut loaded = load_htk_slice(&bytes).expect("load policy tokenizer");
    let mut ordinary = match &loaded.tokenizer {
        HtkTokenizer::ByteBpe(tokenizer) => tokenizer.fork(),
        #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
        HtkTokenizer::SentencePiece(_) => panic!("expected a byte-BPE vocabulary"),
    };
    ordinary.set_added_tokens(Vec::new());
    let mut encode_with = |text: &str, specials: &[(&str, u32)]| {
        let mut ids = Vec::new();
        let mut cursor = 0;
        while cursor < text.len() {
            let next = specials
                .iter()
                .filter_map(|(token, id)| {
                    text[cursor..]
                        .find(token)
                        .map(|offset| (cursor + offset, *token, *id))
                })
                .min_by_key(|(position, _, _)| *position);
            let Some((position, token, id)) = next else {
                ordinary.encode_with_added_tokens_flat(text[cursor..].as_bytes(), &mut ids);
                break;
            };
            ordinary.encode_with_added_tokens_flat(text[cursor..position].as_bytes(), &mut ids);
            ids.push(id);
            cursor = position + token.len();
        }
        ids
    };
    let text = format!("alpha{END_TEXT}beta{END_PROMPT}gamma");

    let default = loaded
        .encode_reserved(&text, true, &[], false, &[])
        .expect("default match");
    let expected_default = encode_with(
        &text,
        &[(END_TEXT, END_TEXT_ID), (END_PROMPT, END_PROMPT_ID)],
    );
    assert_eq!(default.ids, expected_default);
    assert_eq!(default.found, [END_TEXT, END_PROMPT]);

    let end_text = vec![END_TEXT.to_string()];
    let one = loaded
        .encode_reserved(&text, false, &end_text, false, &[])
        .expect("one-token match");
    assert_eq!(one.ids, encode_with(&text, &[(END_TEXT, END_TEXT_ID)]));
    assert_eq!(one.found, [END_TEXT, END_PROMPT]);

    let literal = loaded
        .encode_reserved(&text, false, &[], false, &[])
        .expect("literal policy");
    assert_eq!(literal.ids, encode_with(&text, &[]));
    assert_eq!(literal.found, [END_TEXT, END_PROMPT]);
    assert_ne!(literal.ids, default.ids);

    for (name, expected) in [(END_TEXT, END_TEXT), (END_PROMPT, END_PROMPT)] {
        let refused = vec![name.to_string()];
        assert_eq!(
            loaded.encode_reserved(&text, true, &[], false, &refused),
            Err(HtkReservedError::RefusedToken(expected.to_string()))
        );
    }
    assert_eq!(
        loaded.encode_reserved(&text, true, &[], true, &[]),
        Err(HtkReservedError::RefusedToken(END_TEXT.to_string()))
    );
    assert_eq!(
        loaded.encode_reserved(&text, false, &end_text, false, &end_text),
        Err(HtkReservedError::RefusedToken(END_TEXT.to_string()))
    );
    let unknown = vec!["<|unknown|>".to_string()];
    assert_eq!(
        loaded.encode_reserved(&text, false, &unknown, false, &[]),
        Err(HtkReservedError::UnknownToken(unknown[0].clone()))
    );
    assert_eq!(
        loaded.encode_reserved(&text, true, &[], false, &unknown),
        Err(HtkReservedError::UnknownToken(unknown[0].clone()))
    );

    let repeated = format!("{END_PROMPT}{END_TEXT}{END_PROMPT}{END_TEXT}");
    let reported = loaded
        .encode_reserved(&repeated, false, &[], false, &[])
        .expect("repeated reporting");
    assert_eq!(reported.found, [END_PROMPT, END_TEXT]);

    println!("reserved-policy-core PASS: cases=12/12 negatives=6/6 overlap=2/2");
}
