use std::collections::BTreeMap;
use std::env;

use hypertok_converter::{JsonConversionError, convert_tokenizer_json};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

#[test]
fn valid_sentencepiece_control_converts() {
    let source = serialize(control());
    let conversion = convert_tokenizer_json(&source, Sha256::digest(&source).into())
        .expect("complete control must convert");

    assert_eq!(conversion.vocab_size, 257);
    assert_eq!(conversion.key_set_size, 0);
    assert!(!conversion.priority_present);
}

#[test]
fn behavior_fields_outside_the_schema_produce_no_conversion() {
    let mut cases = Vec::new();

    let mut root = control();
    root["future_root_behavior"] = json!(true);
    cases.push(("root", root));

    let mut model = control();
    model["model"]["future_model_behavior"] = json!(true);
    cases.push(("model", model));

    let mut added = control();
    added["added_tokens"][0]["future_added_behavior"] = json!(true);
    cases.push(("added token", added));

    let mut normalizer = control();
    normalizer["normalizer"]["future_normalizer_behavior"] = json!(true);
    cases.push(("normalizer", normalizer));

    let mut decoder = control();
    decoder["decoder"]["future_decoder_behavior"] = json!(true);
    cases.push(("decoder", decoder));

    let mut postprocessor = control();
    postprocessor["post_processor"]["future_post_behavior"] = json!(true);
    cases.push(("postprocessor", postprocessor));

    let mut template = control();
    template["post_processor"]["single"][1]["Sequence"]["future_template_behavior"] = json!(true);
    cases.push(("template piece", template));

    let mut post_special = control();
    post_special["post_processor"]["special_tokens"]["<unk>"]["future_special_behavior"] =
        json!(true);
    cases.push(("postprocessor special", post_special));

    let mut pattern = control();
    pattern["normalizer"] = json!({
        "type": "Replace",
        "pattern": {"FuturePattern": "a"},
        "content": "b"
    });
    cases.push(("string pattern", pattern));

    for (name, value) in &cases {
        assert_json_refusal(name, value);
    }
    eprintln!("unknown behavior-field refusals={}", cases.len());
}

#[test]
fn known_unrepresentable_behavior_produces_no_conversion() {
    let mut cases = Vec::new();

    let mut truncation = control();
    truncation["truncation"] = json!({"max_length": 4});
    cases.push(("truncation", truncation));

    let mut pretokenizer = control();
    pretokenizer["pre_tokenizer"] = json!({"type": "Metaspace"});
    cases.push(("pretokenizer", pretokenizer));

    let mut dropout = control();
    dropout["model"]["dropout"] = json!(0.1);
    cases.push(("dropout", dropout));

    let mut affix = control();
    affix["model"]["continuing_subword_prefix"] = json!("##");
    cases.push(("subword affix", affix));

    let mut ordinary_added = control();
    ordinary_added["added_tokens"][0]["special"] = json!(false);
    cases.push(("ordinary added token", ordinary_added));

    for (name, value) in &cases {
        let source = serialize(value.clone());
        assert!(
            convert_tokenizer_json(&source, Sha256::digest(&source).into()).is_err(),
            "{name} unexpectedly produced a conversion"
        );
    }
    eprintln!("known unrepresentable refusals={}", cases.len());
}

#[test]
fn per_token_priority_assumption_has_a_detectable_counterexample() {
    let merges = [
        Merge::new("a", "b", "ab"),
        Merge::new("b", "c", "bc"),
        Merge::new("a", "bc", "abc"),
        Merge::new("c", "d", "cd"),
        Merge::new("ab", "c", "abc"),
    ];
    let input = ["a", "b", "c", "d"];

    let pair_output = if fault() == Some("priority-oracle") {
        token_ranked(&input, &merges)
    } else {
        pair_ranked(&input, &merges)
    };
    let token_output = token_ranked(&input, &merges);

    assert_eq!(pair_output, ["ab", "cd"]);
    assert_eq!(token_output, ["abc", "d"]);
    assert_ne!(pair_output, token_output);
    eprintln!("priority assumption violations=1");
}

fn assert_json_refusal(name: &str, value: &Value) {
    let mut value = value.clone();
    if fault() == Some("accept-template-piece") && name == "template piece" {
        value["post_processor"]["single"][1]["Sequence"]
            .as_object_mut()
            .expect("template piece object")
            .remove("future_template_behavior");
    }
    let source = serialize(value);
    assert!(
        matches!(
            convert_tokenizer_json(&source, Sha256::digest(&source).into()),
            Err(JsonConversionError::Json(_))
        ),
        "{name} unexpectedly produced a conversion"
    );
}

fn fault() -> Option<&'static str> {
    match env::var("HYPERTOK_ASSUMPTION_FAULT").as_deref() {
        Err(env::VarError::NotPresent) | Ok("") => None,
        Ok("accept-template-piece") => Some("accept-template-piece"),
        Ok("priority-oracle") => Some("priority-oracle"),
        Ok(value) => panic!("unknown assumption fault {value}"),
        Err(error) => panic!("invalid assumption fault: {error}"),
    }
}

fn serialize(value: Value) -> Vec<u8> {
    serde_json::to_vec(&value).expect("fixture serializes")
}

fn control() -> Value {
    let mut vocab = Map::new();
    for byte in 0_u16..=u8::MAX as u16 {
        vocab.insert(format!("<0x{byte:02X}>"), json!(byte));
    }
    vocab.insert("<unk>".to_owned(), json!(256));

    json!({
        "version": "1.0",
        "truncation": null,
        "padding": null,
        "added_tokens": [{
            "id": 256,
            "content": "<unk>",
            "single_word": false,
            "lstrip": false,
            "rstrip": false,
            "normalized": false,
            "special": true
        }],
        "normalizer": {"type": "Sequence", "normalizers": []},
        "pre_tokenizer": null,
        "post_processor": {
            "type": "TemplateProcessing",
            "single": [
                {"SpecialToken": {"id": "<unk>", "type_id": 0}},
                {"Sequence": {"id": "A", "type_id": 0}}
            ],
            "pair": [
                {"SpecialToken": {"id": "<unk>", "type_id": 0}},
                {"Sequence": {"id": "A", "type_id": 0}},
                {"SpecialToken": {"id": "<unk>", "type_id": 1}},
                {"Sequence": {"id": "B", "type_id": 1}}
            ],
            "special_tokens": {
                "<unk>": {"id": "<unk>", "ids": [256], "tokens": ["<unk>"]}
            }
        },
        "decoder": {"type": "Sequence", "decoders": []},
        "model": {
            "type": "BPE",
            "dropout": null,
            "unk_token": "<unk>",
            "continuing_subword_prefix": null,
            "end_of_word_suffix": null,
            "fuse_unk": true,
            "byte_fallback": true,
            "vocab": vocab,
            "merges": []
        }
    })
}

#[derive(Clone, Copy)]
struct Merge {
    left: &'static str,
    right: &'static str,
    product: &'static str,
}

impl Merge {
    const fn new(left: &'static str, right: &'static str, product: &'static str) -> Self {
        Self {
            left,
            right,
            product,
        }
    }
}

fn pair_ranked(input: &[&str], merges: &[Merge]) -> Vec<String> {
    merge_by(input, merges, |left, right, _product| {
        merges
            .iter()
            .position(|merge| merge.left == left && merge.right == right)
    })
}

fn token_ranked(input: &[&str], merges: &[Merge]) -> Vec<String> {
    let mut priorities = BTreeMap::new();
    for (rank, merge) in merges.iter().enumerate() {
        priorities.entry(merge.product).or_insert(rank);
    }
    merge_by(input, merges, |_left, _right, product| {
        priorities.get(product).copied()
    })
}

fn merge_by(
    input: &[&str],
    merges: &[Merge],
    rank: impl Fn(&str, &str, &str) -> Option<usize>,
) -> Vec<String> {
    let mut symbols: Vec<_> = input.iter().map(|symbol| (*symbol).to_owned()).collect();
    loop {
        let best = symbols
            .windows(2)
            .enumerate()
            .filter_map(|(index, pair)| {
                let product = merges
                    .iter()
                    .find(|merge| merge.left == pair[0] && merge.right == pair[1])?
                    .product;
                rank(&pair[0], &pair[1], product).map(|rank| (rank, index, product))
            })
            .min_by_key(|(rank, index, _product)| (*rank, *index));
        let Some((_rank, index, product)) = best else {
            return symbols;
        };
        symbols.splice(index..index + 2, [product.to_owned()]);
    }
}
