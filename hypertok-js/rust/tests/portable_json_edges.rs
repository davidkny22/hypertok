use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize, PartialEq)]
struct Model {
    #[serde(rename = "type")]
    kind: String,
    vocab: HashMap<String, u32>,
}

#[derive(Debug, Deserialize, PartialEq)]
struct TokenizerFragment {
    model: Model,
}

#[test]
fn portable_json_accepts_required_valid_shapes() {
    let fragment: TokenizerFragment =
        serde_json::from_slice(br#"{"model":{"type":"BPE","vocab":{"a":0,"b":1}}}"#)
            .expect("valid typed object");
    assert_eq!(fragment.model.kind, "BPE");
    assert_eq!(fragment.model.vocab.len(), 2);

    let duplicate_map: HashMap<String, u32> =
        serde_json::from_slice(br#"{"a":0,"a":7}"#).expect("duplicate map key");
    assert_eq!(duplicate_map.get("a"), Some(&7));

    let paired_surrogate: String =
        serde_json::from_slice(br#""valid pair: \uD83D\uDE80""#).expect("paired surrogate");
    let expected = format!("valid pair: {}", char::from_u32(0x1F680).unwrap());
    assert_eq!(paired_surrogate, expected);
}

#[test]
fn portable_json_refuses_invalid_edges() {
    let duplicate_field = br#"{"model":{"type":"BPE","type":"WordPiece","vocab":{"a":0}}}"#;
    assert!(serde_json::from_slice::<TokenizerFragment>(duplicate_field).is_err());
    assert!(serde_json::from_slice::<String>(br#""lone leading: \uD83D""#).is_err());
    assert!(serde_json::from_slice::<String>(br#""lone trailing: \uDE80""#).is_err());
    assert!(serde_json::from_slice::<String>(b"\"invalid: \x80\"").is_err());
    assert!(serde_json::from_slice::<TokenizerFragment>(b"\x80{}").is_err());
    assert!(serde_json::from_slice::<String>(br#""bad escape: \x""#).is_err());
    assert!(serde_json::from_slice::<String>(br#""ok" trailing"#).is_err());

    let mut excessive_nesting = vec![b'['; 256];
    excessive_nesting.extend_from_slice(b"null");
    excessive_nesting.extend(std::iter::repeat_n(b']', 256));
    assert!(serde_json::from_slice::<serde_json::Value>(&excessive_nesting).is_err());
}
