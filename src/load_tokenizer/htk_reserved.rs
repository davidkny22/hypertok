use crate::bpe::Tokenizer;
#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
use crate::bpe::sentencepiece::{AddedTokenSpec, SentencePieceBPE};
use crate::bpe::tiktoken::AddedTokenDef;
use crate::bpe::tiktoken::StartError;
use crate::token::TokenId;
use aho_corasick::{AhoCorasick, AhoCorasickKind, MatchKind};
use rustc_hash::FxBuildHasher;
use std::collections::HashMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

const MAX_CACHED_SUBSETS: usize = 32;

pub(crate) struct HtkReservedPolicy<'a> {
    pub match_all: bool,
    pub match_names: &'a [String],
    pub refuse_all: bool,
    pub refuse_names: &'a [String],
}

#[derive(Clone, Debug)]
struct ReservedToken {
    name: Box<str>,
    content: Arc<[u8]>,
    id: TokenId,
    lstrip: bool,
    rstrip: bool,
    normalized: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct HtkReservedDefinition {
    pub content: Arc<[u8]>,
    pub id: TokenId,
    pub lstrip: bool,
    pub rstrip: bool,
    pub normalized: bool,
}

pub struct HtkReservedCatalog {
    tokens: Vec<ReservedToken>,
    by_name: HashMap<Box<str>, usize, FxBuildHasher>,
    matcher: Option<AhoCorasick>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HtkReservedError {
    UnknownToken(String),
    RefusedToken(String),
    Starts(StartError),
}

impl Display for HtkReservedError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownToken(name) => write!(formatter, "unknown reserved token {name:?}"),
            Self::RefusedToken(name) => write!(formatter, "refused reserved token {name:?}"),
            Self::Starts(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for HtkReservedError {}

#[derive(Debug, Eq, PartialEq)]
pub struct HtkReservedEncoding {
    pub ids: Vec<u32>,
    pub found: Vec<String>,
}

pub(crate) struct HtkReservedDetailedEncoding {
    pub ids: Vec<u32>,
    pub starts: Vec<u32>,
    pub found: Vec<String>,
}

impl HtkReservedCatalog {
    pub(crate) fn new(definitions: Vec<HtkReservedDefinition>) -> Self {
        let tokens = definitions
            .into_iter()
            .filter_map(|definition| {
                let name = std::str::from_utf8(&definition.content).ok()?.into();
                Some(ReservedToken {
                    name,
                    content: definition.content,
                    id: definition.id,
                    lstrip: definition.lstrip,
                    rstrip: definition.rstrip,
                    normalized: definition.normalized,
                })
            })
            .collect::<Vec<_>>();
        let by_name = tokens
            .iter()
            .enumerate()
            .map(|(index, token)| (token.name.clone(), index))
            .collect();
        let matcher = (!tokens.is_empty()).then(|| {
            AhoCorasick::builder()
                .match_kind(MatchKind::Standard)
                .kind(Some(AhoCorasickKind::DFA))
                .build(tokens.iter().map(|token| token.content.as_ref()))
                .expect("validated reserved-token automaton")
        });
        Self {
            tokens,
            by_name,
            matcher,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    pub fn names(&self) -> Vec<String> {
        self.tokens
            .iter()
            .map(|token| token.name.to_string())
            .collect()
    }

    pub(crate) fn found_names(&self, input: &[u8]) -> Vec<String> {
        let first = self.first_occurrences(input);
        let mut found = first
            .iter()
            .enumerate()
            .filter(|(_, position)| **position != usize::MAX)
            .map(|(index, position)| (*position, index))
            .collect::<Vec<_>>();
        found.sort_unstable();
        found
            .into_iter()
            .map(|(_, index)| self.tokens[index].name.to_string())
            .collect()
    }

    pub fn encode_byte_bpe(
        &self,
        tokenizer: &mut Tokenizer,
        subset_cache: &mut HashMap<Vec<usize>, Box<Tokenizer>, FxBuildHasher>,
        input: &[u8],
        policy: &HtkReservedPolicy<'_>,
    ) -> Result<HtkReservedEncoding, HtkReservedError> {
        let (enabled, found) = self.resolve_policy(input, policy)?;
        let selected = self.selected_byte_tokenizer(tokenizer, subset_cache, &enabled);
        let mut ids = Vec::new();
        selected.encode_with_added_tokens_flat(input, &mut ids);
        Ok(HtkReservedEncoding { ids, found })
    }

    pub(crate) fn encode_byte_bpe_detailed(
        &self,
        tokenizer: &mut Tokenizer,
        subset_cache: &mut HashMap<Vec<usize>, Box<Tokenizer>, FxBuildHasher>,
        input: &[u8],
        policy: &HtkReservedPolicy<'_>,
    ) -> Result<HtkReservedDetailedEncoding, HtkReservedError> {
        let (enabled, found) = self.resolve_policy(input, policy)?;
        let selected = self.selected_byte_tokenizer(tokenizer, subset_cache, &enabled);
        let mut ids = Vec::new();
        selected.encode_with_added_tokens_flat(input, &mut ids);
        let starts = selected
            .token_starts(input, &ids)
            .map_err(HtkReservedError::Starts)?;
        Ok(HtkReservedDetailedEncoding { ids, starts, found })
    }

    fn selected_byte_tokenizer<'a>(
        &self,
        tokenizer: &'a mut Tokenizer,
        subset_cache: &'a mut HashMap<Vec<usize>, Box<Tokenizer>, FxBuildHasher>,
        enabled: &[usize],
    ) -> &'a mut Tokenizer {
        if enabled.len() == self.tokens.len() {
            return tokenizer;
        }
        if !subset_cache.contains_key(enabled) {
            if subset_cache.len() >= MAX_CACHED_SUBSETS {
                subset_cache.clear();
            }
            let mut fork = tokenizer.fork();
            fork.set_added_tokens(
                enabled
                    .iter()
                    .map(|index| self.tokens[*index].byte_definition())
                    .collect(),
            );
            subset_cache.insert(enabled.to_vec(), Box::new(fork));
        }
        subset_cache
            .get_mut(enabled)
            .expect("reserved subset inserted")
    }

    #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
    pub fn encode_sentencepiece(
        &self,
        tokenizer: &mut SentencePieceBPE,
        input: &str,
        policy: &HtkReservedPolicy<'_>,
    ) -> Result<HtkReservedEncoding, HtkReservedError> {
        let (enabled, found) = self.resolve_policy(input.as_bytes(), policy)?;
        let mut selected = vec![false; self.tokens.len()];
        for index in enabled {
            selected[index] = true;
        }

        let original_raw = std::mem::take(&mut tokenizer.added_tokens);
        let original_normalized = std::mem::take(&mut tokenizer.norm_added_tokens);
        let original_matcher = tokenizer.added_matcher.take();
        tokenizer.added_tokens = original_raw
            .iter()
            .filter(|token| self.is_enabled_id(token.id, false, &selected))
            .map(copy_sentencepiece_token)
            .collect();
        tokenizer.norm_added_tokens = original_normalized
            .iter()
            .filter(|token| self.is_enabled_id(token.id, true, &selected))
            .map(copy_sentencepiece_token)
            .collect();
        tokenizer.added_matcher = sentencepiece_matcher(&tokenizer.added_tokens);

        let encoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tokenizer
                .encode_raw(input)
                .into_iter()
                .map(u32::from)
                .collect()
        }));
        tokenizer.added_tokens = original_raw;
        tokenizer.norm_added_tokens = original_normalized;
        tokenizer.added_matcher = original_matcher;
        let ids = match encoded {
            Ok(ids) => ids,
            Err(payload) => std::panic::resume_unwind(payload),
        };
        Ok(HtkReservedEncoding { ids, found })
    }

    #[cfg(test)]
    fn selected_names(
        &self,
        input: &[u8],
        match_all: bool,
        match_names: &[String],
    ) -> Result<Vec<String>, HtkReservedError> {
        let enabled = self.resolve(match_all, match_names)?;
        let enabled = enabled
            .into_iter()
            .map(|index| self.tokens[index].content.as_ref())
            .collect::<Vec<_>>();
        if enabled.is_empty() {
            return Ok(Vec::new());
        }
        let matcher = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .build(&enabled)
            .expect("reserved subset automaton");
        Ok(matcher
            .find_iter(input)
            .map(|matched| {
                std::str::from_utf8(enabled[matched.pattern().as_usize()])
                    .expect("catalog names are UTF-8")
                    .to_string()
            })
            .collect())
    }

    fn resolve(&self, all: bool, names: &[String]) -> Result<Vec<usize>, HtkReservedError> {
        if all {
            return Ok((0..self.tokens.len()).collect());
        }
        let mut selected = names
            .iter()
            .map(|name| {
                self.by_name
                    .get(name.as_str())
                    .copied()
                    .ok_or_else(|| HtkReservedError::UnknownToken(name.clone()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        selected.sort_unstable();
        selected.dedup();
        Ok(selected)
    }

    fn resolve_policy(
        &self,
        input: &[u8],
        policy: &HtkReservedPolicy<'_>,
    ) -> Result<(Vec<usize>, Vec<String>), HtkReservedError> {
        let enabled = self.resolve(policy.match_all, policy.match_names)?;
        let refused = self.resolve(policy.refuse_all, policy.refuse_names)?;
        let first = self.first_occurrences(input);
        if let Some(index) = refused
            .iter()
            .copied()
            .filter(|index| first[*index] != usize::MAX)
            .min_by_key(|index| {
                (
                    first[*index],
                    std::cmp::Reverse(self.tokens[*index].name.len()),
                    *index,
                )
            })
        {
            return Err(HtkReservedError::RefusedToken(
                self.tokens[index].name.to_string(),
            ));
        }
        let mut found = first
            .iter()
            .enumerate()
            .filter(|(_, position)| **position != usize::MAX)
            .map(|(index, position)| (*position, index))
            .collect::<Vec<_>>();
        found.sort_unstable();
        Ok((
            enabled,
            found
                .into_iter()
                .map(|(_, index)| self.tokens[index].name.to_string())
                .collect(),
        ))
    }

    #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
    fn is_enabled_id(&self, id: TokenId, normalized: bool, enabled: &[bool]) -> bool {
        self.tokens.iter().enumerate().any(|(index, token)| {
            token.id == id && token.normalized == normalized && enabled[index]
        })
    }

    fn first_occurrences(&self, input: &[u8]) -> Vec<usize> {
        let mut first = vec![usize::MAX; self.tokens.len()];
        if let Some(matcher) = &self.matcher {
            for matched in matcher.find_overlapping_iter(input) {
                let index = matched.pattern().as_usize();
                first[index] = first[index].min(matched.start());
            }
        }
        first
    }
}

impl ReservedToken {
    fn byte_definition(&self) -> AddedTokenDef {
        AddedTokenDef {
            content: Arc::clone(&self.content),
            id: self.id,
            lstrip: self.lstrip,
            rstrip: self.rstrip,
        }
    }
}

#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
fn copy_sentencepiece_token(token: &AddedTokenSpec) -> AddedTokenSpec {
    AddedTokenSpec {
        content: token.content.clone(),
        id: token.id,
        lstrip: token.lstrip,
        rstrip: token.rstrip,
    }
}

#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
fn sentencepiece_matcher(tokens: &[AddedTokenSpec]) -> Option<AhoCorasick> {
    (!tokens.is_empty()).then(|| {
        AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .kind(Some(AhoCorasickKind::DFA))
            .build(tokens.iter().map(|token| token.content.as_bytes()))
            .expect("validated reserved-token automaton")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
    use crate::load_tokenizer::htk::{HtkTokenizer, load_htk_slice};

    fn special(content: &str, id: u32) -> HtkReservedDefinition {
        HtkReservedDefinition {
            content: Arc::from(content.as_bytes()),
            id: TokenId::from(id),
            lstrip: false,
            rstrip: false,
            normalized: false,
        }
    }

    #[test]
    fn disabled_longer_token_exposes_enabled_shorter_token() {
        let catalog = HtkReservedCatalog::new(vec![special("<x>", 300), special("<x><y>", 301)]);
        assert_eq!(
            catalog
                .selected_names(b"<x><y>", false, &["<x>".to_string()])
                .unwrap(),
            ["<x>"]
        );
        assert_eq!(
            catalog.selected_names(b"<x><y>", true, &[]).unwrap(),
            ["<x><y>"]
        );
    }

    #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
    #[test]
    fn sentencepiece_policy_matches_independent_fixture_copy_and_restores_state() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let htk = root.join("tests/fixtures/sentencepiece.htk");
        let bytes = std::fs::read(htk).expect("read SentencePiece fixture");
        let mut loaded = load_htk_slice(&bytes).expect("load SentencePiece fixture");
        let mut oracle = load_htk_slice(&bytes).expect("load independent fixture copy");
        let HtkTokenizer::SentencePiece(oracle) = &mut oracle.tokenizer else {
            panic!("expected a SentencePiece fixture");
        };
        let text = "alpha<s>beta</s>gamma";

        let default = loaded
            .encode_reserved(text, true, &[], false, &[])
            .expect("default SentencePiece policy");
        assert_eq!(default.ids, sentencepiece_encode(oracle, text, &[259, 260]));
        assert_eq!(default.found, ["<s>", "</s>"]);

        let selected_names = ["<s>".to_string()];
        let selected = loaded
            .encode_reserved(text, false, &selected_names, false, &[])
            .expect("selective SentencePiece policy");
        assert_eq!(selected.ids, sentencepiece_encode(oracle, text, &[259]));
        assert_eq!(selected.found, default.found);

        let literal = loaded
            .encode_reserved(text, false, &[], false, &[])
            .expect("literal SentencePiece policy");
        assert_eq!(literal.ids, sentencepiece_encode(oracle, text, &[]));
        assert_ne!(literal.ids, default.ids);
        assert_eq!(literal.found, default.found);

        assert_eq!(
            loaded.encode_reserved(text, true, &[], false, &selected_names),
            Err(HtkReservedError::RefusedToken("<s>".to_string()))
        );
        assert_eq!(loaded.tokenizer.encode(text), default.ids);
    }

    #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
    fn sentencepiece_encode(
        model: &mut SentencePieceBPE,
        input: &str,
        enabled_ids: &[u32],
    ) -> Vec<u32> {
        let original_raw = std::mem::take(&mut model.added_tokens);
        let original_normalized = std::mem::take(&mut model.norm_added_tokens);
        let original_matcher = model.added_matcher.take();
        model.added_tokens = original_raw
            .iter()
            .filter(|token| enabled_ids.contains(&u32::from(token.id)))
            .map(copy_sentencepiece_token)
            .collect();
        model.norm_added_tokens = original_normalized
            .iter()
            .filter(|token| enabled_ids.contains(&u32::from(token.id)))
            .map(copy_sentencepiece_token)
            .collect();
        model.added_matcher = sentencepiece_matcher(&model.added_tokens);
        let ids = model.encode_raw(input).into_iter().map(u32::from).collect();
        model.added_tokens = original_raw;
        model.norm_added_tokens = original_normalized;
        model.added_matcher = original_matcher;
        ids
    }
}
