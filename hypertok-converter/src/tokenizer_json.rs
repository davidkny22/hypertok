use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use hypertok_format::{
    BYTE_BPE_EXHAUSTIVE_SPLITS_FLAG, DecoderStepKind, HashScheme, MAX_VOCAB_SIZE, NamedPattern,
    NormStepKind, PostPosition, PretokStepKind, SectionId, StructuralClass, ValidatedFile,
    encode_u32,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{Conversion, Document, Section, WriteError, write};

#[derive(Debug)]
pub enum JsonConversionError {
    SourceDigestMismatch,
    Json(String),
    Unsupported(&'static str),
    InvalidVocabulary(&'static str),
    InvalidId(u32),
    InvalidByteFallback(String),
    InvalidMerge(usize),
    MissingMergeProduct(u32),
    DuplicateBase(u32),
    SizeOverflow,
    Write(WriteError),
    RoundTrip(u32),
}

impl fmt::Display for JsonConversionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SourceDigestMismatch => {
                formatter.write_str("source SHA-256 does not match the pinned digest")
            }
            Self::Json(error) => write!(formatter, "tokenizer JSON is invalid: {error}"),
            Self::Unsupported(field) => {
                write!(formatter, "tokenizer field is not representable: {field}")
            }
            Self::InvalidVocabulary(reason) => {
                write!(formatter, "tokenizer vocabulary is invalid: {reason}")
            }
            Self::InvalidId(id) => write!(formatter, "tokenizer references invalid id {id}"),
            Self::InvalidByteFallback(token) => {
                write!(formatter, "invalid byte-fallback token {token}")
            }
            Self::InvalidMerge(index) => write!(formatter, "merge {index} is invalid"),
            Self::MissingMergeProduct(id) => write!(
                formatter,
                "non-base token id {id} is not produced by a merge"
            ),
            Self::DuplicateBase(codepoint) => {
                write!(formatter, "codepoint {codepoint} has duplicate base tokens")
            }
            Self::SizeOverflow => {
                formatter.write_str("converted vocabulary size overflows an addressable field")
            }
            Self::Write(error) => write!(formatter, "format emission failed: {error}"),
            Self::RoundTrip(id) => {
                write!(formatter, "emitted mapping disagrees with source id {id}")
            }
        }
    }
}

impl std::error::Error for JsonConversionError {}

pub fn convert_tokenizer_json(
    source: &[u8],
    expected_source_digest: [u8; 32],
) -> Result<Conversion, JsonConversionError> {
    let digest: [u8; 32] = Sha256::digest(source).into();
    if digest != expected_source_digest {
        return Err(JsonConversionError::SourceDigestMismatch);
    }
    let parsed: Tokenizer = serde_json::from_slice(source)
        .map_err(|error| JsonConversionError::Json(error.to_string()))?;
    validate_common_envelope(&parsed)?;
    if parsed.model.byte_fallback {
        convert_sentencepiece(parsed)
    } else {
        convert_byte_bpe(parsed)
    }
}

fn convert_sentencepiece(parsed: Tokenizer) -> Result<Conversion, JsonConversionError> {
    validate_sentencepiece_envelope(&parsed)?;

    let vocab_size =
        u32::try_from(parsed.model.vocab.len()).map_err(|_| JsonConversionError::SizeOverflow)?;
    if vocab_size > MAX_VOCAB_SIZE {
        return Err(JsonConversionError::SizeOverflow);
    }
    let mut token_strings = vec![None; vocab_size as usize];
    for (token, id) in &parsed.model.vocab {
        let slot = token_strings
            .get_mut(*id as usize)
            .ok_or(JsonConversionError::InvalidId(*id))?;
        if slot.replace(token.as_str()).is_some() {
            return Err(JsonConversionError::InvalidId(*id));
        }
    }
    if token_strings.iter().any(Option::is_none) {
        return Err(JsonConversionError::InvalidVocabulary(
            "ids are not contiguous",
        ));
    }

    let specials = validate_sentencepiece_added_tokens(&parsed.added_tokens, &token_strings)?;
    let (byte_fallback, byte_fallback_ids) = derive_byte_fallback(&token_strings, &specials)?;
    let (base, base_ids) = derive_base(&token_strings, &specials, &byte_fallback_ids)?;
    let (priority, inversions, _) = derive_priority(
        &parsed.model.merges,
        &parsed.model.vocab,
        &specials,
        &byte_fallback_ids,
        &base_ids,
        vocab_size,
        false,
    )?;

    let mut slots = Vec::with_capacity(vocab_size as usize);
    for (id, token) in token_strings.iter().enumerate() {
        if let Some(byte) = byte_fallback_ids.get(&(id as u32)) {
            slots.push(vec![*byte]);
        } else {
            slots.push(token.expect("contiguous ids").as_bytes().to_vec());
        }
    }
    let omega = slots
        .iter()
        .map(Vec::len)
        .max()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(JsonConversionError::SizeOverflow)?;
    let mut arena = Vec::new();
    let mut lengths = Vec::with_capacity(slots.len());
    for token in &slots {
        encode_u32(
            u32::try_from(token.len()).map_err(|_| JsonConversionError::SizeOverflow)?,
            &mut lengths,
        );
        arena.extend_from_slice(token);
    }

    let normalizer = encode_normalizer(parsed.normalizer.as_ref().expect("validated normalizer"))?;
    let decoder = encode_decoder(parsed.decoder.as_ref().expect("validated decoder"))?;
    let post = encode_post(
        parsed
            .post_processor
            .as_ref()
            .expect("validated postprocessor"),
    )?;
    let special_section = encode_specials(&parsed.added_tokens)?;
    let unk = encode_unk(&parsed.model, &parsed.model.vocab)?;
    let mut sections = vec![
        Section::new(SectionId::Base, base),
        Section::new(SectionId::Arena, arena),
        Section::new(SectionId::Lengths, lengths),
        Section::new(SectionId::Specials, special_section),
        Section::new(SectionId::Pretok, 0_u32.to_le_bytes().to_vec()),
        Section::new(SectionId::Norm, normalizer),
        Section::new(SectionId::Decoder, decoder),
        Section::new(SectionId::Post, post),
        Section::new(SectionId::ByteFall, byte_fallback),
        Section::new(SectionId::Unk, unk),
    ];
    if inversions != 0 {
        sections.push(Section::new(SectionId::Priority, priority));
    }
    let bytes = write(&Document {
        structural_class: StructuralClass::SentencePieceBpe,
        hash_scheme: HashScheme::None,
        flags: 0,
        vocab_size,
        omega,
        sections,
    })
    .map_err(JsonConversionError::Write)?;
    verify_mapping(&bytes, &slots, &specials, &byte_fallback_ids)?;
    let file = ValidatedFile::read(&bytes)
        .map_err(|error| JsonConversionError::Write(WriteError::SelfValidation(error)))?;
    let embedded_digest = file.header().digest;
    let special_count =
        u32::try_from(specials.len()).map_err(|_| JsonConversionError::SizeOverflow)?;
    Ok(Conversion {
        bytes,
        source_token_count: vocab_size,
        special_token_count: special_count,
        vocab_size,
        key_set_size: vocab_size - special_count - 256,
        gap_count: 0,
        omega,
        digest: embedded_digest,
        priority_present: inversions != 0,
        priority_inversions: inversions,
    })
}

fn convert_byte_bpe(parsed: Tokenizer) -> Result<Conversion, JsonConversionError> {
    validate_byte_envelope(&parsed)?;
    let model_tokens = ordered_model_tokens(&parsed.model.vocab)?;
    let added_ids = validate_byte_added_tokens(&parsed.added_tokens, &model_tokens)?;

    let highest_id = parsed
        .added_tokens
        .iter()
        .map(|token| token.id)
        .chain(
            u32::try_from(model_tokens.len())
                .ok()
                .and_then(|size| size.checked_sub(1)),
        )
        .max()
        .ok_or(JsonConversionError::InvalidVocabulary("empty vocabulary"))?;
    let vocab_size = highest_id
        .checked_add(1)
        .ok_or(JsonConversionError::SizeOverflow)?;
    if vocab_size > MAX_VOCAB_SIZE {
        return Err(JsonConversionError::SizeOverflow);
    }

    let alias_to_byte = byte_alias_inverse();
    let mut slots = vec![None; vocab_size as usize];
    let mut lookup = BTreeMap::new();
    for (id, token) in model_tokens.iter().enumerate() {
        let id = id as u32;
        if added_ids.contains(&id) {
            continue;
        }
        let bytes = decode_byte_alias(token, &alias_to_byte)?;
        if lookup.insert(bytes.clone(), id).is_some() {
            return Err(JsonConversionError::InvalidVocabulary(
                "duplicate decoded-byte token",
            ));
        }
        slots[id as usize] = Some(bytes);
    }
    for token in &parsed.added_tokens {
        if token.content.is_empty() {
            return Err(JsonConversionError::InvalidVocabulary("empty added token"));
        }
        slots[token.id as usize] = Some(token.content.as_bytes().to_vec());
    }

    let (base, base_ids) = derive_byte_base(&slots, &added_ids)?;
    let (priority, inversions, non_products, exhaustive_splits) = derive_byte_priority(
        &parsed.model.merges,
        &parsed.model.vocab,
        &added_ids,
        &base_ids,
        vocab_size,
    )?;
    let pretok = encode_byte_pretokenizer(
        parsed
            .pre_tokenizer
            .as_ref()
            .expect("validated pretokenizer"),
    )?;
    let normalizer = encode_byte_normalizer(parsed.normalizer.as_ref())?;
    validate_byte_decoder(parsed.decoder.as_ref().expect("validated decoder"))?;
    let post = encode_byte_postprocessor(
        parsed
            .post_processor
            .as_ref()
            .expect("validated postprocessor"),
    )?;

    let mut arena = Vec::new();
    let mut lengths = Vec::with_capacity(slots.len());
    let mut omega = 0_u32;
    for token in &slots {
        let length = token.as_ref().map_or(0, Vec::len);
        let length = u32::try_from(length).map_err(|_| JsonConversionError::SizeOverflow)?;
        omega = omega.max(length);
        encode_u32(length, &mut lengths);
        if let Some(token) = token {
            arena.extend_from_slice(token);
        }
    }

    let mut sections = vec![
        Section::new(SectionId::Base, base),
        Section::new(SectionId::Arena, arena),
        Section::new(SectionId::Lengths, lengths),
        Section::new(SectionId::Specials, encode_specials(&parsed.added_tokens)?),
        Section::new(SectionId::Pretok, pretok),
        Section::new(SectionId::Decoder, 0_u32.to_le_bytes().to_vec()),
    ];
    if let Some(normalizer) = normalizer {
        sections.push(Section::new(SectionId::Norm, normalizer));
    }
    if let Some(affix) = encode_byte_affix(&parsed.model)? {
        sections.push(Section::new(SectionId::Affix, affix));
    }
    if let Some(post) = post {
        sections.push(Section::new(SectionId::Post, post));
    }
    if inversions != 0 || non_products != 0 || exhaustive_splits {
        sections.push(Section::new(SectionId::Priority, priority));
    }
    let bytes = write(&Document {
        structural_class: StructuralClass::ByteBpe,
        hash_scheme: HashScheme::None,
        flags: u8::from(parsed.model.ignore_merges)
            | if exhaustive_splits {
                BYTE_BPE_EXHAUSTIVE_SPLITS_FLAG
            } else {
                0
            },
        vocab_size,
        omega,
        sections,
    })
    .map_err(JsonConversionError::Write)?;
    verify_byte_mapping(&bytes, &slots, &lookup)?;
    let file = ValidatedFile::read(&bytes)
        .map_err(|error| JsonConversionError::Write(WriteError::SelfValidation(error)))?;
    let digest = file.header().digest;
    let source_token_count = u32::try_from(slots.iter().flatten().count())
        .map_err(|_| JsonConversionError::SizeOverflow)?;
    let special_token_count =
        u32::try_from(parsed.added_tokens.len()).map_err(|_| JsonConversionError::SizeOverflow)?;
    let key_set_size =
        u32::try_from(lookup.len()).map_err(|_| JsonConversionError::SizeOverflow)?;
    Ok(Conversion {
        bytes,
        source_token_count,
        special_token_count,
        vocab_size,
        key_set_size,
        gap_count: vocab_size - source_token_count,
        omega,
        digest,
        priority_present: inversions != 0 || non_products != 0 || exhaustive_splits,
        priority_inversions: inversions,
    })
}

fn ordered_model_tokens(vocab: &BTreeMap<String, u32>) -> Result<Vec<&str>, JsonConversionError> {
    let mut tokens = vec![None; vocab.len()];
    for (token, id) in vocab {
        let slot = tokens
            .get_mut(*id as usize)
            .ok_or(JsonConversionError::InvalidId(*id))?;
        if slot.replace(token.as_str()).is_some() {
            return Err(JsonConversionError::InvalidId(*id));
        }
    }
    tokens
        .into_iter()
        .map(|token| {
            token.ok_or(JsonConversionError::InvalidVocabulary(
                "model ids are not contiguous",
            ))
        })
        .collect()
}

fn validate_byte_added_tokens(
    added: &[AddedToken],
    model_tokens: &[&str],
) -> Result<BTreeSet<u32>, JsonConversionError> {
    let mut ids = BTreeSet::new();
    for token in added {
        if !ids.insert(token.id) {
            return Err(JsonConversionError::InvalidId(token.id));
        }
        if let Some(model_token) = model_tokens.get(token.id as usize)
            && *model_token != token.content
        {
            return Err(JsonConversionError::InvalidId(token.id));
        }
    }
    Ok(ids)
}

fn byte_alias_inverse() -> BTreeMap<char, u8> {
    let direct: BTreeSet<u8> = (b'!'..=b'~')
        .chain(0xA1..=0xAC)
        .chain(0xAE..=0xFF)
        .collect();
    let mut next = 0_u32;
    let mut inverse = BTreeMap::new();
    for byte in 0_u8..=u8::MAX {
        let scalar = if direct.contains(&byte) {
            u32::from(byte)
        } else {
            let scalar = 256 + next;
            next += 1;
            scalar
        };
        inverse.insert(
            char::from_u32(scalar).expect("byte alias is a scalar"),
            byte,
        );
    }
    inverse
}

fn decode_byte_alias(
    token: &str,
    inverse: &BTreeMap<char, u8>,
) -> Result<Vec<u8>, JsonConversionError> {
    token
        .chars()
        .map(|character| {
            inverse
                .get(&character)
                .copied()
                .ok_or(JsonConversionError::Unsupported(
                    "byte-level token alphabet",
                ))
        })
        .collect()
}

fn derive_byte_base(
    slots: &[Option<Vec<u8>>],
    added: &BTreeSet<u32>,
) -> Result<(Vec<u8>, BTreeSet<u32>), JsonConversionError> {
    let mut by_byte = [None; 256];
    let mut ids = BTreeSet::new();
    for (id, token) in slots.iter().enumerate() {
        let id = id as u32;
        if added.contains(&id) {
            continue;
        }
        if let Some(token) = token
            && let [byte] = token.as_slice()
        {
            if by_byte[*byte as usize].replace(id).is_some() {
                return Err(JsonConversionError::InvalidVocabulary(
                    "duplicate byte base",
                ));
            }
            ids.insert(id);
        }
    }
    let mut output = Vec::with_capacity(1024);
    for (byte, id) in by_byte.into_iter().enumerate() {
        let id = id.ok_or({
            JsonConversionError::InvalidVocabulary(if byte == 0 {
                "missing byte base"
            } else {
                "incomplete byte base"
            })
        })?;
        output.extend_from_slice(&id.to_le_bytes());
    }
    Ok((output, ids))
}

fn validate_byte_envelope(tokenizer: &Tokenizer) -> Result<(), JsonConversionError> {
    if tokenizer.pre_tokenizer.is_none()
        || tokenizer.decoder.is_none()
        || tokenizer.post_processor.is_none()
    {
        return Err(JsonConversionError::Unsupported(
            "pre_tokenizer, decoder, or post_processor",
        ));
    }
    if tokenizer.model.unk_token.is_some() || tokenizer.model.fuse_unk {
        return Err(JsonConversionError::Unsupported("byte-BPE unknown token"));
    }
    Ok(())
}

fn encode_byte_pretokenizer(pretokenizer: &PreTokenizer) -> Result<Vec<u8>, JsonConversionError> {
    let (pattern, add_prefix_space, trim_offsets, use_regex) = match pretokenizer {
        PreTokenizer::ByteLevel {
            add_prefix_space,
            trim_offsets,
            use_regex: true,
        } => (NamedPattern::Gpt2, *add_prefix_space, *trim_offsets, true),
        PreTokenizer::ByteLevel { .. } => {
            return Err(JsonConversionError::Unsupported(
                "ByteLevel pretokenizer without regex",
            ));
        }
        PreTokenizer::Sequence { pretokenizers } => {
            let Some((byte_level, split_steps)) = pretokenizers.split_last() else {
                return Err(JsonConversionError::Unsupported("empty pretokenizer"));
            };
            let PreTokenizer::ByteLevel {
                add_prefix_space,
                trim_offsets,
                use_regex,
            } = byte_level
            else {
                return Err(JsonConversionError::Unsupported(
                    "ByteLevel pretokenizer order",
                ));
            };
            if *use_regex {
                return Err(JsonConversionError::Unsupported(
                    "ByteLevel regex after named split",
                ));
            }
            let mut regexes = Vec::with_capacity(split_steps.len());
            for step in split_steps {
                let PreTokenizer::Split {
                    pattern,
                    behavior: SplitBehavior::Isolated,
                    invert,
                } = step
                else {
                    return Err(JsonConversionError::Unsupported("byte-BPE split sequence"));
                };
                if *invert {
                    return Err(JsonConversionError::Unsupported("inverted split"));
                }
                regexes.push(pattern.regex());
            }
            let pattern = identify_named_pattern(&regexes)
                .ok_or(JsonConversionError::Unsupported("named split pattern"))?;
            (pattern, *add_prefix_space, *trim_offsets, *use_regex)
        }
        _ => {
            return Err(JsonConversionError::Unsupported(
                "byte-BPE pretokenizer root",
            ));
        }
    };
    let flags =
        u8::from(add_prefix_space) | (u8::from(trim_offsets) << 1) | (u8::from(use_regex) << 2);
    let mut output = 2_u32.to_le_bytes().to_vec();
    output.push(PretokStepKind::NamedPattern.value());
    output.extend_from_slice(&pattern.value().to_le_bytes());
    output.push(PretokStepKind::ByteLevel.value());
    output.push(flags);
    Ok(output)
}

fn identify_named_pattern(regexes: &[&str]) -> Option<NamedPattern> {
    const LLAMA3_CL100K: &str = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";
    const QWEN35: &str = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";
    const NEMOTRON: &str = r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+";
    const DEEPSEEK: [&str; 3] = [
        r"\p{N}{1,3}",
        "[\u{4e00}-\u{9fa5}\u{3040}-\u{309f}\u{30a0}-\u{30ff}]+",
        "[!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+|[^\r\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+| ?[\\p{P}\\p{S}]+[\r\n]*|\\s*[\r\n]+|\\s+(?!\\S)|\\s+",
    ];
    match regexes {
        [value] if *value == LLAMA3_CL100K => Some(NamedPattern::Cl100kBase),
        [value] if *value == QWEN35 => Some(NamedPattern::Qwen35),
        [value] if *value == NEMOTRON => Some(NamedPattern::Nemotron),
        values if values == DEEPSEEK => Some(NamedPattern::DeepSeekV3),
        _ => None,
    }
}

fn encode_byte_normalizer(
    normalizer: Option<&Normalizer>,
) -> Result<Option<Vec<u8>>, JsonConversionError> {
    match normalizer {
        None => Ok(None),
        Some(Normalizer::Nfc) => {
            let mut output = 1_u32.to_le_bytes().to_vec();
            output.push(NormStepKind::Nfc.value());
            Ok(Some(output))
        }
        Some(Normalizer::Sequence { normalizers }) if normalizers.is_empty() => {
            Ok(Some(0_u32.to_le_bytes().to_vec()))
        }
        Some(_) => Err(JsonConversionError::Unsupported("byte-BPE normalizer")),
    }
}

fn validate_byte_decoder(decoder: &Decoder) -> Result<(), JsonConversionError> {
    let Decoder::ByteLevel {
        add_prefix_space,
        trim_offsets,
        use_regex,
    } = decoder
    else {
        return Err(JsonConversionError::Unsupported("byte-BPE decoder"));
    };
    let _ = (add_prefix_space, trim_offsets, use_regex);
    Ok(())
}

fn validate_byte_level_postprocessor(post: &PostProcessor) -> Result<(), JsonConversionError> {
    let PostProcessor::ByteLevel {
        add_prefix_space,
        trim_offsets,
        use_regex,
    } = post
    else {
        return Err(JsonConversionError::Unsupported("byte-BPE postprocessor"));
    };
    let _ = (add_prefix_space, use_regex);
    if *trim_offsets {
        return Err(JsonConversionError::Unsupported(
            "ByteLevel postprocessor trim_offsets",
        ));
    }
    Ok(())
}

fn encode_byte_postprocessor(post: &PostProcessor) -> Result<Option<Vec<u8>>, JsonConversionError> {
    match post {
        PostProcessor::ByteLevel { .. } => {
            validate_byte_level_postprocessor(post)?;
            Ok(None)
        }
        PostProcessor::Sequence { processors } => {
            let [byte_level, template] = processors.as_slice() else {
                return Err(JsonConversionError::Unsupported(
                    "byte-BPE postprocessor sequence",
                ));
            };
            validate_byte_level_postprocessor(byte_level)?;
            if !matches!(template, PostProcessor::TemplateProcessing { .. }) {
                return Err(JsonConversionError::Unsupported(
                    "byte-BPE postprocessor sequence order",
                ));
            }
            Ok(Some(encode_post(template)?))
        }
        PostProcessor::TemplateProcessing { .. } => {
            Err(JsonConversionError::Unsupported("byte-BPE postprocessor"))
        }
    }
}

fn encode_byte_affix(model: &Model) -> Result<Option<Vec<u8>>, JsonConversionError> {
    match (
        model.continuing_subword_prefix.as_deref(),
        model.end_of_word_suffix.as_deref(),
    ) {
        (None, None) => Ok(None),
        (Some(""), Some("")) => {
            let mut output = Vec::with_capacity(8);
            write_string(&mut output, "")?;
            write_string(&mut output, "")?;
            Ok(Some(output))
        }
        _ => Err(JsonConversionError::Unsupported("byte-BPE subword affix")),
    }
}

fn validate_common_envelope(tokenizer: &Tokenizer) -> Result<(), JsonConversionError> {
    if tokenizer.version != "1.0" {
        return Err(JsonConversionError::Unsupported("version"));
    }
    if tokenizer.truncation.is_some() || tokenizer.padding.is_some() {
        return Err(JsonConversionError::Unsupported("truncation or padding"));
    }
    if tokenizer
        .model
        .kind
        .as_deref()
        .is_some_and(|kind| kind != "BPE")
        || tokenizer.model.dropout.is_some()
    {
        return Err(JsonConversionError::Unsupported("model type or dropout"));
    }
    Ok(())
}

fn validate_sentencepiece_envelope(tokenizer: &Tokenizer) -> Result<(), JsonConversionError> {
    if tokenizer.pre_tokenizer.is_some() {
        return Err(JsonConversionError::Unsupported("pre_tokenizer"));
    }
    if tokenizer.normalizer.is_none()
        || tokenizer.decoder.is_none()
        || tokenizer.post_processor.is_none()
    {
        return Err(JsonConversionError::Unsupported(
            "normalizer, decoder, or post_processor",
        ));
    }
    if tokenizer.model.continuing_subword_prefix.is_some()
        || tokenizer.model.end_of_word_suffix.is_some()
    {
        return Err(JsonConversionError::Unsupported("subword affix"));
    }
    Ok(())
}

fn validate_sentencepiece_added_tokens(
    added: &[AddedToken],
    tokens: &[Option<&str>],
) -> Result<BTreeSet<u32>, JsonConversionError> {
    let mut ids = BTreeSet::new();
    for token in added {
        if !token.special {
            return Err(JsonConversionError::Unsupported("non-special added token"));
        }
        if tokens.get(token.id as usize).and_then(|value| *value) != Some(token.content.as_str()) {
            return Err(JsonConversionError::InvalidId(token.id));
        }
        if !ids.insert(token.id) {
            return Err(JsonConversionError::InvalidId(token.id));
        }
    }
    Ok(ids)
}

fn derive_byte_fallback(
    tokens: &[Option<&str>],
    specials: &BTreeSet<u32>,
) -> Result<(Vec<u8>, BTreeMap<u32, u8>), JsonConversionError> {
    let mut by_byte = [None; 256];
    let mut by_id = BTreeMap::new();
    for (id, token) in tokens.iter().enumerate() {
        if specials.contains(&(id as u32)) {
            continue;
        }
        let token = token.expect("contiguous ids");
        if let Some(hex) = token
            .strip_prefix("<0x")
            .and_then(|value| value.strip_suffix('>'))
        {
            if hex.len() != 2 {
                return Err(JsonConversionError::InvalidByteFallback(token.to_owned()));
            }
            let byte = u8::from_str_radix(hex, 16)
                .map_err(|_| JsonConversionError::InvalidByteFallback(token.to_owned()))?;
            if by_byte[byte as usize].replace(id as u32).is_some() {
                return Err(JsonConversionError::InvalidByteFallback(token.to_owned()));
            }
            by_id.insert(id as u32, byte);
        }
    }
    let mut output = Vec::with_capacity(1024);
    for (byte, id) in by_byte.into_iter().enumerate() {
        let id =
            id.ok_or_else(|| JsonConversionError::InvalidByteFallback(format!("<0x{byte:02X}>")))?;
        output.extend_from_slice(&id.to_le_bytes());
    }
    Ok((output, by_id))
}

fn derive_base(
    tokens: &[Option<&str>],
    specials: &BTreeSet<u32>,
    byte_fallback: &BTreeMap<u32, u8>,
) -> Result<(Vec<u8>, BTreeSet<u32>), JsonConversionError> {
    let mut entries = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for (id, token) in tokens.iter().enumerate() {
        let id = id as u32;
        if specials.contains(&id) || byte_fallback.contains_key(&id) {
            continue;
        }
        let mut chars = token.expect("contiguous ids").chars();
        if let (Some(value), None) = (chars.next(), chars.next()) {
            let codepoint = value as u32;
            if entries.insert(codepoint, id).is_some() {
                return Err(JsonConversionError::DuplicateBase(codepoint));
            }
            ids.insert(id);
        }
    }
    let mut output = Vec::with_capacity(4 + entries.len() * 8);
    output.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (codepoint, id) in entries {
        output.extend_from_slice(&codepoint.to_le_bytes());
        output.extend_from_slice(&id.to_le_bytes());
    }
    Ok((output, ids))
}

fn derive_priority(
    merges: &[Merge],
    vocab: &BTreeMap<String, u32>,
    specials: &BTreeSet<u32>,
    byte_fallback: &BTreeMap<u32, u8>,
    base: &BTreeSet<u32>,
    vocab_size: u32,
    allow_non_products: bool,
) -> Result<(Vec<u8>, u32, u32), JsonConversionError> {
    let mut priorities = vec![0_u32; vocab_size as usize];
    let mut previous = None;
    let mut inversions = 0_u32;
    for (index, merge) in merges.iter().enumerate() {
        let (left, right) = merge
            .parts()
            .ok_or(JsonConversionError::InvalidMerge(index))?;
        let id = *vocab
            .get(&format!("{left}{right}"))
            .ok_or(JsonConversionError::InvalidMerge(index))?;
        if previous.is_some_and(|value| id < value) {
            inversions += 1;
        }
        previous = Some(id);
        let priority = u32::try_from(index + 1).map_err(|_| JsonConversionError::SizeOverflow)?;
        let slot = &mut priorities[id as usize];
        if *slot == 0 || priority < *slot {
            *slot = priority;
        }
    }
    let mut non_products = 0_u32;
    for id in 0..vocab_size {
        if !specials.contains(&id)
            && !byte_fallback.contains_key(&id)
            && !base.contains(&id)
            && priorities[id as usize] == 0
        {
            if !allow_non_products {
                return Err(JsonConversionError::MissingMergeProduct(id));
            }
            non_products += 1;
        }
    }
    let mut output = Vec::new();
    for priority in priorities {
        encode_u32(priority, &mut output);
    }
    Ok((output, inversions, non_products))
}

fn derive_byte_priority(
    merges: &[Merge],
    vocab: &BTreeMap<String, u32>,
    specials: &BTreeSet<u32>,
    base: &BTreeSet<u32>,
    vocab_size: u32,
) -> Result<(Vec<u8>, u32, u32, bool), JsonConversionError> {
    let mut priorities = vec![0_u32; vocab_size as usize];
    let mut reachable = base.clone();
    let mut previous = None;
    let mut inversions = 0_u32;
    let mut duplicate_products = 0_u32;
    let mut source_pairs = BTreeSet::new();
    for (index, merge) in merges.iter().enumerate() {
        let (left, right) = merge
            .parts()
            .ok_or(JsonConversionError::InvalidMerge(index))?;
        let left_id = *vocab
            .get(left)
            .ok_or(JsonConversionError::InvalidMerge(index))?;
        let right_id = *vocab
            .get(right)
            .ok_or(JsonConversionError::InvalidMerge(index))?;
        let id = *vocab
            .get(&format!("{left}{right}"))
            .ok_or(JsonConversionError::InvalidMerge(index))?;
        if !source_pairs.insert((left_id, right_id, id)) {
            return Err(JsonConversionError::InvalidMerge(index));
        }
        if previous.is_some_and(|value| id < value) {
            inversions += 1;
        }
        previous = Some(id);
        if specials.contains(&id) || !reachable.contains(&left_id) || !reachable.contains(&right_id)
        {
            continue;
        }
        let priority = u32::try_from(index + 1).map_err(|_| JsonConversionError::SizeOverflow)?;
        let slot = &mut priorities[id as usize];
        if *slot != 0 {
            duplicate_products = duplicate_products
                .checked_add(1)
                .ok_or(JsonConversionError::SizeOverflow)?;
        } else {
            *slot = priority;
        }
        reachable.insert(id);
    }
    let non_products = (0..vocab_size)
        .filter(|id| !specials.contains(id) && !base.contains(id) && !reachable.contains(id))
        .count();
    let non_products =
        u32::try_from(non_products).map_err(|_| JsonConversionError::SizeOverflow)?;
    let exhaustive_splits = duplicate_products != 0;
    if exhaustive_splits {
        let mut expected_pairs = BTreeSet::new();
        for (token, &id) in vocab {
            for (offset, _) in token.char_indices().skip(1) {
                let (left, right) = token.split_at(offset);
                if let (Some(&left_id), Some(&right_id)) = (vocab.get(left), vocab.get(right)) {
                    expected_pairs.insert((left_id, right_id, id));
                }
            }
        }
        if source_pairs != expected_pairs {
            return Err(JsonConversionError::Unsupported(
                "duplicate-product merge coverage",
            ));
        }
    }
    let mut output = Vec::new();
    for priority in priorities {
        encode_u32(priority, &mut output);
    }
    Ok((output, inversions, non_products, exhaustive_splits))
}

fn encode_normalizer(normalizer: &Normalizer) -> Result<Vec<u8>, JsonConversionError> {
    let mut steps = Vec::new();
    flatten_normalizer(normalizer, &mut steps);
    let mut output = (steps.len() as u32).to_le_bytes().to_vec();
    for step in steps {
        match step {
            Normalizer::Prepend { prepend } => {
                output.push(NormStepKind::Prepend.value());
                write_string(&mut output, prepend)?;
            }
            Normalizer::Replace { pattern, content } => {
                output.push(NormStepKind::Replace.value());
                write_string(&mut output, pattern.as_string())?;
                write_string(&mut output, content)?;
            }
            Normalizer::Nfc => output.push(NormStepKind::Nfc.value()),
            Normalizer::Sequence { .. } => unreachable!("sequence flattened"),
        }
    }
    Ok(output)
}

fn flatten_normalizer<'a>(normalizer: &'a Normalizer, output: &mut Vec<&'a Normalizer>) {
    match normalizer {
        Normalizer::Sequence { normalizers } => {
            for step in normalizers {
                flatten_normalizer(step, output);
            }
        }
        _ => output.push(normalizer),
    }
}

fn encode_decoder(decoder: &Decoder) -> Result<Vec<u8>, JsonConversionError> {
    let Decoder::Sequence { decoders } = decoder else {
        return Err(JsonConversionError::Unsupported("decoder root"));
    };
    let mut output = (decoders.len() as u32).to_le_bytes().to_vec();
    for step in decoders {
        match step {
            Decoder::Replace { pattern, content } => {
                output.push(DecoderStepKind::Replace.value());
                write_string(&mut output, pattern.as_string())?;
                write_string(&mut output, content)?;
            }
            Decoder::ByteFallback => output.push(DecoderStepKind::ByteFallback.value()),
            Decoder::Fuse => output.push(DecoderStepKind::Fuse.value()),
            Decoder::Strip {
                content,
                start,
                stop,
            } => {
                let mut chars = content.chars();
                let scalar = match (chars.next(), chars.next()) {
                    (Some(value), None) => value as u32,
                    _ => return Err(JsonConversionError::Unsupported("decoder strip content")),
                };
                output.push(DecoderStepKind::Strip.value());
                output.extend_from_slice(&scalar.to_le_bytes());
                output.extend_from_slice(&start.to_le_bytes());
                output.extend_from_slice(&stop.to_le_bytes());
            }
            Decoder::Sequence { .. } => {
                return Err(JsonConversionError::Unsupported("nested decoder"));
            }
            Decoder::ByteLevel { .. } => {
                return Err(JsonConversionError::Unsupported("byte-level decoder"));
            }
        }
    }
    Ok(output)
}

fn encode_post(post: &PostProcessor) -> Result<Vec<u8>, JsonConversionError> {
    let PostProcessor::TemplateProcessing {
        single,
        pair,
        special_tokens,
    } = post
    else {
        return Err(JsonConversionError::Unsupported("byte-level postprocessor"));
    };
    validate_pair_template(pair)?;
    let sequence = single
        .iter()
        .position(|piece| matches!(piece, TemplatePiece::Sequence { id, type_id: 0 } if id == "A"))
        .ok_or(JsonConversionError::Unsupported(
            "single postprocessor sequence",
        ))?;
    let mut markers = Vec::new();
    for (index, piece) in single.iter().enumerate() {
        if let TemplatePiece::SpecialToken { id, type_id } = piece {
            if *type_id != 0 {
                return Err(JsonConversionError::Unsupported(
                    "single postprocessor type id",
                ));
            }
            let token = special_tokens
                .get(id)
                .ok_or(JsonConversionError::Unsupported("postprocessor special"))?;
            if token.id != *id || token.ids.len() != 1 || token.tokens.as_slice() != [id.as_str()] {
                return Err(JsonConversionError::Unsupported(
                    "postprocessor special mapping",
                ));
            }
            let position = if index < sequence {
                PostPosition::Prepend
            } else {
                PostPosition::Append
            };
            markers.push((position, token.ids[0]));
        }
    }
    let mut output = (markers.len() as u32).to_le_bytes().to_vec();
    for (position, id) in markers {
        output.push(position.value());
        output.extend_from_slice(&id.to_le_bytes());
    }
    Ok(output)
}

fn validate_pair_template(pair: &[TemplatePiece]) -> Result<(), JsonConversionError> {
    if pair.len() != 4
        || !matches!(&pair[0], TemplatePiece::SpecialToken { type_id: 0, .. })
        || !matches!(&pair[1], TemplatePiece::Sequence { id, type_id: 0 } if id == "A")
        || !matches!(&pair[2], TemplatePiece::SpecialToken { type_id: 1, .. })
        || !matches!(&pair[3], TemplatePiece::Sequence { id, type_id: 1 } if id == "B")
    {
        return Err(JsonConversionError::Unsupported(
            "pair postprocessor template",
        ));
    }
    Ok(())
}

fn encode_specials(added: &[AddedToken]) -> Result<Vec<u8>, JsonConversionError> {
    let mut entries: Vec<_> = added.iter().collect();
    entries.sort_unstable_by_key(|token| token.id);
    let mut output = (entries.len() as u32).to_le_bytes().to_vec();
    for token in entries {
        output.extend_from_slice(&token.id.to_le_bytes());
        write_string(&mut output, &token.content)?;
        let flags = u32::from(token.lstrip)
            | (u32::from(token.rstrip) << 1)
            | (u32::from(token.single_word) << 2)
            | (u32::from(token.normalized) << 3);
        output.extend_from_slice(&flags.to_le_bytes());
    }
    for token in added {
        output.extend_from_slice(&token.id.to_le_bytes());
    }
    Ok(output)
}

fn encode_unk(
    model: &Model,
    vocab: &BTreeMap<String, u32>,
) -> Result<Vec<u8>, JsonConversionError> {
    let token = model
        .unk_token
        .as_ref()
        .ok_or(JsonConversionError::Unsupported("unk_token"))?;
    let id = *vocab
        .get(token)
        .ok_or(JsonConversionError::Unsupported("unk_token id"))?;
    let mut output = id.to_le_bytes().to_vec();
    output.push(u8::from(model.fuse_unk));
    Ok(output)
}

fn write_string(output: &mut Vec<u8>, value: &str) -> Result<(), JsonConversionError> {
    let length = u32::try_from(value.len()).map_err(|_| JsonConversionError::SizeOverflow)?;
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn verify_mapping(
    bytes: &[u8],
    expected: &[Vec<u8>],
    specials: &BTreeSet<u32>,
    byte_fallback: &BTreeMap<u32, u8>,
) -> Result<(), JsonConversionError> {
    let file = ValidatedFile::read(bytes)
        .map_err(|error| JsonConversionError::Write(WriteError::SelfValidation(error)))?;
    let mut source_lookup = BTreeMap::new();
    let mut emitted_lookup = BTreeMap::new();
    for (id, token) in file.tokens() {
        if token != expected[id as usize] {
            return Err(JsonConversionError::RoundTrip(id));
        }
        if !specials.contains(&id)
            && !byte_fallback.contains_key(&id)
            && (source_lookup
                .insert(expected[id as usize].as_slice(), id)
                .is_some()
                || emitted_lookup.insert(token, id).is_some())
        {
            return Err(JsonConversionError::RoundTrip(id));
        }
    }
    if source_lookup != emitted_lookup {
        return Err(JsonConversionError::InvalidVocabulary(
            "bytes-to-id mapping changed during round-trip",
        ));
    }
    Ok(())
}

fn verify_byte_mapping(
    bytes: &[u8],
    expected: &[Option<Vec<u8>>],
    source_lookup: &BTreeMap<Vec<u8>, u32>,
) -> Result<(), JsonConversionError> {
    let file = ValidatedFile::read(bytes)
        .map_err(|error| JsonConversionError::Write(WriteError::SelfValidation(error)))?;
    let mut emitted_lookup = BTreeMap::new();
    for (id, token) in file.tokens() {
        let source = expected[id as usize].as_deref().unwrap_or_default();
        if token != source {
            return Err(JsonConversionError::RoundTrip(id));
        }
        if source_lookup.get(token) == Some(&id) {
            emitted_lookup.insert(token.to_vec(), id);
        }
    }
    if &emitted_lookup != source_lookup {
        return Err(JsonConversionError::InvalidVocabulary(
            "bytes-to-id mapping changed during round-trip",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tokenizer {
    version: String,
    truncation: Option<serde_json::Value>,
    padding: Option<serde_json::Value>,
    added_tokens: Vec<AddedToken>,
    normalizer: Option<Normalizer>,
    pre_tokenizer: Option<PreTokenizer>,
    post_processor: Option<PostProcessor>,
    decoder: Option<Decoder>,
    model: Model,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Model {
    #[serde(rename = "type")]
    #[serde(default)]
    kind: Option<String>,
    dropout: Option<f64>,
    unk_token: Option<String>,
    continuing_subword_prefix: Option<String>,
    end_of_word_suffix: Option<String>,
    fuse_unk: bool,
    byte_fallback: bool,
    #[serde(default)]
    ignore_merges: bool,
    vocab: BTreeMap<String, u32>,
    merges: Vec<Merge>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddedToken {
    id: u32,
    content: String,
    single_word: bool,
    lstrip: bool,
    rstrip: bool,
    normalized: bool,
    special: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Normalizer {
    Sequence {
        normalizers: Vec<Normalizer>,
    },
    Prepend {
        prepend: String,
    },
    Replace {
        pattern: StringPattern,
        content: String,
    },
    #[serde(rename = "NFC")]
    Nfc,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Merge {
    String(String),
    Pair([String; 2]),
}

impl Merge {
    fn parts(&self) -> Option<(&str, &str)> {
        match self {
            Self::String(value) => value.split_once(' '),
            Self::Pair([left, right]) => Some((left, right)),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum PreTokenizer {
    Sequence {
        pretokenizers: Vec<PreTokenizer>,
    },
    Split {
        pattern: SplitPattern,
        behavior: SplitBehavior,
        invert: bool,
    },
    ByteLevel {
        add_prefix_space: bool,
        trim_offsets: bool,
        use_regex: bool,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
enum SplitPattern {
    Regex(String),
}

impl SplitPattern {
    fn regex(&self) -> &str {
        match self {
            Self::Regex(value) => value,
        }
    }
}

#[derive(Deserialize)]
enum SplitBehavior {
    Isolated,
}

#[derive(Deserialize)]
enum StringPattern {
    String(String),
}

impl StringPattern {
    fn as_string(&self) -> &str {
        match self {
            Self::String(value) => value,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Decoder {
    Sequence {
        decoders: Vec<Decoder>,
    },
    Replace {
        pattern: StringPattern,
        content: String,
    },
    ByteFallback,
    Fuse,
    Strip {
        content: String,
        start: u32,
        stop: u32,
    },
    ByteLevel {
        add_prefix_space: bool,
        trim_offsets: bool,
        use_regex: bool,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum PostProcessor {
    Sequence {
        processors: Vec<PostProcessor>,
    },
    TemplateProcessing {
        single: Vec<TemplatePiece>,
        pair: Vec<TemplatePiece>,
        special_tokens: BTreeMap<String, PostSpecial>,
    },
    ByteLevel {
        add_prefix_space: bool,
        trim_offsets: bool,
        use_regex: bool,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
enum TemplatePiece {
    SpecialToken { id: String, type_id: u32 },
    Sequence { id: String, type_id: u32 },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PostSpecial {
    id: String,
    ids: Vec<u32>,
    tokens: Vec<String>,
}
