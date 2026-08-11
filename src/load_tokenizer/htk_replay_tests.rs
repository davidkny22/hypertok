use super::{reconstruct_id_merges, reconstruct_id_pair_ranks};
use crate::token::TokenId;
use std::collections::BTreeSet;

#[cfg(feature = "opt-merge-replay-fusion")]
#[test]
fn reused_symbol_scratch_preserves_the_ordered_merge_graph() {
    let mut vocab = (0_u8..=u8::MAX).map(|byte| vec![byte]).collect::<Vec<_>>();
    vocab.push(b"ab".to_vec());
    vocab.push(b"abc".to_vec());
    vocab.push(b"abcd".to_vec());
    let base = std::array::from_fn(|byte| byte as u32);
    let specials = BTreeSet::new();

    let pair_ranks = reconstruct_id_pair_ranks(&vocab, &base, &specials, None)
        .expect("valid ordered vocabulary")
        .expect("small vocabulary supports direct pair ranks");
    let merges = reconstruct_id_merges(&vocab, &base, &specials)
        .expect("valid ordered vocabulary supports map reconstruction");

    for ((left, right), merged) in merges {
        assert_eq!(
            pair_ranks.rank(left, right),
            merged.0,
            "direct and map reconstruction disagree for ({}, {})",
            left.0,
            right.0,
        );
    }
    assert_eq!(pair_ranks.rank(TokenId(256), TokenId(b'c' as u32)), 257);
    assert_eq!(pair_ranks.rank(TokenId(257), TokenId(b'd' as u32)), 258);
}
