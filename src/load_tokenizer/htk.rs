//! Loader for validated `.htk` vocabulary images.
//!
//! This module is the only adapter between the public file format and the
//! tokenizer core. Existing JSON and rank-file loaders do not depend on it.

pub use super::htk_index::{HtkIndexError, HtkLookupIndex};
use super::htk_reserved::{HtkReservedCatalog, HtkReservedDefinition, HtkReservedPolicy};
pub use super::htk_reserved::{HtkReservedEncoding, HtkReservedError};
#[cfg(feature = "opt-prebuilt-pair-ranks")]
use super::htk_worker::{HtkWorkerModel, PrebuiltPairEntries};
#[cfg(feature = "opt-fused-pair-ranks")]
use crate::bpe::PairRankTable;
use crate::bpe::TokenBytes;
#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
use crate::bpe::sentencepiece::{
    AddedTokenSpec, Metaspace, NormOp, PrependScheme, SentencePieceBPE, WordSplit,
};
use crate::bpe::tiktoken::{AddedTokenDef, RankedMerges};
use crate::bpe::{self, ByteRemapping, MergeScratch, Tokenizer, ranked_merge_key};
use crate::pretokenize::PretokenizerType;
use crate::token::TokenId;
use hypertok_format::{
    BYTE_BPE_EXHAUSTIVE_SPLITS_FLAG, BYTE_BPE_IGNORE_MERGES_FLAG, DecoderStepKind, NamedPattern,
    NormStepKind, PostPosition, PretokStepKind, ReadError, SectionId, StructuralClass,
    ValidatedFile, decode_u32,
};
use rustc_hash::FxBuildHasher;
use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::sync::Arc;

#[cfg(feature = "opt-prebuilt-pair-ranks")]
pub const PREBUILT_PAIR_RANKS_SECTION_ID: u32 = 1025;

#[cfg(test)]
#[path = "htk_replay_tests.rs"]
mod replay_tests;

/// A tokenizer reconstructed from a validated `.htk` image.
pub enum HtkTokenizer {
    ByteBpe(Box<Tokenizer>),
    #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
    SentencePiece(Box<SentencePieceBPE>),
}

impl HtkTokenizer {
    /// Encode ordinary text without applying the model's exposed `POST`
    /// markers. Reserved tokens are matched by the loaded core.
    pub fn encode(&mut self, text: &str) -> Vec<u32> {
        match self {
            Self::ByteBpe(tokenizer) => {
                let mut output = Vec::new();
                tokenizer.encode_with_added_tokens_flat(text.as_bytes(), &mut output);
                output
            }
            #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
            Self::SentencePiece(tokenizer) => tokenizer
                .encode_raw(text)
                .into_iter()
                .map(u32::from)
                .collect(),
        }
    }

    /// Decode token ids through the reconstructed vocabulary.
    pub fn decode(&self, ids: &[u32]) -> Vec<u8> {
        let ids: Vec<TokenId> = ids.iter().copied().map(TokenId::from).collect();
        match self {
            Self::ByteBpe(tokenizer) => tokenizer.decode(&ids).collect(),
            #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
            Self::SentencePiece(tokenizer) => tokenizer.decode(&ids),
        }
    }

    pub fn vocab_size(&self) -> usize {
        match self {
            Self::ByteBpe(tokenizer) => tokenizer.vocab_size(),
            #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
            Self::SentencePiece(tokenizer) => tokenizer.vocab_size(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HtkDecodeError {
    UnknownTokenId(u32),
}

impl fmt::Display for HtkDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownTokenId(id) => write!(formatter, "unknown token id {id}"),
        }
    }
}

impl std::error::Error for HtkDecodeError {}

/// Loader metadata that is deliberately not folded into ordinary encoding.
pub struct LoadedHtk {
    pub tokenizer: HtkTokenizer,
    pub lookup_index: HtkLookupIndex,
    pub prepend_ids: Vec<u32>,
    pub append_ids: Vec<u32>,
    pub omega: u32,
    pub digest: [u8; 32],
    pub worker_transfer_pretokenizer: Option<PretokenizerType>,
    pub worker_unsupported_patterns: Vec<Box<[u8]>>,
    pub(crate) reserved_catalog: HtkReservedCatalog,
    pub(crate) reserved_byte_cache: HashMap<Vec<usize>, Box<Tokenizer>, FxBuildHasher>,
}

impl LoadedHtk {
    pub fn decode_text(&self, ids: &[u32]) -> Result<String, HtkDecodeError> {
        for &id in ids {
            if self
                .lookup_index
                .token(id)
                .is_none_or(|bytes| bytes.is_empty())
            {
                return Err(HtkDecodeError::UnknownTokenId(id));
            }
        }
        Ok(String::from_utf8_lossy(&self.tokenizer.decode(ids)).into_owned())
    }

    pub fn encode_reserved(
        &mut self,
        input: &str,
        match_all: bool,
        match_names: &[String],
        refuse_all: bool,
        refuse_names: &[String],
    ) -> Result<HtkReservedEncoding, HtkReservedError> {
        let policy = HtkReservedPolicy {
            match_all,
            match_names,
            refuse_all,
            refuse_names,
        };
        match &mut self.tokenizer {
            HtkTokenizer::ByteBpe(tokenizer) => self.reserved_catalog.encode_byte_bpe(
                tokenizer,
                &mut self.reserved_byte_cache,
                input.as_bytes(),
                &policy,
            ),
            #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
            HtkTokenizer::SentencePiece(tokenizer) => self
                .reserved_catalog
                .encode_sentencepiece(tokenizer, input, &policy),
        }
    }
}

#[derive(Debug)]
pub enum HtkLoadError {
    Format(ReadError),
    Index(HtkIndexError),
    Unsupported(&'static str),
    InvalidModel(&'static str),
}

impl fmt::Display for HtkLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Format(error) => write!(formatter, "invalid .htk file: {error}"),
            Self::Index(error) => write!(formatter, "invalid .htk lookup index: {error}"),
            Self::Unsupported(detail) => write!(formatter, "unsupported .htk behavior: {detail}"),
            Self::InvalidModel(detail) => write!(formatter, "invalid .htk model: {detail}"),
        }
    }
}

impl std::error::Error for HtkLoadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Format(error) => Some(error),
            Self::Index(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ReadError> for HtkLoadError {
    fn from(error: ReadError) -> Self {
        Self::Format(error)
    }
}

impl From<HtkIndexError> for HtkLoadError {
    fn from(error: HtkIndexError) -> Self {
        Self::Index(error)
    }
}

/// Validate and reconstruct a tokenizer from in-memory `.htk` bytes.
pub fn load_htk_slice(bytes: &[u8]) -> Result<LoadedHtk, HtkLoadError> {
    #[cfg(feature = "opt-digest-gated-validation")]
    crate::cold_construction::measure("trusted-digest-check", || {
        std::hint::black_box(super::htk_digest_gate::digest(bytes));
    });
    let file = crate::cold_construction::measure("file-validation", || ValidatedFile::read(bytes))?;
    if file.header().flags & !(BYTE_BPE_IGNORE_MERGES_FLAG | BYTE_BPE_EXHAUSTIVE_SPLITS_FLAG) != 0 {
        return Err(HtkLoadError::InvalidModel("unknown header flags"));
    }
    let (specials, reserved_catalog, special_ids, byte_fallback_ids, post, priorities) =
        crate::cold_construction::measure("loader-metadata", || {
            let specials = read_specials(&file)?;
            let reserved_catalog = HtkReservedCatalog::new(
                specials
                    .iter()
                    .map(|special| HtkReservedDefinition {
                        content: Arc::from(special.bytes.as_slice()),
                        id: TokenId::from(special.id),
                        lstrip: special.flags & 1 != 0,
                        rstrip: special.flags & 2 != 0,
                        normalized: special.flags & 8 != 0,
                    })
                    .collect(),
            );
            let special_ids = specials.iter().map(|special| special.id).collect();
            let byte_fallback_ids =
                if file.header().structural_class == StructuralClass::SentencePieceBpe {
                    read_byte_fallback(&file).into_iter().collect()
                } else {
                    BTreeSet::new()
                };
            let post = read_post(&file);
            let priorities = read_priorities(&file);
            Ok::<_, HtkLoadError>((
                specials,
                reserved_catalog,
                special_ids,
                byte_fallback_ids,
                post,
                priorities,
            ))
        })?;
    #[cfg(feature = "opt-prebuilt-pair-ranks")]
    let prebuilt_pair_ranks = file
        .section(PREBUILT_PAIR_RANKS_SECTION_ID)
        .map(|section| {
            PrebuiltPairEntries::from_bytes(section, file.header().vocab_size)
                .map_err(|_| HtkLoadError::InvalidModel("invalid prebuilt pair-rank image"))
        })
        .transpose()?;
    let lookup_index = crate::cold_construction::measure("lookup-index", || {
        HtkLookupIndex::build(&file, &special_ids, &byte_fallback_ids)
    })?;

    let tokenizer = match file.header().structural_class {
        StructuralClass::ByteBpe => {
            #[cfg(feature = "opt-resident-diet")]
            let vocab = crate::cold_construction::measure("vocabulary-materialization", || {
                lookup_index.token_views()
            });
            #[cfg(not(feature = "opt-resident-diet"))]
            let vocab = crate::cold_construction::measure("vocabulary-materialization", || {
                file.tokens().map(|(_, token)| token.to_vec()).collect()
            });
            HtkTokenizer::ByteBpe(Box::new(build_byte_bpe(
                &file,
                vocab,
                &specials,
                priorities.as_deref(),
                #[cfg(feature = "opt-prebuilt-pair-ranks")]
                prebuilt_pair_ranks,
            )?))
        }
        StructuralClass::SentencePieceBpe => {
            #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
            {
                #[cfg(feature = "opt-resident-diet")]
                let vocab = crate::cold_construction::measure("vocabulary-materialization", || {
                    lookup_index.token_views()
                });
                #[cfg(not(feature = "opt-resident-diet"))]
                let vocab = crate::cold_construction::measure("vocabulary-materialization", || {
                    file.tokens().map(|(_, token)| token.to_vec()).collect()
                });
                HtkTokenizer::SentencePiece(Box::new(build_sentencepiece(
                    &file,
                    vocab,
                    &specials,
                    priorities.as_deref(),
                )?))
            }
            #[cfg(not(any(feature = "sentencepiece", feature = "sentencepiece-core")))]
            {
                return Err(HtkLoadError::Unsupported(
                    "sentencepiece support is not enabled",
                ));
            }
        }
    };
    let worker_transfer_pretokenizer = match &tokenizer {
        HtkTokenizer::ByteBpe(tokenizer)
            if priorities.is_none() && worker_transfer_pipeline_supported(&file) =>
        {
            Some(tokenizer.pretokenizer_type())
        }
        _ => None,
    };
    let worker_unsupported_patterns = specials
        .iter()
        .filter(|special| !special.bytes.is_empty())
        .map(|special| special.bytes.clone().into_boxed_slice())
        .collect();
    let mut prepend_ids = Vec::new();
    let mut append_ids = Vec::new();
    for (position, id) in post {
        match position {
            PostPosition::Prepend => prepend_ids.push(id),
            PostPosition::Append => append_ids.push(id),
        }
    }
    Ok(LoadedHtk {
        tokenizer,
        lookup_index,
        prepend_ids,
        append_ids,
        omega: file.header().omega,
        digest: file.header().digest,
        worker_transfer_pretokenizer,
        worker_unsupported_patterns,
        reserved_catalog,
        reserved_byte_cache: HashMap::with_hasher(FxBuildHasher),
    })
}

fn worker_transfer_pipeline_supported(file: &ValidatedFile<'_>) -> bool {
    if file.header().flags & 1 != 0 {
        return false;
    }
    if let Some(norm) = file.section(SectionId::Norm.value()) {
        let mut cursor = 0;
        if read_u32_at(norm, &mut cursor) != 0 {
            return false;
        }
    }
    let pretok = file
        .section(SectionId::Pretok.value())
        .expect("validated PRETOK");
    let mut cursor = 0;
    let count = read_u32_at(pretok, &mut cursor);
    for _ in 0..count {
        let kind = read_byte_at(pretok, &mut cursor);
        if kind == PretokStepKind::NamedPattern.value() {
            read_u32_at(pretok, &mut cursor);
        } else if kind == PretokStepKind::ByteLevel.value() {
            if read_byte_at(pretok, &mut cursor) & 1 != 0 {
                return false;
            }
        } else {
            return false;
        }
    }
    true
}

#[cfg(feature = "opt-resident-diet")]
type ByteVocab = Vec<TokenBytes>;
#[cfg(not(feature = "opt-resident-diet"))]
type ByteVocab = Vec<Vec<u8>>;

fn build_byte_bpe(
    file: &ValidatedFile<'_>,
    vocab: ByteVocab,
    specials: &[Special],
    priorities: Option<&[u32]>,
    #[cfg(feature = "opt-prebuilt-pair-ranks")] prebuilt_pair_ranks: Option<PrebuiltPairEntries>,
) -> Result<Tokenizer, HtkLoadError> {
    let base = read_byte_base(file);
    for (byte, &id) in base.iter().enumerate() {
        if vocab[id as usize].as_ref() != [byte as u8] {
            return Err(HtkLoadError::InvalidModel(
                "BASE id does not denote its indexed byte",
            ));
        }
    }
    let special_ids: BTreeSet<u32> = specials.iter().map(|special| special.id).collect();
    validate_key_set(&vocab, &special_ids, &BTreeSet::new())?;
    if file.header().flags & BYTE_BPE_EXHAUSTIVE_SPLITS_FLAG != 0 && priorities.is_none() {
        return Err(HtkLoadError::InvalidModel(
            "exhaustive split reconstruction requires PRIORITY",
        ));
    }
    let mut tokenizer = if let Some(priorities) = priorities {
        let mut non_products = special_ids.clone();
        non_products.extend(base);
        if non_products.iter().any(|id| priorities[*id as usize] != 0) {
            return Err(HtkLoadError::InvalidModel(
                "initial or special token has merge priority",
            ));
        }
        let merges = crate::cold_construction::measure("merge-replay", || {
            if file.header().flags & BYTE_BPE_EXHAUSTIVE_SPLITS_FLAG != 0 {
                reconstruct_exhaustive_ranked_merges(
                    &vocab,
                    priorities,
                    &non_products,
                    &special_ids,
                )
            } else {
                reconstruct_ranked_merges(&vocab, priorities, &non_products, |token| {
                    token
                        .iter()
                        .map(|byte| TokenId::from(base[*byte as usize]))
                        .collect()
                })
            }
        })?;
        let remapping = ByteRemapping::from_byte_vocab(&vocab)
            .map_err(|_| HtkLoadError::InvalidModel("incomplete byte BASE"))?;
        #[cfg(feature = "opt-resident-diet")]
        {
            Tokenizer::new_ranked_token_views(merges, vocab, remapping)
        }
        #[cfg(not(feature = "opt-resident-diet"))]
        {
            Tokenizer::new_ranked(merges, vocab, remapping)
        }
    } else {
        let remapping = ByteRemapping::from_byte_vocab(&vocab)
            .map_err(|_| HtkLoadError::InvalidModel("incomplete byte BASE"))?;
        #[cfg(feature = "opt-fused-pair-ranks")]
        {
            #[cfg(feature = "opt-prebuilt-pair-ranks")]
            let pair_ranks = match prebuilt_pair_ranks {
                Some(prebuilt) => Some(crate::cold_construction::measure(
                    "prebuilt-pair-validation",
                    || {
                        hydrate_prebuilt_pair_ranks(
                            prebuilt,
                            &vocab,
                            &base,
                            &special_ids,
                            remapping.as_ref(),
                        )
                    },
                )?),
                None => crate::cold_construction::measure("merge-replay", || {
                    reconstruct_id_pair_ranks(&vocab, &base, &special_ids, remapping.as_ref())
                })?,
            };
            #[cfg(not(feature = "opt-prebuilt-pair-ranks"))]
            let pair_ranks = crate::cold_construction::measure("merge-replay", || {
                reconstruct_id_pair_ranks(&vocab, &base, &special_ids, remapping.as_ref())
            })?;
            match pair_ranks {
                Some(pair_ranks) => {
                    #[cfg(feature = "opt-resident-diet")]
                    {
                        Tokenizer::new_pair_ranks_token_views(pair_ranks, vocab, remapping)
                    }
                    #[cfg(not(feature = "opt-resident-diet"))]
                    {
                        Tokenizer::new_pair_ranks(pair_ranks, vocab, remapping)
                    }
                }
                None => {
                    let merges =
                        crate::cold_construction::measure("merge-replay-fallback", || {
                            reconstruct_id_merges(&vocab, &base, &special_ids)
                        })?;
                    #[cfg(feature = "opt-resident-diet")]
                    {
                        Tokenizer::new_token_views(merges, vocab, remapping)
                    }
                    #[cfg(not(feature = "opt-resident-diet"))]
                    {
                        Tokenizer::new(merges, vocab, remapping)
                    }
                }
            }
        }
        #[cfg(not(feature = "opt-fused-pair-ranks"))]
        {
            let merges = crate::cold_construction::measure("merge-replay", || {
                reconstruct_id_merges(&vocab, &base, &special_ids)
            })?;
            #[cfg(feature = "opt-resident-diet")]
            {
                Tokenizer::new_token_views(merges, vocab, remapping)
            }
            #[cfg(not(feature = "opt-resident-diet"))]
            {
                Tokenizer::new(merges, vocab, remapping)
            }
        }
    };
    crate::cold_construction::measure("pipeline-configuration", || {
        configure_byte_pipeline(file, &mut tokenizer)?;
        if specials.iter().any(|special| special.flags & 0b0100 != 0) {
            return Err(HtkLoadError::Unsupported(
                "single-word byte-BPE special tokens",
            ));
        }
        if !byte_normalizer_is_identity(file)
            && specials.iter().any(|special| special.flags & 0b1000 != 0)
        {
            return Err(HtkLoadError::Unsupported(
                "normalized byte-BPE special tokens with normalization",
            ));
        }
        tokenizer.set_added_tokens(
            specials
                .iter()
                .map(|special| AddedTokenDef {
                    content: Arc::from(special.bytes.as_slice()),
                    id: TokenId::from(special.id),
                    lstrip: special.flags & 1 != 0,
                    rstrip: special.flags & 2 != 0,
                })
                .collect(),
        );
        Ok::<_, HtkLoadError>(())
    })?;
    #[cfg(feature = "opt-resident-diet")]
    tokenizer.discard_redundant_id_merges();
    Ok(tokenizer)
}

#[cfg(feature = "opt-prebuilt-pair-ranks")]
pub fn build_prebuilt_pair_image(bytes: &[u8]) -> Result<Vec<u8>, HtkLoadError> {
    let loaded = load_htk_slice(bytes)?;
    let pretokenizer = loaded.worker_transfer_pretokenizer.ok_or(HtkLoadError::Unsupported(
        "prebuilt pair ranks require a worker-compatible byte-BPE vocabulary",
    ))?;
    let model = HtkWorkerModel::new(
        loaded.lookup_index,
        pretokenizer,
        loaded.omega,
        loaded.digest,
    )
    .map_err(|_| HtkLoadError::InvalidModel("could not build prebuilt pair ranks"))?;
    model
        .to_prebuilt_pair_bytes()
        .map_err(|_| HtkLoadError::InvalidModel("could not serialize prebuilt pair ranks"))
}

#[cfg(feature = "opt-prebuilt-pair-ranks")]
fn hydrate_prebuilt_pair_ranks<T: AsRef<[u8]>>(
    prebuilt: PrebuiltPairEntries,
    vocab: &[T],
    base: &[u32; 256],
    special_ids: &BTreeSet<u32>,
    byte_remapping: Option<&ByteRemapping>,
) -> Result<PairRankTable, HtkLoadError> {
    let entries = prebuilt.into_entries();
    let pair_ranks = PairRankTable::from_packed_entries(&entries, byte_remapping, vocab.len())
        .map_err(HtkLoadError::InvalidModel)?;
    let mut products = vec![false; vocab.len()];
    let mut base_ids = vec![false; vocab.len()];
    for &id in base {
        base_ids[id as usize] = true;
    }
    for (left, right, merged) in pair_ranks.entries() {
        let left_id = left.0 as usize;
        let right_id = right.0 as usize;
        let merged_id = merged.0 as usize;
        if merged_id >= vocab.len()
            || products[merged_id]
            || base_ids[merged_id]
            || special_ids.contains(&merged.0)
            || left_id >= merged_id
            || right_id >= merged_id
            || special_ids.contains(&left.0)
            || special_ids.contains(&right.0)
            || pair_ranks.rank(left, right) != merged.0
        {
            return Err(HtkLoadError::InvalidModel(
                "prebuilt pair rank has invalid token identities",
            ));
        }
        let left_bytes = vocab[left_id].as_ref();
        let right_bytes = vocab[right_id].as_ref();
        let merged_bytes = vocab[merged_id].as_ref();
        if merged_bytes.len() != left_bytes.len() + right_bytes.len()
            || !merged_bytes.starts_with(left_bytes)
            || !merged_bytes.ends_with(right_bytes)
        {
            return Err(HtkLoadError::InvalidModel(
                "prebuilt pair rank does not match token bytes",
            ));
        }
        products[merged_id] = true;
    }
    for (id, token) in vocab.iter().enumerate() {
        let expected = token.as_ref().len() >= 2 && !special_ids.contains(&(id as u32));
        if products[id] != expected {
            return Err(HtkLoadError::InvalidModel(
                "prebuilt pair ranks do not cover the vocabulary",
            ));
        }
    }
    Ok(pair_ranks)
}

#[cfg(feature = "opt-fused-pair-ranks")]
fn reconstruct_id_pair_ranks<T: AsRef<[u8]>>(
    vocab: &[T],
    base: &[u32; 256],
    specials: &BTreeSet<u32>,
    byte_remapping: Option<&ByteRemapping>,
) -> Result<Option<PairRankTable>, HtkLoadError> {
    let merge_count = vocab
        .iter()
        .enumerate()
        .filter(|(id, token)| token.as_ref().len() >= 2 && !specials.contains(&(*id as u32)))
        .count();
    let Some(mut pair_ranks) =
        PairRankTable::with_capacity(byte_remapping, vocab.len(), merge_count)
    else {
        return Ok(None);
    };
    let mut scratch = MergeScratch::default();
    #[cfg(feature = "opt-merge-replay-fusion")]
    let mut replay_symbols = Vec::new();
    for (id, token) in vocab.iter().enumerate() {
        let token = token.as_ref();
        let id = id as u32;
        if token.len() < 2 || specials.contains(&id) {
            continue;
        }
        #[cfg(feature = "opt-merge-replay-fusion")]
        let symbols = {
            replay_symbols.clear();
            replay_symbols.extend(token.iter().map(|byte| TokenId::from(base[*byte as usize])));
            &mut replay_symbols
        };
        #[cfg(not(feature = "opt-merge-replay-fusion"))]
        let symbols = &mut token
            .iter()
            .map(|byte| TokenId::from(base[*byte as usize]))
            .collect::<Vec<_>>();
        bpe::bpe_merge_symbols_by_rank(
            &|left, right| pair_ranks.rank(left, right),
            symbols,
            &mut scratch,
        );
        if symbols.len() != 2 {
            return Err(HtkLoadError::InvalidModel(
                "token does not reconstruct from one final merge",
            ));
        }
        if pair_ranks.rank(symbols[0], symbols[1]) != u32::MAX {
            return Err(HtkLoadError::InvalidModel("duplicate merge pair"));
        }
        if !pair_ranks.insert(symbols[0], symbols[1], TokenId::from(id)) {
            return Ok(None);
        }
    }
    Ok(Some(pair_ranks))
}

fn byte_normalizer_is_identity(file: &ValidatedFile<'_>) -> bool {
    file.section(SectionId::Norm.value())
        .is_none_or(|section| read_u32(&section[..4]) == 0)
}

fn reconstruct_id_merges<T: AsRef<[u8]>>(
    vocab: &[T],
    base: &[u32; 256],
    specials: &BTreeSet<u32>,
) -> Result<HashMap<(TokenId, TokenId), TokenId, FxBuildHasher>, HtkLoadError> {
    let mut merges = HashMap::with_hasher(FxBuildHasher);
    let mut scratch = MergeScratch::default();
    for (id, token) in vocab.iter().enumerate() {
        let token = token.as_ref();
        let id = id as u32;
        if token.len() < 2 || specials.contains(&id) {
            continue;
        }
        let mut symbols: Vec<TokenId> = token
            .iter()
            .map(|byte| TokenId::from(base[*byte as usize]))
            .collect();
        bpe::bpe_merge_symbols_by_rank(
            &|left, right| {
                merges
                    .get(&(left, right))
                    .map_or(u32::MAX, |merged: &TokenId| merged.0)
            },
            &mut symbols,
            &mut scratch,
        );
        if symbols.len() != 2 {
            return Err(HtkLoadError::InvalidModel(
                "token does not reconstruct from one final merge",
            ));
        }
        if merges
            .insert((symbols[0], symbols[1]), TokenId::from(id))
            .is_some()
        {
            return Err(HtkLoadError::InvalidModel("duplicate merge pair"));
        }
    }
    Ok(merges)
}

fn reconstruct_ranked_merges<T: AsRef<[u8]>, F>(
    vocab: &[T],
    priorities: &[u32],
    non_products: &BTreeSet<u32>,
    mut initial_symbols: F,
) -> Result<RankedMerges, HtkLoadError>
where
    F: FnMut(&[u8]) -> Vec<TokenId>,
{
    let mut products: Vec<u32> = (0..vocab.len() as u32)
        .filter(|id| {
            !vocab[*id as usize].as_ref().is_empty()
                && !non_products.contains(id)
                && priorities[*id as usize] != 0
        })
        .collect();
    products.sort_unstable_by_key(|id| (priorities[*id as usize], *id));
    let mut merges = RankedMerges::with_hasher(FxBuildHasher);
    for id in products {
        let mut symbols = initial_symbols(vocab[id as usize].as_ref());
        bpe::bpe_merge_symbols_ranked(&merges, &mut symbols);
        if symbols.len() != 2 {
            return Err(HtkLoadError::InvalidModel(
                "priority token does not reconstruct from one final merge",
            ));
        }
        if merges
            .insert(
                ranked_merge_key(symbols[0], symbols[1]),
                (TokenId::from(id), priorities[id as usize]),
            )
            .is_some()
        {
            return Err(HtkLoadError::InvalidModel("duplicate ranked merge pair"));
        }
    }
    Ok(merges)
}

fn reconstruct_exhaustive_ranked_merges<T: AsRef<[u8]>>(
    vocab: &[T],
    priorities: &[u32],
    non_products: &BTreeSet<u32>,
    lookup_excluded: &BTreeSet<u32>,
) -> Result<RankedMerges, HtkLoadError> {
    let by_token: HashMap<&[u8], TokenId, FxBuildHasher> = vocab
        .iter()
        .enumerate()
        .filter(|(id, token)| {
            !token.as_ref().is_empty() && !lookup_excluded.contains(&(*id as u32))
        })
        .map(|(id, token)| (token.as_ref(), TokenId::from(id as u32)))
        .collect();
    let mut merges = RankedMerges::with_hasher(FxBuildHasher);
    for (id, token) in vocab.iter().enumerate() {
        let token = token.as_ref();
        let id = id as u32;
        if token.is_empty() || non_products.contains(&id) || priorities[id as usize] == 0 {
            continue;
        }
        let mut inserted = 0_usize;
        for split in 1..token.len() {
            let Some(&left) = by_token.get(&token[..split]) else {
                continue;
            };
            let Some(&right) = by_token.get(&token[split..]) else {
                continue;
            };
            if merges
                .insert(
                    ranked_merge_key(left, right),
                    (TokenId::from(id), priorities[id as usize]),
                )
                .is_some()
            {
                return Err(HtkLoadError::InvalidModel(
                    "duplicate exhaustive ranked merge pair",
                ));
            }
            inserted += 1;
        }
        if inserted == 0 {
            return Err(HtkLoadError::InvalidModel(
                "priority token has no vocabulary-valid split",
            ));
        }
    }
    Ok(merges)
}

#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
fn build_sentencepiece(
    file: &ValidatedFile<'_>,
    vocab: ByteVocab,
    specials: &[Special],
    priorities: Option<&[u32]>,
) -> Result<SentencePieceBPE, HtkLoadError> {
    let base = read_sentencepiece_base(file);
    for (&codepoint, &id) in &base {
        let character = char::from_u32(codepoint).ok_or(HtkLoadError::InvalidModel(
            "BASE contains a non-scalar codepoint",
        ))?;
        let mut encoded = [0_u8; 4];
        if &vocab[id as usize][..] != character.encode_utf8(&mut encoded).as_bytes() {
            return Err(HtkLoadError::InvalidModel(
                "BASE id does not denote its codepoint",
            ));
        }
    }
    let byte_fallback_ids = read_byte_fallback(file);
    for (byte, &id) in byte_fallback_ids.iter().enumerate() {
        if vocab[id as usize].as_ref() != [byte as u8] {
            return Err(HtkLoadError::InvalidModel(
                "BYTEFALL id does not denote its indexed byte",
            ));
        }
    }
    let byte_fallback: BTreeSet<u32> = byte_fallback_ids.iter().copied().collect();
    let special_ids: BTreeSet<u32> = specials.iter().map(|special| special.id).collect();
    validate_key_set(&vocab, &special_ids, &byte_fallback)?;
    if vocab.iter().enumerate().any(|(id, token)| {
        !token.is_empty()
            && !byte_fallback.contains(&(id as u32))
            && std::str::from_utf8(token.as_ref()).is_err()
    }) {
        return Err(HtkLoadError::InvalidModel(
            "sentencepiece vocabulary contains non-UTF-8 token bytes",
        ));
    }

    let mut non_products = special_ids.clone();
    non_products.extend(byte_fallback.iter().copied());
    non_products.extend(base.values().copied());
    let exhaustive_splits = file.header().flags & BYTE_BPE_EXHAUSTIVE_SPLITS_FLAG != 0;
    if exhaustive_splits && priorities.is_none() {
        return Err(HtkLoadError::InvalidModel(
            "exhaustive split reconstruction requires PRIORITY",
        ));
    }
    let default_priorities;
    let priorities = match priorities {
        Some(priorities) => {
            if non_products.iter().any(|id| priorities[*id as usize] != 0) {
                return Err(HtkLoadError::InvalidModel(
                    "initial or special token has merge priority",
                ));
            }
            priorities
        }
        None => {
            default_priorities = (0..vocab.len() as u32).collect::<Vec<_>>();
            &default_priorities
        }
    };
    let merges = if exhaustive_splits {
        let mut lookup_excluded = special_ids.clone();
        lookup_excluded.extend(byte_fallback.iter().copied());
        reconstruct_exhaustive_ranked_merges(&vocab, priorities, &non_products, &lookup_excluded)?
    } else {
        reconstruct_ranked_merges(&vocab, priorities, &non_products, |token| {
            sentencepiece_initial_symbols(token, &base, &byte_fallback_ids)
        })?
    };
    #[cfg(feature = "opt-resident-diet")]
    let vocab: Vec<TokenBytes> = vocab;
    #[cfg(not(feature = "opt-resident-diet"))]
    let vocab: Vec<TokenBytes> = vocab.into_iter().map(Into::into).collect();
    let vocab_inv = vocab
        .iter()
        .enumerate()
        .filter(|(id, token)| {
            !token.is_empty()
                && !special_ids.contains(&(*id as u32))
                && !byte_fallback.contains(&(*id as u32))
        })
        .map(|(id, token)| (token.clone(), TokenId::from(id)))
        .collect::<HashMap<_, _, FxBuildHasher>>();
    let (norm_ops, metaspace) = read_sentencepiece_pipeline(file)?;
    let mut added_tokens = Vec::new();
    let mut norm_added_tokens = Vec::new();
    for special in specials {
        if special.flags & 4 != 0 {
            return Err(HtkLoadError::Unsupported("single-word special tokens"));
        }
        let spec = AddedTokenSpec {
            content: String::from_utf8(special.bytes.clone())
                .map_err(|_| HtkLoadError::InvalidModel("non-UTF-8 sentencepiece special"))?,
            id: TokenId::from(special.id),
            lstrip: special.flags & 1 != 0,
            rstrip: special.flags & 2 != 0,
        };
        if special.flags & 8 != 0 {
            norm_added_tokens.push(spec);
        } else {
            added_tokens.push(spec);
        }
    }
    let byte_fallback_ids = byte_fallback_ids.map(|id| Some(TokenId::from(id)));
    let mut model = SentencePieceBPE {
        merges,
        vocab,
        vocab_inv,
        byte_fallback_ids,
        added_tokens,
        norm_added_tokens: Vec::new(),
        norm_ops,
        metaspace,
        word_split: WordSplit::None,
        raw_prepend: None,
        space_init: Vec::new(),
        ascii_init: [None; 128],
        added_matcher: None,
        split_bytes: [0; bpe::sentencepiece::NUM_SPLIT_BYTES],
        split_safe: Vec::new(),
        cross_pieces: Vec::new(),
        cross_prev: [0; 4],
    };
    model.norm_added_tokens = norm_added_tokens
        .into_iter()
        .map(|mut special| {
            special.content = model.apply_norm_ops(&special.content).into_owned();
            special
        })
        .collect();
    validate_sentencepiece_decoder(file, model.prepends_space())?;
    if file.header().flags & 1 != 0 {
        return Err(HtkLoadError::Unsupported(
            "sentencepiece direct pretoken emission",
        ));
    }
    model.finalize_speed_paths();
    Ok(model)
}

#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
fn sentencepiece_initial_symbols(
    token: &[u8],
    base: &HashMap<u32, u32>,
    byte_fallback: &[u32; 256],
) -> Vec<TokenId> {
    let text = std::str::from_utf8(token).expect("validated sentencepiece vocabulary is UTF-8");
    let mut symbols = Vec::new();
    for character in text.chars() {
        if let Some(id) = base.get(&(character as u32)) {
            symbols.push(TokenId::from(*id));
        } else {
            let mut bytes = [0_u8; 4];
            symbols.extend(
                character
                    .encode_utf8(&mut bytes)
                    .as_bytes()
                    .iter()
                    .map(|byte| TokenId::from(byte_fallback[*byte as usize])),
            );
        }
    }
    symbols
}

fn configure_byte_pipeline(
    file: &ValidatedFile<'_>,
    tokenizer: &mut Tokenizer,
) -> Result<(), HtkLoadError> {
    let pretok = file
        .section(SectionId::Pretok.value())
        .expect("validated PRETOK");
    let mut cursor = 0;
    let count = read_u32_at(pretok, &mut cursor);
    let mut pattern = None;
    let mut add_prefix_space = false;
    let mut trim_offsets = false;
    for _ in 0..count {
        let kind = read_byte_at(pretok, &mut cursor);
        if kind == PretokStepKind::NamedPattern.value() {
            pattern = Some(read_u32_at(pretok, &mut cursor));
        } else if kind == PretokStepKind::ByteLevel.value() {
            let flags = read_byte_at(pretok, &mut cursor);
            add_prefix_space = flags & 1 != 0;
            trim_offsets = flags & 0b010 != 0;
        } else {
            return Err(HtkLoadError::Unsupported("byte-BPE pretokenizer"));
        }
    }
    let scheme = match pattern {
        Some(value) if value == NamedPattern::O200kBase.value() => PretokenizerType::O200k,
        Some(value) if value == NamedPattern::Qwen35.value() => PretokenizerType::Qwen35,
        Some(value) if value == NamedPattern::Nemotron.value() => PretokenizerType::Nemotron,
        Some(value) if value == NamedPattern::DeepSeekV3.value() => PretokenizerType::DeepSeekV3,
        Some(value) if value == NamedPattern::Kimi.value() => PretokenizerType::Kimi,
        Some(value) if value == NamedPattern::Gpt2.value() => PretokenizerType::GPT2,
        Some(value) if value == NamedPattern::Cl100kBase.value() => PretokenizerType::GPT4,
        Some(value) if value == NamedPattern::CohereCommand.value() => {
            PretokenizerType::CohereCommand
        }
        _ => return Err(HtkLoadError::Unsupported("named split pattern")),
    };
    tokenizer.set_pretokenizer_type(scheme);
    tokenizer.set_add_prefix_space(add_prefix_space);
    tokenizer.set_trim_offsets(trim_offsets);
    tokenizer.set_ignore_merges(file.header().flags & BYTE_BPE_IGNORE_MERGES_FLAG != 0);
    if let Some(norm) = file.section(SectionId::Norm.value()) {
        let mut cursor = 0;
        let count = read_u32_at(norm, &mut cursor);
        if count == 1 && read_byte_at(norm, &mut cursor) == NormStepKind::Nfc.value() {
            tokenizer.set_normalize_nfc(true);
        } else if count != 0 {
            return Err(HtkLoadError::Unsupported("byte-BPE normalizer"));
        }
    }
    validate_empty_decoder(file)?;
    Ok(())
}

#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
fn read_sentencepiece_pipeline(
    file: &ValidatedFile<'_>,
) -> Result<(Vec<NormOp>, Option<Metaspace>), HtkLoadError> {
    let mut norm_ops = Vec::new();
    if let Some(norm) = file.section(SectionId::Norm.value()) {
        let mut cursor = 0;
        let count = read_u32_at(norm, &mut cursor);
        for _ in 0..count {
            let kind = read_byte_at(norm, &mut cursor);
            if kind == NormStepKind::Nfc.value() {
                norm_ops.push(NormOp::Nfc);
            } else if kind == NormStepKind::Prepend.value() {
                norm_ops.push(NormOp::Prepend(read_string_at(norm, &mut cursor)?));
            } else if kind == NormStepKind::Replace.value() {
                norm_ops.push(NormOp::Replace {
                    pattern: read_string_at(norm, &mut cursor)?,
                    content: read_string_at(norm, &mut cursor)?,
                });
            } else if kind == NormStepKind::StripWhitespace.value() {
                norm_ops.push(NormOp::Strip {
                    left: true,
                    right: true,
                });
            } else if kind == NormStepKind::CollapseWhitespaceRuns.value() {
                norm_ops.push(NormOp::CollapseSpaces {
                    content: " ".to_string(),
                });
            } else {
                return Err(HtkLoadError::Unsupported("sentencepiece normalizer"));
            }
        }
    }
    let pretok = file
        .section(SectionId::Pretok.value())
        .expect("validated PRETOK");
    let mut cursor = 0;
    let count = read_u32_at(pretok, &mut cursor);
    let metaspace = match count {
        0 => None,
        1 if read_byte_at(pretok, &mut cursor) == PretokStepKind::Metaspace.value() => {
            let replacement = char::from_u32(read_u32_at(pretok, &mut cursor))
                .expect("validated metaspace scalar");
            if replacement != '\u{2581}' {
                return Err(HtkLoadError::Unsupported("metaspace replacement"));
            }
            Some(Metaspace {
                prepend: PrependScheme::Always,
                split: true,
            })
        }
        _ => return Err(HtkLoadError::Unsupported("sentencepiece pretokenizer")),
    };
    Ok((norm_ops, metaspace))
}

fn validate_empty_decoder(file: &ValidatedFile<'_>) -> Result<(), HtkLoadError> {
    if let Some(decoder) = file.section(SectionId::Decoder.value())
        && decoder != 0_u32.to_le_bytes()
    {
        return Err(HtkLoadError::Unsupported("byte-BPE decoder"));
    }
    Ok(())
}

#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
fn validate_sentencepiece_decoder(
    file: &ValidatedFile<'_>,
    prepends_space: bool,
) -> Result<(), HtkLoadError> {
    let decoder = file
        .section(SectionId::Decoder.value())
        .ok_or(HtkLoadError::InvalidModel(
            "sentencepiece decoder is absent",
        ))?;
    let mut cursor = 0;
    let count = read_u32_at(decoder, &mut cursor);
    let mut kinds = Vec::new();
    for _ in 0..count {
        let kind = read_byte_at(decoder, &mut cursor);
        kinds.push(kind);
        if kind == DecoderStepKind::Replace.value() {
            let from = read_string_at(decoder, &mut cursor)?;
            let to = read_string_at(decoder, &mut cursor)?;
            if from != "\u{2581}" || to != " " {
                return Err(HtkLoadError::Unsupported(
                    "sentencepiece decoder replacement",
                ));
            }
        } else if kind == DecoderStepKind::Strip.value() {
            let scalar = read_u32_at(decoder, &mut cursor);
            let start = read_u32_at(decoder, &mut cursor);
            let stop = read_u32_at(decoder, &mut cursor);
            if scalar != u32::from(' ') || start != 1 || stop != 0 {
                return Err(HtkLoadError::Unsupported("sentencepiece decoder strip"));
            }
        }
    }
    let mut expected = vec![
        DecoderStepKind::Replace.value(),
        DecoderStepKind::ByteFallback.value(),
        DecoderStepKind::Fuse.value(),
    ];
    if prepends_space {
        expected.push(DecoderStepKind::Strip.value());
    }
    if kinds != expected {
        return Err(HtkLoadError::Unsupported("sentencepiece decoder sequence"));
    }
    Ok(())
}

fn validate_key_set<T: AsRef<[u8]>>(
    vocab: &[T],
    specials: &BTreeSet<u32>,
    byte_fallback: &BTreeSet<u32>,
) -> Result<(), HtkLoadError> {
    let mut keys: HashMap<&[u8], u32> = HashMap::new();
    for (id, token) in vocab.iter().enumerate() {
        let token = token.as_ref();
        let id = id as u32;
        if token.is_empty() || specials.contains(&id) || byte_fallback.contains(&id) {
            continue;
        }
        if keys.insert(token, id).is_some() {
            return Err(HtkLoadError::InvalidModel("duplicate lookup-key bytes"));
        }
    }
    Ok(())
}

fn read_byte_base(file: &ValidatedFile<'_>) -> [u32; 256] {
    let section = file
        .section(SectionId::Base.value())
        .expect("validated BASE");
    std::array::from_fn(|index| read_u32(&section[index * 4..index * 4 + 4]))
}

#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
fn read_sentencepiece_base(file: &ValidatedFile<'_>) -> HashMap<u32, u32> {
    let section = file
        .section(SectionId::Base.value())
        .expect("validated BASE");
    section[4..]
        .chunks_exact(8)
        .map(|entry| (read_u32(&entry[..4]), read_u32(&entry[4..])))
        .collect()
}

fn read_byte_fallback(file: &ValidatedFile<'_>) -> [u32; 256] {
    let section = file
        .section(SectionId::ByteFall.value())
        .expect("validated BYTEFALL");
    std::array::from_fn(|index| read_u32(&section[index * 4..index * 4 + 4]))
}

fn read_priorities(file: &ValidatedFile<'_>) -> Option<Vec<u32>> {
    let mut remaining = file.section(SectionId::Priority.value())?;
    Some(
        (0..file.header().vocab_size)
            .map(|_| {
                let (value, consumed) = decode_u32(remaining).expect("validated PRIORITY");
                remaining = &remaining[consumed..];
                value
            })
            .collect(),
    )
}

#[derive(Clone)]
struct Special {
    id: u32,
    bytes: Vec<u8>,
    flags: u32,
}

fn read_specials(file: &ValidatedFile<'_>) -> Result<Vec<Special>, HtkLoadError> {
    let section = file
        .section(SectionId::Specials.value())
        .expect("validated SPECIALS");
    let mut cursor = 0;
    let count = read_u32_at(section, &mut cursor);
    let mut specials = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let id = read_u32_at(section, &mut cursor);
        let length = read_u32_at(section, &mut cursor) as usize;
        let bytes = section[cursor..cursor + length].to_vec();
        cursor += length;
        let flags = read_u32_at(section, &mut cursor);
        if flags & !0b1111 != 0 {
            return Err(HtkLoadError::InvalidModel("unknown special-token flags"));
        }
        specials.push(Special { id, bytes, flags });
    }
    cursor += count as usize * 4;
    debug_assert_eq!(cursor, section.len());
    Ok(specials)
}

fn read_post(file: &ValidatedFile<'_>) -> Vec<(PostPosition, u32)> {
    let Some(section) = file.section(SectionId::Post.value()) else {
        return Vec::new();
    };
    let mut cursor = 0;
    let count = read_u32_at(section, &mut cursor);
    (0..count)
        .map(|_| {
            let position = match read_byte_at(section, &mut cursor) {
                value if value == PostPosition::Prepend.value() => PostPosition::Prepend,
                value if value == PostPosition::Append.value() => PostPosition::Append,
                _ => unreachable!("validated POST position"),
            };
            (position, read_u32_at(section, &mut cursor))
        })
        .collect()
}

fn read_byte_at(bytes: &[u8], cursor: &mut usize) -> u8 {
    let value = bytes[*cursor];
    *cursor += 1;
    value
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes[..4].try_into().expect("validated u32"))
}

fn read_u32_at(bytes: &[u8], cursor: &mut usize) -> u32 {
    let value = read_u32(&bytes[*cursor..]);
    *cursor += 4;
    value
}

fn read_string_at(bytes: &[u8], cursor: &mut usize) -> Result<String, HtkLoadError> {
    let length = read_u32_at(bytes, cursor) as usize;
    let value = std::str::from_utf8(&bytes[*cursor..*cursor + length])
        .map_err(|_| HtkLoadError::InvalidModel("invalid UTF-8 pipeline string"))?
        .to_string();
    *cursor += length;
    Ok(value)
}
