//! Compile-time contract for the upstream representation touched by `.htk`.

use std::collections::HashMap;

use crate::bpe::tiktoken::RankedMerges;
use crate::bpe::{ByteRemapping, TokenBytes, Tokenizer};
use crate::token::TokenId;
use rustc_hash::FxBuildHasher;

type OrdinaryMerges = HashMap<(TokenId, TokenId), TokenId, FxBuildHasher>;

const _: fn(OrdinaryMerges, Vec<Vec<u8>>, Option<ByteRemapping>) -> Tokenizer = Tokenizer::new;
#[cfg(not(hypertok_test_fault = "byte-constructor"))]
const _: fn(RankedMerges, Vec<Vec<u8>>, Option<ByteRemapping>) -> Tokenizer = Tokenizer::new_ranked;
#[cfg(hypertok_test_fault = "byte-constructor")]
const _: fn(RankedMerges, Vec<Vec<u8>>, Option<ByteRemapping>) -> Tokenizer = Tokenizer::new;

#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
#[allow(dead_code)]
fn sentencepiece_shape(model: crate::bpe::sentencepiece::SentencePieceBPE) {
    let crate::bpe::sentencepiece::SentencePieceBPE {
        merges,
        vocab,
        vocab_inv,
        byte_fallback_ids,
        added_tokens,
        norm_added_tokens,
        norm_ops,
        metaspace,
        word_split,
        raw_prepend,
        space_init,
        ascii_init,
        added_matcher,
        split_bytes,
        split_safe,
        cross_pieces,
        cross_prev,
    } = model;
    let _: RankedMerges = merges;
    let _: Vec<TokenBytes> = vocab;
    let _: HashMap<TokenBytes, TokenId, FxBuildHasher> = vocab_inv;
    let _: [Option<TokenId>; 256] = byte_fallback_ids;
    let _: Vec<crate::bpe::sentencepiece::AddedTokenSpec> = added_tokens;
    let _: Vec<crate::bpe::sentencepiece::AddedTokenSpec> = norm_added_tokens;
    let _: Vec<crate::bpe::sentencepiece::NormOp> = norm_ops;
    let _: Option<crate::bpe::sentencepiece::Metaspace> = metaspace;
    let _: crate::bpe::sentencepiece::WordSplit = word_split;
    let _ = raw_prepend;
    let _: Vec<TokenId> = space_init;
    let _: [Option<TokenId>; 128] = ascii_init;
    let _: Option<aho_corasick::AhoCorasick> = added_matcher;
    let _: [u8; crate::bpe::sentencepiece::NUM_SPLIT_BYTES] = split_bytes;
    let _: Vec<[u64; 4]> = split_safe;
    let _: Vec<(Box<[u8]>, Box<[u8]>)> = cross_pieces;
    #[cfg(not(hypertok_test_fault = "sentencepiece-shape"))]
    let _: [u64; 4] = cross_prev;
    #[cfg(hypertok_test_fault = "sentencepiece-shape")]
    let _: [u64; 5] = cross_prev;
}
