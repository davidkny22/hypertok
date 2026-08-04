use crate::bpe::Tokenizer;
use crate::pretokenize::PretokenizerType;
use eyre::{Context, Result, ensure};

fn parse_ranks(data: &[u8]) -> Result<Vec<Vec<u8>>> {
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::prelude::*;

    let text = std::str::from_utf8(data).context("tiktoken ranks are not valid UTF-8")?;
    text.lines()
        .enumerate()
        .map(|(i, line)| {
            let (base64_token, id_str) = line
                .split_once(' ')
                .ok_or_else(|| eyre::eyre!("line {i} has no rank field"))?;
            let id = id_str.trim().parse::<u32>()?;
            ensure!(id == i as u32, "rank {id} at line {i}: ranks must be dense");
            Ok(BASE64_STANDARD.decode(base64_token)?)
        })
        .collect()
}

/// Load a tokenizer from in-memory `.tiktoken` rank bytes.
pub fn load_tiktoken_slice(
    data: &[u8],
    pretokenizer: PretokenizerType,
    special_tokens: Vec<(String, u32)>,
) -> Result<Tokenizer> {
    let rank_vocab = parse_ranks(data)?;
    let n_ranks = rank_vocab.len() as u32;
    let mut tokenizer = Tokenizer::from_ranks(rank_vocab)?;
    tokenizer.set_pretokenizer_type(pretokenizer);
    for (content, id) in &special_tokens {
        ensure!(
            *id >= n_ranks,
            "special token {content:?} (id {id}) overlaps the {n_ranks} mergeable ranks"
        );
    }
    tokenizer.add_special_tokens(
        special_tokens
            .into_iter()
            .map(|(content, id)| (content.into_bytes(), id.into())),
    );
    Ok(tokenizer)
}
