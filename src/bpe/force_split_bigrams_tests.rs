use super::force_split_bigrams::ForceSplitBigrams;
use super::tiktoken::Tokenizer;
use crate::token::TokenId;
use std::collections::HashMap;

#[test]
fn absent_pairs_are_the_only_split_boundaries() {
    let vocabulary = [b"z".as_slice(), b"a".as_slice(), b"b".as_slice(), b"ab".as_slice()];
    let splitter = ForceSplitBigrams::from_vocabulary(&vocabulary);

    assert_eq!(splitter.boundaries(b"zabz").collect::<Vec<_>>(), [1, 3]);
}

#[test]
fn split_miss_preserves_the_merge_inside_each_segment() {
    let mut vocabulary = (0..=u8::MAX).map(|byte| vec![byte]).collect::<Vec<_>>();
    vocabulary.push(b"ab".to_vec());
    let mut merges = HashMap::with_hasher(rustc_hash::FxBuildHasher {});
    merges.insert(
        (TokenId::from(u32::from(b'a')), TokenId::from(u32::from(b'b'))),
        TokenId::from(256),
    );
    let mut tokenizer = Tokenizer::new(merges, vocabulary, None);
    let mut ids = Vec::new();

    tokenizer.encode_with_added_tokens_flat(b"zabz", &mut ids);

    assert_eq!(ids, [u32::from(b'z'), 256, u32::from(b'z')]);
}
