use crate::bpe::Tokenizer;
use crate::token::TokenId;
#[cfg(feature = "opt-decode-direct-gather")]
use std::fmt::{Display, Formatter};

pub(crate) fn gather(tokenizer: &Tokenizer, ids: &[u32]) -> Vec<u8> {
    let ids = ids.iter().copied().map(TokenId::from).collect::<Vec<_>>();
    tokenizer.decode(&ids).collect()
}

#[cfg(feature = "opt-decode-direct-gather")]
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum DirectGatherError {
    UnknownTokenId(u32),
    OutputLengthOverflow,
    OutputAllocationFailed,
}

#[cfg(feature = "opt-decode-direct-gather")]
impl Display for DirectGatherError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownTokenId(id) => write!(formatter, "unknown token id {id}"),
            Self::OutputLengthOverflow => formatter.write_str("decoded output length overflow"),
            Self::OutputAllocationFailed => formatter.write_str("decoded output allocation failed"),
        }
    }
}

#[cfg(feature = "opt-decode-direct-gather")]
pub(crate) fn checked_output_length(
    ids: &[u32],
    mut token_length: impl FnMut(u32) -> Option<usize>,
) -> Result<usize, DirectGatherError> {
    let mut output_len = 0_usize;
    for &id in ids {
        let length = token_length(id).ok_or(DirectGatherError::UnknownTokenId(id))?;
        output_len = output_len
            .checked_add(length)
            .ok_or(DirectGatherError::OutputLengthOverflow)?;
    }
    Ok(output_len)
}

#[cfg(feature = "opt-decode-direct-gather")]
pub(crate) fn gather_direct(
    tokenizer: &Tokenizer,
    ids: &[u32],
    output_len: usize,
) -> Result<Vec<u8>, DirectGatherError> {
    let mut output = Vec::new();
    output
        .try_reserve_exact(output_len)
        .map_err(|_| DirectGatherError::OutputAllocationFailed)?;
    for &id in ids {
        let bytes = tokenizer
            .decode_token_bytes(id)
            .expect("token id was validated during exact sizing");
        output.extend_from_slice(bytes);
    }
    debug_assert_eq!(output.len(), output_len);
    Ok(output)
}

#[cfg(all(test, feature = "opt-decode-direct-gather"))]
mod tests {
    use super::{DirectGatherError, checked_output_length, gather, gather_direct};
    use crate::bpe::Tokenizer;
    use std::collections::HashMap;

    fn tokenizer() -> Tokenizer {
        Tokenizer::new(
            HashMap::default(),
            vec![b"a".to_vec(), b"bc".to_vec(), Vec::new(), b"def".to_vec()],
            None,
        )
    }

    #[test]
    fn direct_gather_matches_iterator_refuge() {
        let tokenizer = tokenizer();
        for ids in [vec![], vec![0], vec![1, 0, 3], vec![3, 3, 1, 0]] {
            let output_len = checked_output_length(&ids, |id| {
                tokenizer.decode_token_bytes(id).map(<[u8]>::len)
            })
            .unwrap();
            assert_eq!(
                gather_direct(&tokenizer, &ids, output_len).unwrap(),
                gather(&tokenizer, &ids),
            );
        }
    }

    #[test]
    fn direct_gather_reports_the_first_unknown_id() {
        let tokenizer = tokenizer();
        let error = checked_output_length(&[0, 2, 9], |id| {
            tokenizer.decode_token_bytes(id).map(<[u8]>::len)
        })
        .unwrap_err();
        assert_eq!(error, DirectGatherError::UnknownTokenId(2));
        assert_eq!(error.to_string(), "unknown token id 2");
    }

    #[test]
    fn exact_size_addition_refuses_overflow() {
        assert_eq!(
            checked_output_length(&[0, 1], |id| Some(if id == 0 { usize::MAX } else { 1 })),
            Err(DirectGatherError::OutputLengthOverflow),
        );
    }
}
