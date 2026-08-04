use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::bpe::Tokenizer;
use crate::bpe::tiktoken::AddedPiece;
use crate::pretokenize::{PRETOKEN_CHUNK, Pretoken, PretokenizerType, SpanBatch, SpanIter};

use super::htk_chunk::{ChunkConfig, ChunkError, encode_overlap};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ChunkStreamTelemetry {
    pub pretokens: usize,
    pub engaged_pretokens: usize,
    pub initial_chunks: usize,
    pub enlargements: usize,
    #[cfg(test)]
    short_flushes: usize,
}

impl ChunkStreamTelemetry {
    pub fn as_u32(self, chunk_size: usize) -> Result<[u32; 5], ChunkStreamError> {
        Ok([
            to_u32(self.pretokens)?,
            to_u32(self.engaged_pretokens)?,
            to_u32(self.initial_chunks)?,
            to_u32(self.enlargements)?,
            to_u32(chunk_size)?,
        ])
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChunkStreamError {
    Chunk(ChunkError),
    CounterOverflow,
}

impl Display for ChunkStreamError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Chunk(error) => Display::fmt(error, formatter),
            Self::CounterOverflow => formatter.write_str("chunk telemetry exceeds u32"),
        }
    }
}

impl Error for ChunkStreamError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Chunk(error) => Some(error),
            Self::CounterOverflow => None,
        }
    }
}

impl From<ChunkError> for ChunkStreamError {
    fn from(error: ChunkError) -> Self {
        Self::Chunk(error)
    }
}

pub(crate) fn encode_chunked_streaming<F>(
    tokenizer: &mut Tokenizer,
    token_length: F,
    omega: u32,
    input: &[u8],
    chunk_size: usize,
    output: &mut Vec<u32>,
) -> Result<ChunkStreamTelemetry, ChunkStreamError>
where
    F: Fn(u32) -> Option<usize> + Copy,
{
    let pretokenizer = tokenizer.pretokenizer_type();
    let mut telemetry = ChunkStreamTelemetry::default();
    tokenizer.try_for_each_added_piece(input, |tokenizer, piece| match piece {
        AddedPiece::Segment(segment) => encode_segment(
            tokenizer,
            token_length,
            pretokenizer,
            omega,
            segment,
            chunk_size,
            output,
            &mut telemetry,
        ),
        AddedPiece::Added(id) => {
            output.push(id);
            Ok(())
        }
    })?;
    Ok(telemetry)
}

#[cfg(feature = "opt-scan-two-phase")]
#[allow(clippy::too_many_arguments)]
fn encode_segment<F>(
    tokenizer: &mut Tokenizer,
    token_length: F,
    pretokenizer: PretokenizerType,
    omega: u32,
    segment: &[u8],
    chunk_size: usize,
    output: &mut Vec<u32>,
    telemetry: &mut ChunkStreamTelemetry,
) -> Result<(), ChunkStreamError>
where
    F: Fn(u32) -> Option<usize> + Copy,
{
    let mut pretokens = pretokenizer.pretokenize(segment);
    let mut batch = SpanBatch::new();
    loop {
        let count = tokenizer.fill_chunk_stream_batch(&mut pretokens, &mut batch);
        if count == 0 {
            break;
        }
        telemetry.pretokens = checked_add(telemetry.pretokens, count)?;
        let contains_long = batch.entries[..count]
            .iter()
            .any(|entry| entry.span_len() > chunk_size);
        if !contains_long {
            telemetry.initial_chunks = checked_add(telemetry.initial_chunks, count)?;
            tokenizer.emit_chunk_stream_batch(&batch, count, output);
            #[cfg(test)]
            {
                telemetry.short_flushes = checked_add(telemetry.short_flushes, 1)?;
            }
        } else {
            for index in 0..count {
                // SAFETY: the current fill wrote every entry below `count`.
                let pretoken = unsafe { batch.span(index) };
                if pretoken.len() <= chunk_size {
                    telemetry.initial_chunks = checked_add(telemetry.initial_chunks, 1)?;
                    tokenizer.memoized_encode_flat(
                        SpanIter(std::iter::once(Pretoken(pretoken))),
                        output,
                    );
                    #[cfg(test)]
                    {
                        telemetry.short_flushes = checked_add(telemetry.short_flushes, 1)?;
                    }
                    continue;
                }
                let encoded = encode_overlap(
                    pretoken,
                    omega,
                    ChunkConfig {
                        chunk_size: Some(chunk_size),
                    },
                    false,
                    |chunk| {
                        let mut ids = Vec::new();
                        tokenizer.memoized_encode_flat(
                            SpanIter(std::iter::once(Pretoken(chunk))),
                            &mut ids,
                        );
                        Ok(ids)
                    },
                    token_length,
                )?;
                telemetry.engaged_pretokens = checked_add(
                    telemetry.engaged_pretokens,
                    usize::from(encoded.initial_chunks > 1),
                )?;
                telemetry.initial_chunks =
                    checked_add(telemetry.initial_chunks, encoded.initial_chunks)?;
                telemetry.enlargements =
                    checked_add(telemetry.enlargements, encoded.enlargements)?;
                output.extend(encoded.ids);
            }
        }
        if count < PRETOKEN_CHUNK {
            break;
        }
    }
    Ok(())
}

#[cfg(not(feature = "opt-scan-two-phase"))]
#[allow(clippy::too_many_arguments)]
fn encode_segment<F>(
    tokenizer: &mut Tokenizer,
    token_length: F,
    pretokenizer: PretokenizerType,
    omega: u32,
    segment: &[u8],
    chunk_size: usize,
    output: &mut Vec<u32>,
    telemetry: &mut ChunkStreamTelemetry,
) -> Result<(), ChunkStreamError>
where
    F: Fn(u32) -> Option<usize> + Copy,
{
    let mut short = [None; PRETOKEN_CHUNK];
    let mut short_len = 0_usize;
    for pretoken in pretokenizer.pretokenize(segment) {
        telemetry.pretokens = checked_add(telemetry.pretokens, 1)?;
        if pretoken.len() <= chunk_size {
            short[short_len] = Some(pretoken);
            short_len += 1;
            if short_len == PRETOKEN_CHUNK {
                telemetry.initial_chunks = checked_add(telemetry.initial_chunks, short_len)?;
                flush_short(tokenizer, &short, &mut short_len, output);
                #[cfg(test)]
                {
                    telemetry.short_flushes = checked_add(telemetry.short_flushes, 1)?;
                }
            }
            continue;
        }

        if short_len != 0 {
            telemetry.initial_chunks = checked_add(telemetry.initial_chunks, short_len)?;
            flush_short(tokenizer, &short, &mut short_len, output);
            #[cfg(test)]
            {
                telemetry.short_flushes = checked_add(telemetry.short_flushes, 1)?;
            }
        }
        let encoded = encode_overlap(
            pretoken.as_ref(),
            omega,
            ChunkConfig {
                chunk_size: Some(chunk_size),
            },
            false,
            |bytes| {
                let mut ids = Vec::new();
                tokenizer
                    .memoized_encode_flat(SpanIter(std::iter::once(Pretoken(bytes))), &mut ids);
                Ok(ids)
            },
            token_length,
        )?;
        telemetry.engaged_pretokens = checked_add(
            telemetry.engaged_pretokens,
            usize::from(encoded.initial_chunks > 1),
        )?;
        telemetry.initial_chunks = checked_add(telemetry.initial_chunks, encoded.initial_chunks)?;
        telemetry.enlargements = checked_add(telemetry.enlargements, encoded.enlargements)?;
        output.extend(encoded.ids);
    }
    if short_len != 0 {
        telemetry.initial_chunks = checked_add(telemetry.initial_chunks, short_len)?;
        flush_short(tokenizer, &short, &mut short_len, output);
        #[cfg(test)]
        {
            telemetry.short_flushes = checked_add(telemetry.short_flushes, 1)?;
        }
    }
    Ok(())
}

fn flush_short<'a>(
    tokenizer: &mut Tokenizer,
    short: &[Option<Pretoken<'a>>; PRETOKEN_CHUNK],
    short_len: &mut usize,
    output: &mut Vec<u32>,
) {
    if *short_len == 0 {
        return;
    }
    tokenizer.memoized_encode_flat(
        SpanIter(short[..*short_len].iter().flatten().copied()),
        output,
    );
    *short_len = 0;
}

fn checked_add(left: usize, right: usize) -> Result<usize, ChunkStreamError> {
    left.checked_add(right)
        .ok_or(ChunkStreamError::CounterOverflow)
}

fn to_u32(value: usize) -> Result<u32, ChunkStreamError> {
    u32::try_from(value).map_err(|_| ChunkStreamError::CounterOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bpe::tiktoken::AddedTokenDef;
    use crate::pretokenize::PretokenizerType;
    use crate::token::TokenId;
    use rustc_hash::FxBuildHasher;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn tokenizer_with_reserved() -> (Tokenizer, Vec<usize>) {
        let mut vocab = (0_u8..=255).map(|byte| vec![byte]).collect::<Vec<_>>();
        vocab.push(b"ab".to_vec());
        vocab.push(b"<x>".to_vec());
        let mut merges = HashMap::with_hasher(FxBuildHasher);
        merges.insert(
            (TokenId::from(b'a' as u32), TokenId::from(b'b' as u32)),
            TokenId::from(256),
        );
        let lengths = vocab.iter().map(Vec::len).collect();
        let mut tokenizer = Tokenizer::new(merges, vocab, None);
        tokenizer.set_pretokenizer_type(PretokenizerType::GPT4);
        tokenizer.set_added_tokens(vec![AddedTokenDef {
            content: Arc::from(b"<x>".as_slice()),
            id: TokenId::from(257),
            lstrip: false,
            rstrip: false,
        }]);
        (tokenizer, lengths)
    }

    #[test]
    fn preserves_reserved_segmentation() {
        let (mut tokenizer, lengths) = tokenizer_with_reserved();
        let mut expected = Vec::new();
        tokenizer.encode_with_added_tokens_flat(b"ab<x>ab", &mut expected);
        let mut actual = Vec::new();
        let telemetry = encode_chunked_streaming(
            &mut tokenizer,
            |id| {
                lengths
                    .get(id as usize)
                    .copied()
                    .filter(|length| *length != 0)
            },
            3,
            b"ab<x>ab",
            6,
            &mut actual,
        )
        .unwrap();
        assert_eq!(actual, expected);
        assert!(actual.contains(&257));
        assert_eq!(telemetry.engaged_pretokens, 0);
    }

    #[test]
    fn engages_long_pretoken_and_batches_short_input() {
        let (mut tokenizer, lengths) = tokenizer_with_reserved();
        let mut long_expected = Vec::new();
        let long = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        tokenizer.encode_with_added_tokens_flat(long, &mut long_expected);
        let mut long_actual = Vec::new();
        let telemetry = encode_chunked_streaming(
            &mut tokenizer,
            |id| {
                lengths
                    .get(id as usize)
                    .copied()
                    .filter(|length| *length != 0)
            },
            3,
            long,
            6,
            &mut long_actual,
        )
        .unwrap();
        assert_eq!(long_actual, long_expected);
        assert_eq!(telemetry.engaged_pretokens, 1);
        assert!(telemetry.initial_chunks > 1);

        let short = "a ".repeat(PRETOKEN_CHUNK + 32);
        let mut short_expected = Vec::new();
        tokenizer.encode_with_added_tokens_flat(short.as_bytes(), &mut short_expected);
        let mut short_actual = Vec::new();
        let telemetry = encode_chunked_streaming(
            &mut tokenizer,
            |id| {
                lengths
                    .get(id as usize)
                    .copied()
                    .filter(|length| *length != 0)
            },
            3,
            short.as_bytes(),
            6,
            &mut short_actual,
        )
        .unwrap();
        assert_eq!(short_actual, short_expected);
        assert!(telemetry.pretokens > PRETOKEN_CHUNK);
        assert_eq!(telemetry.engaged_pretokens, 0);
        assert_eq!(telemetry.short_flushes, 2);
    }
}
