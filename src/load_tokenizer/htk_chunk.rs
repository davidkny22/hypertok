use std::collections::VecDeque;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::ops::Range;

#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
use crate::bpe::sentencepiece::EncodeState;
use crate::pretokenize::{Pretoken, SpanIter};

use super::htk::{HtkLookupIndex, HtkTokenizer};

const DEFAULT_CHUNK_MULTIPLIER: usize = 32;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ChunkConfig {
    pub chunk_size: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChunkedEncoding {
    pub ids: Vec<u32>,
    pub initial_chunks: usize,
    pub enlargements: usize,
    pub largest_encoded_span: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChunkError {
    InvalidOmega,
    ChunkSizeOverflow,
    ChunkTooSmall {
        chunk_size: usize,
        minimum: usize,
    },
    InvalidUtf8Pretoken,
    InvalidGeometry,
    EncodeResultCount {
        expected: usize,
        actual: usize,
    },
    EncoderUnavailable,
    UnknownTokenId(u32),
    TokenCoverage {
        range_start: usize,
        range_end: usize,
        covered_end: usize,
    },
}

impl Display for ChunkError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidOmega => formatter.write_str("omega must be positive"),
            Self::ChunkSizeOverflow => formatter.write_str("default chunk size overflow"),
            Self::ChunkTooSmall {
                chunk_size,
                minimum,
            } => write!(
                formatter,
                "chunk size {chunk_size} is below the minimum {minimum}"
            ),
            Self::InvalidUtf8Pretoken => {
                formatter.write_str("codepoint-class pretoken is not valid UTF-8")
            }
            Self::InvalidGeometry => formatter.write_str("chunk geometry made no forward progress"),
            Self::EncodeResultCount { expected, actual } => write!(
                formatter,
                "chunk encoder returned {actual} results for {expected} ranges"
            ),
            Self::EncoderUnavailable => {
                formatter.write_str("a private chunk encoder cache is unavailable")
            }
            Self::UnknownTokenId(id) => write!(formatter, "encoded token id {id} is absent"),
            Self::TokenCoverage {
                range_start,
                range_end,
                covered_end,
            } => write!(
                formatter,
                "tokens for range {range_start}..{range_end} cover through {covered_end}"
            ),
        }
    }
}

impl Error for ChunkError {}

impl HtkTokenizer {
    /// Encode one post-pretokenization byte sequence with overlap and
    /// verification. SentencePiece input is the normalized pretoken bytes.
    pub fn encode_pretoken_chunked(
        &mut self,
        lookup_index: &HtkLookupIndex,
        omega: u32,
        pretoken: &[u8],
        config: ChunkConfig,
    ) -> Result<ChunkedEncoding, ChunkError> {
        match self {
            Self::ByteBpe(tokenizer) => encode_overlap(
                pretoken,
                omega,
                config,
                false,
                |bytes| {
                    let mut ids = Vec::new();
                    tokenizer
                        .memoized_encode_flat(SpanIter(std::iter::once(Pretoken(bytes))), &mut ids);
                    Ok(ids)
                },
                |id| lookup_index.token(id).map(<[u8]>::len),
            ),
            #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
            Self::SentencePiece(model) => {
                let mut state = EncodeState::new();
                encode_overlap(
                    pretoken,
                    omega,
                    config,
                    true,
                    |bytes| {
                        let text = std::str::from_utf8(bytes)
                            .map_err(|_| ChunkError::InvalidUtf8Pretoken)?;
                        let mut ids = Vec::new();
                        model.encode_normalized_cb(&mut state, text, &mut |tokens| {
                            ids.extend(tokens.iter().map(|token| token.0));
                        });
                        Ok(ids)
                    },
                    |id| lookup_index.token(id).map(<[u8]>::len),
                )
            }
        }
    }
}

pub(crate) fn encode_overlap(
    pretoken: &[u8],
    omega: u32,
    config: ChunkConfig,
    codepoint_edges: bool,
    mut encode: impl FnMut(&[u8]) -> Result<Vec<u32>, ChunkError>,
    token_len: impl Fn(u32) -> Option<usize>,
) -> Result<ChunkedEncoding, ChunkError> {
    encode_overlap_batched(
        pretoken,
        omega,
        config,
        codepoint_edges,
        |ranges| {
            ranges
                .iter()
                .map(|range| encode(&pretoken[range.clone()]))
                .collect()
        },
        token_len,
    )
}

/// Encode the independent initial overlap ranges as one batch, then apply
/// the same ordered verification and enlargement logic as [`encode_overlap`].
/// A concurrent caller may parallelize `encode_many`; reconciliation remains
/// single-sourced here.
pub(crate) fn encode_overlap_batched(
    pretoken: &[u8],
    omega: u32,
    config: ChunkConfig,
    codepoint_edges: bool,
    mut encode_many: impl FnMut(&[Range<usize>]) -> Result<Vec<Vec<u32>>, ChunkError>,
    token_len: impl Fn(u32) -> Option<usize>,
) -> Result<ChunkedEncoding, ChunkError> {
    let ranges = overlap_ranges(pretoken, omega, config, codepoint_edges)?;
    let initial_ids = encode_many(&ranges)?;
    let mut reconciliation = OverlapReconciliation::new(ranges, initial_ids, &token_len)?;
    while let Some(range) = reconciliation.requested_range() {
        let mut encoded = encode_many(std::slice::from_ref(&range))?;
        if encoded.len() != 1 {
            return Err(ChunkError::EncodeResultCount {
                expected: 1,
                actual: encoded.len(),
            });
        }
        reconciliation.accept_enlargement(encoded.remove(0), &token_len)?;
    }
    reconciliation.finish()
}

pub(crate) fn overlap_ranges(
    pretoken: &[u8],
    omega: u32,
    config: ChunkConfig,
    codepoint_edges: bool,
) -> Result<Vec<Range<usize>>, ChunkError> {
    let omega = usize::try_from(omega).map_err(|_| ChunkError::ChunkSizeOverflow)?;
    if omega == 0 {
        return Err(ChunkError::InvalidOmega);
    }
    if codepoint_edges && std::str::from_utf8(pretoken).is_err() {
        return Err(ChunkError::InvalidUtf8Pretoken);
    }
    let minimum = omega.checked_mul(2).ok_or(ChunkError::ChunkSizeOverflow)?;
    let chunk_size = match config.chunk_size {
        Some(value) => value,
        None => omega
            .checked_mul(DEFAULT_CHUNK_MULTIPLIER)
            .ok_or(ChunkError::ChunkSizeOverflow)?,
    };
    if chunk_size < minimum {
        return Err(ChunkError::ChunkTooSmall {
            chunk_size,
            minimum,
        });
    }

    chunk_ranges(pretoken, chunk_size, omega, codepoint_edges)
}

fn chunk_ranges(
    pretoken: &[u8],
    chunk_size: usize,
    omega: usize,
    codepoint_edges: bool,
) -> Result<Vec<Range<usize>>, ChunkError> {
    if pretoken.len() <= chunk_size {
        return Ok(std::iter::once(0..pretoken.len()).collect());
    }
    let text = codepoint_edges.then(|| std::str::from_utf8(pretoken).expect("validated UTF-8"));
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < pretoken.len() {
        let mut end = start.saturating_add(chunk_size).min(pretoken.len());
        if let Some(text) = text {
            while end < pretoken.len() && !text.is_char_boundary(end) {
                end += 1;
            }
        }
        ranges.push(start..end);
        if end == pretoken.len() {
            break;
        }
        let mut next = end - omega;
        if let Some(text) = text {
            while next > start && !text.is_char_boundary(next) {
                next -= 1;
            }
        }
        if next <= start {
            return Err(ChunkError::InvalidGeometry);
        }
        start = next;
    }
    Ok(ranges)
}

struct EncodedChunk {
    range: Range<usize>,
    ids: Vec<u32>,
    boundaries: Vec<usize>,
}

pub(crate) struct OverlapReconciliation {
    left: Option<EncodedChunk>,
    right: VecDeque<EncodedChunk>,
    pending_range: Option<Range<usize>>,
    initial_chunks: usize,
    enlargements: usize,
    largest_encoded_span: usize,
}

impl OverlapReconciliation {
    pub(crate) fn new(
        ranges: Vec<Range<usize>>,
        encoded: Vec<Vec<u32>>,
        token_len: &impl Fn(u32) -> Option<usize>,
    ) -> Result<Self, ChunkError> {
        let initial_chunks = ranges.len();
        let mut chunks = encoded_chunks(ranges, encoded, token_len)?;
        let left = chunks.remove(0);
        let largest_encoded_span = left.range.len();
        let mut state = Self {
            left: Some(left),
            right: chunks.into(),
            pending_range: None,
            initial_chunks,
            enlargements: 0,
            largest_encoded_span,
        };
        state.advance(token_len)?;
        Ok(state)
    }

    pub(crate) fn requested_range(&self) -> Option<Range<usize>> {
        self.pending_range.clone()
    }

    pub(crate) fn accept_enlargement(
        &mut self,
        ids: Vec<u32>,
        token_len: &impl Fn(u32) -> Option<usize>,
    ) -> Result<(), ChunkError> {
        let range = self
            .pending_range
            .take()
            .ok_or(ChunkError::InvalidGeometry)?;
        let chunk = encoded_chunk(range, ids, token_len)?;
        self.largest_encoded_span = self.largest_encoded_span.max(chunk.range.len());
        self.left = Some(chunk);
        self.advance(token_len)
    }

    pub(crate) fn finish(self) -> Result<ChunkedEncoding, ChunkError> {
        if self.pending_range.is_some() || !self.right.is_empty() {
            return Err(ChunkError::InvalidGeometry);
        }
        let left = self.left.ok_or(ChunkError::InvalidGeometry)?;
        Ok(ChunkedEncoding {
            ids: left.ids,
            initial_chunks: self.initial_chunks,
            enlargements: self.enlargements,
            largest_encoded_span: self.largest_encoded_span,
        })
    }

    fn advance(&mut self, token_len: &impl Fn(u32) -> Option<usize>) -> Result<(), ChunkError> {
        while let Some(right) = self.right.pop_front() {
            self.largest_encoded_span = self.largest_encoded_span.max(right.range.len());
            let left = self.left.take().ok_or(ChunkError::InvalidGeometry)?;
            let overlap_start = right.range.start;
            let overlap_end = left.range.end.min(right.range.end);
            let left_overlap = boundaries_in(&left, overlap_start, overlap_end);
            let right_overlap = boundaries_in(&right, overlap_start, overlap_end);
            if !left_overlap.is_empty() && left_overlap == right_overlap {
                self.left = Some(splice(left, right, left_overlap[0], token_len)?);
            } else {
                self.pending_range = Some(left.range.start..right.range.end.max(left.range.end));
                self.enlargements += 1;
                return Ok(());
            }
        }
        Ok(())
    }
}

fn encoded_chunks(
    ranges: Vec<Range<usize>>,
    encoded: Vec<Vec<u32>>,
    token_len: &impl Fn(u32) -> Option<usize>,
) -> Result<Vec<EncodedChunk>, ChunkError> {
    if encoded.len() != ranges.len() {
        return Err(ChunkError::EncodeResultCount {
            expected: ranges.len(),
            actual: encoded.len(),
        });
    }
    ranges
        .into_iter()
        .zip(encoded)
        .map(|(range, ids)| encoded_chunk(range, ids, token_len))
        .collect()
}

fn encoded_chunk(
    range: Range<usize>,
    ids: Vec<u32>,
    token_len: &impl Fn(u32) -> Option<usize>,
) -> Result<EncodedChunk, ChunkError> {
    let mut cursor = range.start;
    let mut boundaries = Vec::with_capacity(ids.len() + 1);
    boundaries.push(cursor);
    for &id in &ids {
        let length = token_len(id).ok_or(ChunkError::UnknownTokenId(id))?;
        cursor = cursor
            .checked_add(length)
            .ok_or(ChunkError::TokenCoverage {
                range_start: range.start,
                range_end: range.end,
                covered_end: usize::MAX,
            })?;
        if cursor > range.end {
            return Err(ChunkError::TokenCoverage {
                range_start: range.start,
                range_end: range.end,
                covered_end: cursor,
            });
        }
        boundaries.push(cursor);
    }
    if cursor != range.end {
        return Err(ChunkError::TokenCoverage {
            range_start: range.start,
            range_end: range.end,
            covered_end: cursor,
        });
    }
    Ok(EncodedChunk {
        range,
        ids,
        boundaries,
    })
}

fn boundaries_in(chunk: &EncodedChunk, start: usize, end: usize) -> Vec<usize> {
    chunk
        .boundaries
        .iter()
        .copied()
        .filter(|position| *position >= start && *position <= end)
        .collect()
}

fn splice(
    left: EncodedChunk,
    right: EncodedChunk,
    boundary: usize,
    token_len: &impl Fn(u32) -> Option<usize>,
) -> Result<EncodedChunk, ChunkError> {
    let left_index = left
        .boundaries
        .binary_search(&boundary)
        .expect("agreement boundary exists on left");
    let right_index = right
        .boundaries
        .binary_search(&boundary)
        .expect("agreement boundary exists on right");
    let mut ids = Vec::with_capacity(left_index + right.ids.len() - right_index);
    ids.extend_from_slice(&left.ids[..left_index]);
    ids.extend_from_slice(&right.ids[right_index..]);
    encoded_chunk(left.range.start..right.range.end, ids, token_len)
}
