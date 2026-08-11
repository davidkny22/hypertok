use crate::bpe::Tokenizer;
#[cfg(feature = "decode-profiling")]
use crate::decode_profiling::{DecodeProfileClock, DecodeProfileSnapshot};
#[cfg(feature = "source-loaders")]
use crate::load_tokenizer::hf::{HfTokenizer, load_hf_slice};
#[cfg(feature = "opt-resolver-provenance")]
use crate::load_tokenizer::htk::load_resolver_trusted_htk_slice;
#[cfg(feature = "htk")]
use crate::load_tokenizer::htk::{HtkTokenizer, LoadedHtk, load_htk_slice};
#[cfg(feature = "htk")]
use crate::load_tokenizer::htk_chunk::{
    ChunkConfig, OverlapReconciliation, encode_overlap, overlap_ranges,
};
#[cfg(all(feature = "htk", feature = "opt-chunk-prescan"))]
use crate::load_tokenizer::htk_chunk_stream::encode_chunked_streaming;
#[cfg(feature = "htk")]
use crate::load_tokenizer::htk_reserved::{
    HtkReservedCatalog, HtkReservedDefinition, HtkReservedPolicy,
};
#[cfg(feature = "htk")]
use crate::load_tokenizer::htk_worker::{HtkWorkerEncoder, HtkWorkerModel};
#[cfg(feature = "source-loaders")]
use crate::load_tokenizer::tiktoken_slice::load_tiktoken_slice;
#[cfg(feature = "source-loaders")]
use crate::pretokenize::PretokenizerType;
#[cfg(feature = "htk")]
use crate::pretokenize::{Pretoken, SpanIter};
#[cfg(feature = "profiling")]
use crate::profiling::ProfileSnapshot;
#[cfg(feature = "htk")]
use crate::token::TokenId;
#[cfg(feature = "opt-decode-borrowed-output")]
use crate::wasm_borrowed_output::BorrowedDecodeOutput;
#[cfg(feature = "opt-decode-boundary")]
use crate::wasm_resident_ids::ResidentIds;
#[cfg(feature = "opt-marshalling")]
use crate::wasm_resident_input::ResidentInput;
#[cfg(feature = "opt-encode-into")]
use crate::wasm_resident_output::ResidentOutput;
#[cfg(feature = "opt-scratch-reuse")]
use crate::wasm_scratch::WasmScratch;
#[cfg(feature = "htk")]
use rustc_hash::FxBuildHasher;
#[cfg(feature = "htk")]
use std::collections::HashMap;
#[cfg(feature = "htk")]
use std::ops::Range;
#[cfg(feature = "htk")]
use std::sync::Arc;
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

/// Unthreaded byte-level tokenizer exposed to JavaScript.
#[wasm_bindgen]
pub struct WasmTokenizer {
    tokenizer: Tokenizer,
    #[cfg(feature = "decode-profiling")]
    last_decode_profile: Option<DecodeProfileSnapshot>,
    #[cfg(feature = "decode-profiling")]
    decode_profiling_enabled: bool,
    #[cfg(feature = "profiling")]
    last_profile: Option<ProfileSnapshot>,
    #[cfg(feature = "profiling")]
    profile_sequence: u64,
    #[cfg(feature = "opt-marshalling")]
    resident_input: ResidentInput,
    #[cfg(feature = "opt-decode-boundary")]
    resident_decode_ids: ResidentIds,
    #[cfg(feature = "opt-decode-borrowed-output")]
    borrowed_decode_output: BorrowedDecodeOutput,
    #[cfg(feature = "opt-encode-into")]
    resident_output: ResidentOutput,
    #[cfg(feature = "opt-scratch-reuse")]
    scratch: WasmScratch,
    #[cfg(feature = "htk")]
    token_lengths: TokenLengths,
    #[cfg(feature = "htk")]
    omega: u32,
    #[cfg(feature = "htk")]
    chunking_available: bool,
    #[cfg(feature = "htk")]
    chunk_telemetry: [u32; 5],
    #[cfg(feature = "htk")]
    worker_model: Option<Arc<HtkWorkerModel>>,
    #[cfg(feature = "opt-resolver-provenance")]
    resolver_worker_image: Option<Box<[u8]>>,
    #[cfg(feature = "htk")]
    worker_unsupported_patterns: Arc<[Box<[u8]>]>,
    #[cfg(feature = "htk")]
    reserved_catalog: HtkReservedCatalog,
    #[cfg(feature = "htk")]
    reserved_byte_cache: HashMap<Vec<usize>, Box<Tokenizer>, FxBuildHasher>,
}

#[cfg(all(feature = "htk", not(feature = "opt-resident-diet")))]
type TokenLengths = Arc<[usize]>;

#[cfg(all(feature = "htk", feature = "opt-resident-diet"))]
#[derive(Clone)]
enum TokenLengths {
    Owned(Arc<[usize]>),
    Htk(Arc<HtkWorkerModel>),
}

#[cfg(feature = "htk")]
fn owned_token_lengths(tokenizer: &Tokenizer) -> Result<(TokenLengths, u32), JsError> {
    let mut token_lengths = vec![0; tokenizer.vocab_size()];
    let mut omega = 0_u32;
    for (id, token) in tokenizer.vocab_entries() {
        let length = u32::try_from(token.len())
            .map_err(|_| JsError::new("token byte length exceeds the chunking limit"))?;
        token_lengths[id as usize] = token.len();
        omega = omega.max(length);
    }
    #[cfg(feature = "opt-resident-diet")]
    let token_lengths = TokenLengths::Owned(token_lengths.into());
    #[cfg(not(feature = "opt-resident-diet"))]
    let token_lengths = token_lengths.into();
    Ok((token_lengths, omega))
}

#[cfg(feature = "htk")]
fn token_length(token_lengths: &TokenLengths, id: u32) -> Option<usize> {
    #[cfg(feature = "opt-resident-diet")]
    {
        match token_lengths {
            TokenLengths::Owned(lengths) => lengths.get(id as usize).copied(),
            TokenLengths::Htk(model) => model.token_length(id),
        }
        .filter(|length| *length != 0)
    }
    #[cfg(not(feature = "opt-resident-diet"))]
    {
        token_lengths
            .get(id as usize)
            .copied()
            .filter(|length| *length != 0)
    }
}

#[cfg(all(feature = "opt-decode-assembly", feature = "opt-decode-direct-gather"))]
fn gather_decode_bytes(
    tokenizer: &Tokenizer,
    token_lengths: &TokenLengths,
    ids: &[u32],
) -> Result<Vec<u8>, JsError> {
    let output_len = crate::decode_assembly::checked_output_length(ids, |id| {
        token_length(token_lengths, id)
    })
    .map_err(js_error)?;
    crate::decode_assembly::gather_direct(tokenizer, ids, output_len).map_err(js_error)
}

#[cfg(all(
    feature = "opt-decode-assembly",
    not(feature = "opt-decode-direct-gather")
))]
fn gather_decode_bytes(
    tokenizer: &Tokenizer,
    token_lengths: &TokenLengths,
    ids: &[u32],
) -> Result<Vec<u8>, JsError> {
    for &id in ids {
        if token_length(token_lengths, id).is_none() {
            return Err(JsError::new(&format!("unknown token id {id}")));
        }
    }
    Ok(crate::decode_assembly::gather(tokenizer, ids))
}

impl WasmTokenizer {
    fn from_tokenizer(tokenizer: Tokenizer, chunking_available: bool) -> Result<Self, JsError> {
        #[cfg(feature = "htk")]
        {
            let (token_lengths, omega) = owned_token_lengths(&tokenizer)?;
            return Ok(Self {
                tokenizer,
                #[cfg(feature = "decode-profiling")]
                last_decode_profile: None,
                #[cfg(feature = "decode-profiling")]
                decode_profiling_enabled: true,
                #[cfg(feature = "profiling")]
                last_profile: None,
                #[cfg(feature = "profiling")]
                profile_sequence: 0,
                #[cfg(feature = "opt-marshalling")]
                resident_input: ResidentInput::new(),
                #[cfg(feature = "opt-decode-boundary")]
                resident_decode_ids: ResidentIds::new(),
                #[cfg(feature = "opt-decode-borrowed-output")]
                borrowed_decode_output: BorrowedDecodeOutput::new(),
                #[cfg(feature = "opt-encode-into")]
                resident_output: ResidentOutput::new(),
                #[cfg(feature = "opt-scratch-reuse")]
                scratch: WasmScratch::new(),
                token_lengths,
                omega,
                chunking_available,
                chunk_telemetry: [0; 5],
                worker_model: None,
                #[cfg(feature = "opt-resolver-provenance")]
                resolver_worker_image: None,
                worker_unsupported_patterns: Arc::from([]),
                reserved_catalog: HtkReservedCatalog::new(Vec::<HtkReservedDefinition>::new()),
                reserved_byte_cache: HashMap::with_hasher(FxBuildHasher),
            });
        }
        #[cfg(not(feature = "htk"))]
        {
            let _ = chunking_available;
            Ok(Self {
                tokenizer,
                #[cfg(feature = "decode-profiling")]
                last_decode_profile: None,
                #[cfg(feature = "decode-profiling")]
                decode_profiling_enabled: true,
                #[cfg(feature = "profiling")]
                last_profile: None,
                #[cfg(feature = "profiling")]
                profile_sequence: 0,
                #[cfg(feature = "opt-marshalling")]
                resident_input: ResidentInput::new(),
                #[cfg(feature = "opt-decode-boundary")]
                resident_decode_ids: ResidentIds::new(),
                #[cfg(feature = "opt-decode-borrowed-output")]
                borrowed_decode_output: BorrowedDecodeOutput::new(),
                #[cfg(feature = "opt-encode-into")]
                resident_output: ResidentOutput::new(),
                #[cfg(feature = "opt-scratch-reuse")]
                scratch: WasmScratch::new(),
            })
        }
    }
}

#[wasm_bindgen]
impl WasmTokenizer {
    #[cfg(feature = "source-loaders")]
    #[wasm_bindgen(js_name = fromHuggingFace)]
    pub fn from_hugging_face(data: &[u8]) -> Result<WasmTokenizer, JsError> {
        let tokenizer = match load_hf_slice(data).map_err(js_error)? {
            HfTokenizer::Bpe(tokenizer) => tokenizer,
            #[cfg(feature = "sentencepiece")]
            HfTokenizer::SentencePiece(_) => {
                return Err(JsError::new(
                    "SentencePiece tokenizers are not available in the unthreaded wasm artifact",
                ));
            }
        };
        Self::from_tokenizer(tokenizer, false)
    }

    #[cfg(feature = "source-loaders")]
    #[wasm_bindgen(js_name = fromTiktoken)]
    pub fn from_tiktoken(data: &[u8], scheme: &str) -> Result<WasmTokenizer, JsError> {
        let pretokenizer = PretokenizerType::from_name(scheme).ok_or_else(|| {
            JsError::new(&format!(
                "unknown pretokenizer scheme {scheme:?}; expected one of {}",
                PretokenizerType::NAMES.join(", ")
            ))
        })?;
        let tokenizer = load_tiktoken_slice(data, pretokenizer, Vec::new()).map_err(js_error)?;
        Self::from_tokenizer(tokenizer, true)
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = fromHtk)]
    pub fn from_htk(data: &[u8]) -> Result<WasmTokenizer, JsError> {
        crate::cold_construction::begin();
        let loaded = load_htk_slice(data).map_err(js_error)?;
        Self::from_loaded_htk(loaded)
    }

    #[cfg(feature = "opt-resolver-provenance")]
    #[wasm_bindgen(js_name = fromResolverTrustedHtk)]
    pub fn from_resolver_trusted_htk(data: &[u8]) -> Result<WasmTokenizer, JsError> {
        crate::cold_construction::begin();
        let loaded = load_resolver_trusted_htk_slice(data).map_err(js_error)?;
        Self::from_loaded_htk(loaded)
    }

    #[cfg(feature = "htk")]
    fn from_loaded_htk(loaded: LoadedHtk) -> Result<WasmTokenizer, JsError> {
        #[cfg(feature = "opt-resolver-provenance")]
        let resolver_worker_image = loaded.resolver_worker_image;
        let tokenizer = match loaded.tokenizer {
            HtkTokenizer::ByteBpe(tokenizer) => tokenizer,
            #[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
            HtkTokenizer::SentencePiece(_) => {
                return Err(JsError::new(
                    "SentencePiece tokenizers are not available in the unthreaded wasm artifact",
                ));
            }
        };
        let worker_model = crate::cold_construction::measure("worker-model-construction", || {
            loaded
                .worker_transfer_pretokenizer
                .map(|pretokenizer| {
                    #[cfg(feature = "opt-cold-diet")]
                    let model = HtkWorkerModel::new_transfer_source(
                        loaded.lookup_index,
                        pretokenizer,
                        loaded.omega,
                        loaded.digest,
                    );
                    #[cfg(not(feature = "opt-cold-diet"))]
                    let model = HtkWorkerModel::new(
                        loaded.lookup_index,
                        pretokenizer,
                        loaded.omega,
                        loaded.digest,
                    );
                    model.map(Arc::new).map_err(js_error)
                })
                .transpose()
        })?;
        #[cfg(feature = "opt-resident-diet")]
        let token_lengths = crate::cold_construction::measure("token-lengths", || {
            match &worker_model {
                Some(model) => Ok(TokenLengths::Htk(Arc::clone(model))),
                None => owned_token_lengths(&tokenizer).map(|value| value.0),
            }
        })?;
        #[cfg(not(feature = "opt-resident-diet"))]
        let token_lengths = crate::cold_construction::measure("token-lengths", || {
            owned_token_lengths(&tokenizer).map(|value| value.0)
        })?;
        let chunking_available = worker_model.is_some();
        let tokenizer = crate::cold_construction::measure("wasm-tokenizer-assembly", || Self {
            tokenizer: *tokenizer,
            #[cfg(feature = "decode-profiling")]
            last_decode_profile: None,
            #[cfg(feature = "decode-profiling")]
            decode_profiling_enabled: true,
            #[cfg(feature = "profiling")]
            last_profile: None,
            #[cfg(feature = "profiling")]
            profile_sequence: 0,
            #[cfg(feature = "opt-marshalling")]
            resident_input: ResidentInput::new(),
            #[cfg(feature = "opt-decode-boundary")]
            resident_decode_ids: ResidentIds::new(),
            #[cfg(feature = "opt-decode-borrowed-output")]
            borrowed_decode_output: BorrowedDecodeOutput::new(),
            #[cfg(feature = "opt-encode-into")]
            resident_output: ResidentOutput::new(),
            #[cfg(feature = "opt-scratch-reuse")]
            scratch: WasmScratch::new(),
            token_lengths,
            omega: loaded.omega,
            chunking_available,
            chunk_telemetry: [0; 5],
            worker_model,
            #[cfg(feature = "opt-resolver-provenance")]
            resolver_worker_image,
            worker_unsupported_patterns: loaded.worker_unsupported_patterns.into(),
            reserved_catalog: loaded.reserved_catalog,
            reserved_byte_cache: loaded.reserved_byte_cache,
        });
        crate::cold_construction::finish();
        Ok(tokenizer)
    }

    #[cfg(feature = "cold-construction-profiling")]
    #[wasm_bindgen(js_name = lastColdConstructionProfileJson)]
    pub fn last_cold_construction_profile_json() -> Result<String, JsError> {
        crate::cold_construction::last_json().map_err(js_error)
    }

    #[cfg(not(feature = "opt-scratch-reuse"))]
    pub fn encode(&mut self, input: &[u8]) -> Result<Vec<u32>, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        let mut ids = Vec::new();
        self.tokenizer
            .encode_with_added_tokens_flat(input, &mut ids);
        Ok(ids)
    }

    #[cfg(feature = "opt-scratch-reuse")]
    #[wasm_bindgen(js_name = encode)]
    pub fn encode_reused(&mut self, input: &[u8]) -> Result<js_sys::Uint32Array, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        let ids = self.scratch.output_mut();
        self.tokenizer.encode_with_added_tokens_flat(input, ids);
        Ok(self.scratch.output_array())
    }

    #[cfg(feature = "opt-scratch-reuse")]
    #[wasm_bindgen(js_name = scratchOutputCapacityBytes)]
    pub fn scratch_output_capacity_bytes(&self) -> usize {
        self.scratch.output_capacity_bytes()
    }

    #[cfg(feature = "opt-scratch-reuse")]
    #[wasm_bindgen(js_name = scratchRangeCapacityBytes)]
    pub fn scratch_range_capacity_bytes(&self) -> usize {
        self.scratch.flat_range_capacity_bytes()
    }

    #[cfg(feature = "opt-marshalling")]
    #[wasm_bindgen(js_name = residentInputView)]
    pub fn resident_input_view(&self) -> js_sys::Uint8Array {
        // SAFETY: the JavaScript helper discards this view before its next wasm
        // call, and reacquires a view after every operation that can move or
        // grow the resident allocation.
        unsafe { js_sys::Uint8Array::view(self.resident_input.bytes()) }
    }

    #[cfg(feature = "opt-marshalling")]
    #[wasm_bindgen(js_name = residentInputCapacity)]
    pub fn resident_input_capacity(&self) -> usize {
        self.resident_input.capacity()
    }

    #[cfg(feature = "opt-marshalling")]
    #[wasm_bindgen(js_name = residentInputHighWater)]
    pub fn resident_input_high_water(&self) -> usize {
        self.resident_input.high_water()
    }

    #[cfg(feature = "opt-marshalling")]
    #[wasm_bindgen(js_name = growResidentInput)]
    pub fn grow_resident_input(&mut self) -> Result<(), JsError> {
        self.resident_input.grow().map_err(js_error)
    }

    #[cfg(all(feature = "opt-marshalling", not(feature = "opt-scratch-reuse")))]
    #[wasm_bindgen(js_name = encodeResidentInput)]
    pub fn encode_resident_input(&mut self, used: usize) -> Result<Vec<u32>, JsError> {
        let input = self
            .resident_input
            .bytes()
            .get(..used)
            .ok_or_else(|| JsError::new("resident input length exceeds capacity"))?;
        let mut ids = Vec::new();
        self.tokenizer
            .encode_with_added_tokens_flat(input, &mut ids);
        self.resident_input.finish_call(used).map_err(js_error)?;
        Ok(ids)
    }

    #[cfg(all(feature = "opt-marshalling", feature = "opt-scratch-reuse"))]
    #[wasm_bindgen(js_name = encodeResidentInput)]
    pub fn encode_resident_input_reused(
        &mut self,
        used: usize,
    ) -> Result<js_sys::Uint32Array, JsError> {
        let input = self
            .resident_input
            .bytes()
            .get(..used)
            .ok_or_else(|| JsError::new("resident input length exceeds capacity"))?;
        let ids = self.scratch.output_mut();
        self.tokenizer.encode_with_added_tokens_flat(input, ids);
        let output = self.scratch.output_array();
        self.resident_input.finish_call(used).map_err(js_error)?;
        Ok(output)
    }

    #[cfg(feature = "opt-encode-into")]
    #[wasm_bindgen(js_name = encodeResidentInputIntoOutput)]
    pub fn encode_resident_input_into_output(&mut self, used: usize) -> Result<usize, JsError> {
        let input = self
            .resident_input
            .bytes()
            .get(..used)
            .ok_or_else(|| JsError::new("resident input length exceeds capacity"))?;
        self.tokenizer
            .encode_with_added_tokens_flat(input, self.resident_output.ids_mut());
        let written = self.resident_output.len();
        self.resident_input.finish_call(used).map_err(js_error)?;
        Ok(written)
    }

    #[cfg(feature = "opt-encode-into")]
    #[wasm_bindgen(js_name = residentOutputView)]
    pub fn resident_output_view(&self) -> js_sys::Uint32Array {
        self.resident_output.view()
    }

    #[cfg(feature = "opt-encode-into")]
    #[wasm_bindgen(js_name = residentOutputCapacityBytes)]
    pub fn resident_output_capacity_bytes(&self) -> usize {
        self.resident_output.capacity_bytes()
    }

    #[cfg(all(
        feature = "htk",
        feature = "opt-encode-into",
        feature = "opt-chunk-prescan"
    ))]
    #[wasm_bindgen(js_name = encodeChunkedResidentInputIntoOutput)]
    pub fn encode_chunked_resident_input_into_output(
        &mut self,
        used: usize,
        chunk_size: usize,
    ) -> Result<usize, JsError> {
        let mut resident = std::mem::replace(&mut self.resident_input, ResidentInput::new());
        let result = (|| {
            let input = resident
                .bytes()
                .get(..used)
                .ok_or_else(|| JsError::new("resident input length exceeds capacity"))?;
            std::str::from_utf8(input)
                .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
            if !self.chunking_available {
                return Err(JsError::new(
                    "chunked encoding is available only for rank-file tokenizers without reserved tokens",
                ));
            }
            let minimum_chunk_size = self.minimum_chunk_size()? as usize;
            if chunk_size < minimum_chunk_size {
                return Err(JsError::new(&format!(
                    "chunk size {chunk_size} is below the minimum {minimum_chunk_size}"
                )));
            }
            let telemetry = encode_chunked_streaming(
                &mut self.tokenizer,
                |id| token_length(&self.token_lengths, id),
                self.omega,
                input,
                chunk_size,
                self.resident_output.ids_mut(),
            )
            .map_err(js_error)?;
            self.chunk_telemetry = telemetry.as_u32(chunk_size).map_err(js_error)?;
            Ok(self.resident_output.len())
        })();
        let finish = if result.is_ok() {
            resident.finish_call(used).map_err(js_error)
        } else {
            Ok(())
        };
        self.resident_input = resident;
        finish?;
        result
    }

    #[cfg(all(
        feature = "htk",
        feature = "opt-marshalling",
        not(feature = "opt-scratch-reuse"),
        not(feature = "opt-chunk-prescan")
    ))]
    #[wasm_bindgen(js_name = encodeChunkedResidentInput)]
    pub fn encode_chunked_resident_input(
        &mut self,
        used: usize,
        chunk_size: usize,
    ) -> Result<Vec<u32>, JsError> {
        let mut resident = std::mem::replace(&mut self.resident_input, ResidentInput::new());
        let result = (|| {
            let input = resident
                .bytes()
                .get(..used)
                .ok_or_else(|| JsError::new("resident input length exceeds capacity"))?;
            self.encode_chunked(input, chunk_size)
        })();
        let finish = if result.is_ok() {
            resident.finish_call(used).map_err(js_error)
        } else {
            Ok(())
        };
        self.resident_input = resident;
        finish?;
        result
    }

    #[cfg(all(
        feature = "htk",
        feature = "opt-marshalling",
        not(feature = "opt-scratch-reuse"),
        feature = "opt-chunk-prescan"
    ))]
    #[wasm_bindgen(js_name = encodeChunkedResidentInput)]
    pub fn encode_chunked_resident_input_single_pass(
        &mut self,
        used: usize,
        chunk_size: usize,
    ) -> Result<Vec<u32>, JsError> {
        let mut resident = std::mem::replace(&mut self.resident_input, ResidentInput::new());
        let result = (|| {
            let input = resident
                .bytes()
                .get(..used)
                .ok_or_else(|| JsError::new("resident input length exceeds capacity"))?;
            self.encode_chunked_single_pass(input, chunk_size)
        })();
        let finish = if result.is_ok() {
            resident.finish_call(used).map_err(js_error)
        } else {
            Ok(())
        };
        self.resident_input = resident;
        finish?;
        result
    }

    #[cfg(all(
        feature = "htk",
        feature = "opt-marshalling",
        feature = "opt-scratch-reuse",
        not(feature = "opt-chunk-prescan")
    ))]
    #[wasm_bindgen(js_name = encodeChunkedResidentInput)]
    pub fn encode_chunked_resident_input_reused(
        &mut self,
        used: usize,
        chunk_size: usize,
    ) -> Result<js_sys::Uint32Array, JsError> {
        let mut resident = std::mem::replace(&mut self.resident_input, ResidentInput::new());
        let result = (|| {
            let input = resident
                .bytes()
                .get(..used)
                .ok_or_else(|| JsError::new("resident input length exceeds capacity"))?;
            self.encode_chunked_reused(input, chunk_size)
        })();
        let finish = if result.is_ok() {
            resident.finish_call(used).map_err(js_error)
        } else {
            Ok(())
        };
        self.resident_input = resident;
        finish?;
        result
    }

    #[cfg(all(
        feature = "htk",
        feature = "opt-marshalling",
        feature = "opt-scratch-reuse",
        feature = "opt-chunk-prescan"
    ))]
    #[wasm_bindgen(js_name = encodeChunkedResidentInput)]
    pub fn encode_chunked_resident_input_single_pass_reused(
        &mut self,
        used: usize,
        chunk_size: usize,
    ) -> Result<js_sys::Uint32Array, JsError> {
        let mut resident = std::mem::replace(&mut self.resident_input, ResidentInput::new());
        let result = (|| {
            let input = resident
                .bytes()
                .get(..used)
                .ok_or_else(|| JsError::new("resident input length exceeds capacity"))?;
            self.encode_chunked_single_pass_reused(input, chunk_size)
        })();
        let finish = if result.is_ok() {
            resident.finish_call(used).map_err(js_error)
        } else {
            Ok(())
        };
        self.resident_input = resident;
        finish?;
        result
    }

    #[cfg(feature = "profiling")]
    #[wasm_bindgen(js_name = encodeProfiled)]
    pub fn encode_profiled(&mut self, input: &[u8]) -> Result<Vec<u32>, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        let mut ids = Vec::new();
        let batch_sampling_phase = self.profile_sequence;
        self.profile_sequence = self.profile_sequence.wrapping_add(1);
        let profile =
            self.tokenizer
                .encode_with_added_tokens_profiled(input, &mut ids, batch_sampling_phase);
        if let Some(snapshot) = self.last_profile.as_mut() {
            snapshot.accumulate(profile);
        } else {
            self.last_profile = Some(profile);
        }
        Ok(ids)
    }

    #[cfg(feature = "opt-level-select")]
    #[wasm_bindgen(js_name = lastLevelScalar)]
    pub fn last_level_scalar(&self) -> bool {
        crate::pretokenize::fast::level_select::last_scalar_scanner()
    }

    #[cfg(feature = "profiling")]
    #[wasm_bindgen(js_name = takeProfileJson)]
    pub fn take_profile_json(&mut self) -> Result<String, JsError> {
        self.last_profile
            .take()
            .ok_or_else(|| JsError::new("no profiled encode is available"))?
            .to_json()
            .map_err(js_error)
    }

    #[cfg(all(feature = "htk", feature = "profiling"))]
    #[wasm_bindgen(js_name = fillSpanRanges)]
    pub fn fill_span_ranges(&mut self, input: &[u8]) -> Vec<u32> {
        let mut ranges = Vec::new();
        self.tokenizer.fill_span_ranges(input, &mut ranges);
        ranges
    }

    #[cfg(all(
        feature = "profiling",
        target_arch = "wasm32",
        target_feature = "simd128"
    ))]
    #[wasm_bindgen(js_name = classifyO200kMasks)]
    pub fn classify_o200k_masks(&self, input: &[u8]) -> u64 {
        crate::pretokenize::fast::classify_o200k_masks(input)
    }

    #[cfg(feature = "htk")]
    pub fn decode(&self, ids: &[u32]) -> Result<String, JsError> {
        for &id in ids {
            if token_length(&self.token_lengths, id).is_none() {
                return Err(JsError::new(&format!("unknown token id {id}")));
            }
        }
        let ids = ids.iter().copied().map(TokenId::from).collect::<Vec<_>>();
        let bytes = self.tokenizer.decode(&ids).collect::<Vec<_>>();
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    #[cfg(feature = "opt-decode-assembly")]
    #[wasm_bindgen(js_name = decodeAssemblyBytes)]
    pub fn decode_assembly_bytes(&self, ids: &[u32]) -> Result<Vec<u8>, JsError> {
        gather_decode_bytes(&self.tokenizer, &self.token_lengths, ids)
    }

    #[cfg(feature = "opt-decode-borrowed-output")]
    #[wasm_bindgen(js_name = decodeBorrowedAssemblyView)]
    pub fn decode_borrowed_assembly_view(
        &mut self,
        ids: &[u32],
    ) -> Result<js_sys::Uint8Array, JsError> {
        let bytes = gather_decode_bytes(&self.tokenizer, &self.token_lengths, ids)?;
        let output = self.borrowed_decode_output.replace(bytes);
        // SAFETY: the JavaScript decoder consumes this view synchronously before another
        // WebAssembly call can replace the buffer or grow linear memory. The view is not
        // exposed by the public tokenizer handle.
        Ok(unsafe { js_sys::Uint8Array::view(output) })
    }

    #[cfg(feature = "opt-decode-utf16-output")]
    #[wasm_bindgen(js_name = decodeAssemblyUtf16)]
    pub fn decode_assembly_utf16(&self, ids: &[u32]) -> Result<Vec<u16>, JsError> {
        let bytes = gather_decode_bytes(&self.tokenizer, &self.token_lengths, ids)?;
        Ok(String::from_utf8_lossy(&bytes).encode_utf16().collect())
    }

    #[cfg(feature = "opt-decode-boundary")]
    #[wasm_bindgen(js_name = residentDecodeIdsView)]
    pub fn resident_decode_ids_view(&self) -> js_sys::Uint32Array {
        // SAFETY: the JavaScript helper clears this view before explicit
        // growth, discards it after a consuming call that shrinks the vector,
        // and checks for detached WebAssembly memory before every later write.
        unsafe { js_sys::Uint32Array::view(self.resident_decode_ids.ids()) }
    }

    #[cfg(feature = "opt-decode-boundary")]
    #[wasm_bindgen(js_name = residentDecodeIdsCapacity)]
    pub fn resident_decode_ids_capacity(&self) -> usize {
        self.resident_decode_ids.capacity()
    }

    #[cfg(feature = "opt-decode-boundary")]
    #[wasm_bindgen(js_name = residentDecodeIdsHighWater)]
    pub fn resident_decode_ids_high_water(&self) -> usize {
        self.resident_decode_ids.high_water()
    }

    #[cfg(feature = "opt-decode-boundary")]
    #[wasm_bindgen(js_name = growResidentDecodeIds)]
    pub fn grow_resident_decode_ids(&mut self) -> Result<(), JsError> {
        self.resident_decode_ids.grow().map_err(js_error)
    }

    #[cfg(feature = "opt-decode-boundary")]
    #[wasm_bindgen(js_name = decodeBoundaryBytes)]
    pub fn decode_boundary_bytes(&mut self, used: usize) -> Result<Vec<u8>, JsError> {
        let result = (|| {
            let ids = self
                .resident_decode_ids
                .ids()
                .get(..used)
                .ok_or_else(|| JsError::new("resident decode id length exceeds capacity"))?;
            gather_decode_bytes(&self.tokenizer, &self.token_lengths, ids)
        })();
        if result.is_ok() {
            self.resident_decode_ids
                .finish_call(used)
                .map_err(js_error)?;
        }
        result
    }

    #[cfg(feature = "decode-profile-api")]
    #[wasm_bindgen(js_name = decodeProfileBytes)]
    pub fn decode_profile_bytes(&mut self, ids: &[u32]) -> Result<Vec<u8>, JsError> {
        #[cfg(feature = "decode-profiling")]
        {
            if !self.decode_profiling_enabled {
                return decode_profile_gather(&self.tokenizer, &self.token_lengths, ids);
            }
            let clock = DecodeProfileClock::new();
            let started = clock.now_ms();
            let bytes = decode_profile_gather(&self.tokenizer, &self.token_lengths, ids)?;
            let profile =
                DecodeProfileSnapshot::new(clock.now_ms() - started, ids.len(), bytes.len());
            if let Some(snapshot) = self.last_decode_profile.as_mut() {
                snapshot.accumulate(profile);
            } else {
                self.last_decode_profile = Some(profile);
            }
            return Ok(bytes);
        }
        #[cfg(not(feature = "decode-profiling"))]
        decode_profile_gather(&self.tokenizer, &self.token_lengths, ids)
    }

    #[cfg(feature = "decode-profiling")]
    #[wasm_bindgen(js_name = setDecodeProfilingEnabled)]
    pub fn set_decode_profiling_enabled(&mut self, enabled: bool) {
        self.decode_profiling_enabled = enabled;
        if !enabled {
            self.last_decode_profile = None;
        }
    }

    #[cfg(feature = "decode-profiling")]
    #[wasm_bindgen(js_name = takeDecodeProfileJson)]
    pub fn take_decode_profile_json(&mut self) -> Result<String, JsError> {
        self.last_decode_profile
            .take()
            .ok_or_else(|| JsError::new("no profiled decode is available"))?
            .to_json()
            .map_err(js_error)
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = tokenBytes)]
    pub fn token_bytes(&self, id: u32) -> Result<Vec<u8>, JsError> {
        if token_length(&self.token_lengths, id).is_none() {
            return Err(JsError::new(&format!("unknown token id {id}")));
        }
        Ok(self
            .tokenizer
            .decode(&[TokenId::from(id)])
            .collect::<Vec<_>>())
    }

    #[wasm_bindgen(js_name = tokenStarts)]
    pub fn token_starts(&mut self, input: &[u8], ids: &[u32]) -> Result<Vec<u32>, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        self.tokenizer.token_starts(input, ids).map_err(js_error)
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = encodeReserved)]
    pub fn encode_reserved(
        &mut self,
        input: &[u8],
        match_all: bool,
        match_names_json: &str,
        refuse_all: bool,
        refuse_names_json: &str,
    ) -> Result<WasmReservedEncoding, JsError> {
        let input = std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        let match_names: Vec<String> = serde_json::from_str(match_names_json).map_err(js_error)?;
        let refuse_names: Vec<String> =
            serde_json::from_str(refuse_names_json).map_err(js_error)?;
        let policy = HtkReservedPolicy {
            match_all,
            match_names: &match_names,
            refuse_all,
            refuse_names: &refuse_names,
        };
        let result = self
            .reserved_catalog
            .encode_byte_bpe_detailed(
                &mut self.tokenizer,
                &mut self.reserved_byte_cache,
                input.as_bytes(),
                &policy,
            )
            .map_err(js_error)?;
        Ok(WasmReservedEncoding {
            ids: result.ids,
            starts: result.starts,
            found_json: serde_json::to_string(&result.found).map_err(js_error)?,
        })
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = reservedNamesJson)]
    pub fn reserved_names_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.reserved_catalog.names()).map_err(js_error)
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = reservedFoundJson)]
    pub fn reserved_found_json(&self, input: &[u8]) -> Result<String, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        serde_json::to_string(&self.reserved_catalog.found_names(input)).map_err(js_error)
    }

    /// Return byte ranges for exact orchestration without reproducing the
    /// pretokenizer in JavaScript.
    #[cfg(all(feature = "htk", not(feature = "opt-scratch-reuse")))]
    #[wasm_bindgen(js_name = pretokenRanges)]
    pub fn pretoken_ranges(&self, input: &[u8]) -> Result<Vec<u32>, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        let base = input.as_ptr() as usize;
        let mut flat = Vec::new();
        for pretoken in self.tokenizer.pretokenizer_type().pretokenize(input) {
            let bytes = pretoken.as_ref();
            let start = bytes.as_ptr() as usize - base;
            let end = start
                .checked_add(bytes.len())
                .ok_or_else(|| JsError::new("pretoken range overflow"))?;
            flat.push(
                u32::try_from(start)
                    .map_err(|_| JsError::new("pretoken range exceeds WebAssembly memory"))?,
            );
            flat.push(
                u32::try_from(end)
                    .map_err(|_| JsError::new("pretoken range exceeds WebAssembly memory"))?,
            );
        }
        Ok(flat)
    }

    #[cfg(all(feature = "htk", feature = "opt-scratch-reuse"))]
    #[wasm_bindgen(js_name = pretokenRanges)]
    pub fn pretoken_ranges_reused(&mut self, input: &[u8]) -> Result<js_sys::Uint32Array, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        let base = input.as_ptr() as usize;
        let pretokenizer = self.tokenizer.pretokenizer_type();
        let flat = self.scratch.flat_ranges_mut();
        for pretoken in pretokenizer.pretokenize(input) {
            let bytes = pretoken.as_ref();
            let start = bytes.as_ptr() as usize - base;
            let end = start
                .checked_add(bytes.len())
                .ok_or_else(|| JsError::new("pretoken range overflow"))?;
            flat.push(
                u32::try_from(start)
                    .map_err(|_| JsError::new("pretoken range exceeds WebAssembly memory"))?,
            );
            flat.push(
                u32::try_from(end)
                    .map_err(|_| JsError::new("pretoken range exceeds WebAssembly memory"))?,
            );
        }
        Ok(self.scratch.flat_ranges_array())
    }

    /// Encode one already planned pretoken with this instance's private
    /// cache. The caller obtains the range from [`Self::pretoken_ranges`].
    #[cfg(all(feature = "htk", not(feature = "opt-scratch-reuse")))]
    #[wasm_bindgen(js_name = encodePretoken)]
    pub fn encode_pretoken(&mut self, input: &[u8]) -> Result<Vec<u32>, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        let mut ids = Vec::new();
        self.tokenizer
            .memoized_encode_flat(SpanIter(std::iter::once(Pretoken(input))), &mut ids);
        Ok(ids)
    }

    #[cfg(all(feature = "htk", feature = "opt-scratch-reuse"))]
    #[wasm_bindgen(js_name = encodePretoken)]
    pub fn encode_pretoken_reused(&mut self, input: &[u8]) -> Result<js_sys::Uint32Array, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        let ids = self.scratch.output_mut();
        self.tokenizer
            .memoized_encode_flat(SpanIter(std::iter::once(Pretoken(input))), ids);
        Ok(self.scratch.output_array())
    }

    /// Start Rust-owned overlap planning for asynchronous browser workers.
    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = beginOverlap)]
    pub fn begin_overlap(
        &self,
        pretoken: &[u8],
        chunk_size: usize,
    ) -> Result<WasmOverlapReconciler, JsError> {
        std::str::from_utf8(pretoken)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        if !self.chunking_available {
            return Err(JsError::new(
                "overlap planning is available only for rank-file tokenizers without reserved tokens",
            ));
        }
        let ranges = overlap_ranges(
            pretoken,
            self.omega,
            ChunkConfig {
                chunk_size: Some(chunk_size),
            },
            false,
        )
        .map_err(js_error)?;
        Ok(WasmOverlapReconciler {
            ranges,
            state: None,
            token_lengths: self.token_lengths.clone(),
        })
    }

    #[cfg(all(
        feature = "htk",
        not(feature = "opt-scratch-reuse"),
        not(feature = "opt-chunk-prescan")
    ))]
    #[wasm_bindgen(js_name = encodeChunked)]
    pub fn encode_chunked(&mut self, input: &[u8], chunk_size: usize) -> Result<Vec<u32>, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        if !self.chunking_available {
            return Err(JsError::new(
                "chunked encoding is available only for rank-file tokenizers without reserved tokens",
            ));
        }
        let minimum_chunk_size = self.minimum_chunk_size()? as usize;
        if chunk_size < minimum_chunk_size {
            return Err(JsError::new(&format!(
                "chunk size {chunk_size} is below the minimum {minimum_chunk_size}"
            )));
        }

        let base = input.as_ptr() as usize;
        let ranges = self
            .tokenizer
            .pretokenizer_type()
            .pretokenize(input)
            .map(|pretoken| {
                let bytes = pretoken.as_ref();
                let start = bytes.as_ptr() as usize - base;
                start..start + bytes.len()
            })
            .collect::<Vec<_>>();

        let token_lengths = &self.token_lengths;
        let tokenizer = &mut self.tokenizer;
        let mut ids = Vec::new();
        if ranges.iter().all(|range| range.len() <= chunk_size) {
            let pretokenizer = tokenizer.pretokenizer_type();
            tokenizer.memoized_encode_flat(pretokenizer.pretokenize(input), &mut ids);
            let pretoken_count = u32::try_from(ranges.len())
                .map_err(|_| JsError::new("chunk telemetry exceeds u32"))?;
            self.chunk_telemetry = [
                pretoken_count,
                0,
                pretoken_count,
                0,
                u32::try_from(chunk_size)
                    .map_err(|_| JsError::new("chunk telemetry exceeds u32"))?,
            ];
            return Ok(ids);
        }
        let mut pretokens = 0_usize;
        let mut engaged = 0_usize;
        let mut chunks = 0_usize;
        let mut enlargements = 0_usize;
        for range in ranges {
            let pretoken = &input[range];
            pretokens += 1;
            if pretoken.len() <= chunk_size {
                tokenizer
                    .memoized_encode_flat(SpanIter(std::iter::once(Pretoken(pretoken))), &mut ids);
                chunks = chunks
                    .checked_add(1)
                    .ok_or_else(|| JsError::new("chunk telemetry overflow"))?;
                continue;
            }
            let result = encode_overlap(
                pretoken,
                self.omega,
                ChunkConfig {
                    chunk_size: Some(chunk_size),
                },
                false,
                |bytes| {
                    let mut encoded = Vec::new();
                    tokenizer.memoized_encode_flat(
                        SpanIter(std::iter::once(Pretoken(bytes))),
                        &mut encoded,
                    );
                    Ok(encoded)
                },
                |id| token_length(token_lengths, id),
            )
            .map_err(js_error)?;
            engaged += usize::from(result.initial_chunks > 1);
            chunks = chunks
                .checked_add(result.initial_chunks)
                .ok_or_else(|| JsError::new("chunk telemetry overflow"))?;
            enlargements = enlargements
                .checked_add(result.enlargements)
                .ok_or_else(|| JsError::new("chunk telemetry overflow"))?;
            ids.extend(result.ids);
        }
        let telemetry_value =
            |value| u32::try_from(value).map_err(|_| JsError::new("chunk telemetry exceeds u32"));
        self.chunk_telemetry = [
            telemetry_value(pretokens)?,
            telemetry_value(engaged)?,
            telemetry_value(chunks)?,
            telemetry_value(enlargements)?,
            telemetry_value(chunk_size)?,
        ];
        Ok(ids)
    }

    #[cfg(all(
        feature = "htk",
        not(feature = "opt-scratch-reuse"),
        feature = "opt-chunk-prescan"
    ))]
    #[wasm_bindgen(js_name = encodeChunked)]
    pub fn encode_chunked_single_pass(
        &mut self,
        input: &[u8],
        chunk_size: usize,
    ) -> Result<Vec<u32>, JsError> {
        #[cfg(feature = "opt-level-select")]
        let scalar_scanner =
            crate::pretokenize::fast::level_select::validate_and_select_scalar(input)
                .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        #[cfg(not(feature = "opt-level-select"))]
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        if !self.chunking_available {
            return Err(JsError::new(
                "chunked encoding is available only for rank-file tokenizers without reserved tokens",
            ));
        }
        let minimum_chunk_size = self.minimum_chunk_size()? as usize;
        if chunk_size < minimum_chunk_size {
            return Err(JsError::new(&format!(
                "chunk size {chunk_size} is below the minimum {minimum_chunk_size}"
            )));
        }

        let mut ids = Vec::new();
        #[cfg(feature = "opt-level-select")]
        let telemetry =
            crate::pretokenize::fast::level_select::with_scalar_scanner(scalar_scanner, || {
                encode_chunked_streaming(
                    &mut self.tokenizer,
                    |id| token_length(&self.token_lengths, id),
                    self.omega,
                    input,
                    chunk_size,
                    &mut ids,
                )
            })
            .map_err(js_error)?;
        #[cfg(not(feature = "opt-level-select"))]
        let telemetry = encode_chunked_streaming(
            &mut self.tokenizer,
            |id| token_length(&self.token_lengths, id),
            self.omega,
            input,
            chunk_size,
            &mut ids,
        )
        .map_err(js_error)?;
        self.chunk_telemetry = telemetry.as_u32(chunk_size).map_err(js_error)?;
        Ok(ids)
    }

    #[cfg(all(
        feature = "htk",
        not(feature = "opt-scratch-reuse"),
        feature = "opt-chunk-prescan",
        feature = "opt-level-select",
        feature = "profiling"
    ))]
    #[wasm_bindgen(js_name = encodeChunkedAtLevel)]
    pub fn encode_chunked_at_level(
        &mut self,
        input: &[u8],
        chunk_size: usize,
        scalar: bool,
    ) -> Result<Vec<u32>, JsError> {
        crate::pretokenize::fast::level_select::validate_and_select_scalar(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        if !self.chunking_available {
            return Err(JsError::new(
                "chunked encoding is available only for rank-file tokenizers without reserved tokens",
            ));
        }
        let minimum_chunk_size = self.minimum_chunk_size()? as usize;
        if chunk_size < minimum_chunk_size {
            return Err(JsError::new(&format!(
                "chunk size {chunk_size} is below the minimum {minimum_chunk_size}"
            )));
        }

        let mut ids = Vec::new();
        let telemetry =
            crate::pretokenize::fast::level_select::with_scalar_scanner(scalar, || {
                encode_chunked_streaming(
                    &mut self.tokenizer,
                    |id| token_length(&self.token_lengths, id),
                    self.omega,
                    input,
                    chunk_size,
                    &mut ids,
                )
            })
            .map_err(js_error)?;
        self.chunk_telemetry = telemetry.as_u32(chunk_size).map_err(js_error)?;
        Ok(ids)
    }

    #[cfg(all(
        feature = "htk",
        feature = "opt-scratch-reuse",
        not(feature = "opt-chunk-prescan")
    ))]
    #[wasm_bindgen(js_name = encodeChunked)]
    pub fn encode_chunked_reused(
        &mut self,
        input: &[u8],
        chunk_size: usize,
    ) -> Result<js_sys::Uint32Array, JsError> {
        let mut scratch = std::mem::replace(&mut self.scratch, WasmScratch::new());
        let result = (|| {
            #[cfg(feature = "opt-level-select")]
            let scalar_scanner =
                crate::pretokenize::fast::level_select::validate_and_select_scalar(input)
                    .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
            #[cfg(not(feature = "opt-level-select"))]
            std::str::from_utf8(input)
                .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
            if !self.chunking_available {
                return Err(JsError::new(
                    "chunked encoding is available only for rank-file tokenizers without reserved tokens",
                ));
            }
            let minimum_chunk_size = self.minimum_chunk_size()? as usize;
            if chunk_size < minimum_chunk_size {
                return Err(JsError::new(&format!(
                    "chunk size {chunk_size} is below the minimum {minimum_chunk_size}"
                )));
            }

            let (ids, flat_ranges) = scratch.vectors_mut();
            let base = input.as_ptr() as usize;
            for pretoken in self.tokenizer.pretokenizer_type().pretokenize(input) {
                let bytes = pretoken.as_ref();
                let start = bytes.as_ptr() as usize - base;
                flat_ranges.push(
                    u32::try_from(start).map_err(|_| JsError::new("pretoken range exceeds u32"))?,
                );
                flat_ranges.push(
                    u32::try_from(
                        start
                            .checked_add(bytes.len())
                            .ok_or_else(|| JsError::new("pretoken range overflow"))?,
                    )
                    .map_err(|_| JsError::new("pretoken range exceeds u32"))?,
                );
            }

            let token_lengths = &self.token_lengths;
            let tokenizer = &mut self.tokenizer;
            if flat_ranges
                .chunks_exact(2)
                .all(|range| range[1] as usize - range[0] as usize <= chunk_size)
            {
                let pretokenizer = tokenizer.pretokenizer_type();
                tokenizer.memoized_encode_flat(pretokenizer.pretokenize(input), ids);
                let pretoken_count = u32::try_from(flat_ranges.len() / 2)
                    .map_err(|_| JsError::new("chunk telemetry exceeds u32"))?;
                self.chunk_telemetry = [
                    pretoken_count,
                    0,
                    pretoken_count,
                    0,
                    u32::try_from(chunk_size)
                        .map_err(|_| JsError::new("chunk telemetry exceeds u32"))?,
                ];
                return Ok(js_sys::Uint32Array::from(ids.as_slice()));
            }

            let mut pretokens = 0_usize;
            let mut engaged = 0_usize;
            let mut chunks = 0_usize;
            let mut enlargements = 0_usize;
            for range in flat_ranges.chunks_exact(2) {
                let pretoken = &input[range[0] as usize..range[1] as usize];
                pretokens += 1;
                if pretoken.len() <= chunk_size {
                    tokenizer
                        .memoized_encode_flat(SpanIter(std::iter::once(Pretoken(pretoken))), ids);
                    chunks = chunks
                        .checked_add(1)
                        .ok_or_else(|| JsError::new("chunk telemetry overflow"))?;
                    continue;
                }
                let encoded = encode_overlap(
                    pretoken,
                    self.omega,
                    ChunkConfig {
                        chunk_size: Some(chunk_size),
                    },
                    false,
                    |bytes| {
                        let mut chunk_ids = Vec::new();
                        tokenizer.memoized_encode_flat(
                            SpanIter(std::iter::once(Pretoken(bytes))),
                            &mut chunk_ids,
                        );
                        Ok(chunk_ids)
                    },
                    |id| token_length(token_lengths, id),
                )
                .map_err(js_error)?;
                engaged += usize::from(encoded.initial_chunks > 1);
                chunks = chunks
                    .checked_add(encoded.initial_chunks)
                    .ok_or_else(|| JsError::new("chunk telemetry overflow"))?;
                enlargements = enlargements
                    .checked_add(encoded.enlargements)
                    .ok_or_else(|| JsError::new("chunk telemetry overflow"))?;
                ids.extend(encoded.ids);
            }
            let telemetry_value = |value| {
                u32::try_from(value).map_err(|_| JsError::new("chunk telemetry exceeds u32"))
            };
            self.chunk_telemetry = [
                telemetry_value(pretokens)?,
                telemetry_value(engaged)?,
                telemetry_value(chunks)?,
                telemetry_value(enlargements)?,
                telemetry_value(chunk_size)?,
            ];
            Ok(js_sys::Uint32Array::from(ids.as_slice()))
        })();
        self.scratch = scratch;
        result
    }

    #[cfg(all(
        feature = "htk",
        feature = "opt-scratch-reuse",
        feature = "opt-chunk-prescan"
    ))]
    #[wasm_bindgen(js_name = encodeChunked)]
    pub fn encode_chunked_single_pass_reused(
        &mut self,
        input: &[u8],
        chunk_size: usize,
    ) -> Result<js_sys::Uint32Array, JsError> {
        let mut scratch = std::mem::replace(&mut self.scratch, WasmScratch::new());
        let result = (|| {
            #[cfg(feature = "opt-level-select")]
            let scalar_scanner =
                crate::pretokenize::fast::level_select::validate_and_select_scalar(input)
                    .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
            #[cfg(not(feature = "opt-level-select"))]
            std::str::from_utf8(input)
                .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
            if !self.chunking_available {
                return Err(JsError::new(
                    "chunked encoding is available only for rank-file tokenizers without reserved tokens",
                ));
            }
            let minimum_chunk_size = self.minimum_chunk_size()? as usize;
            if chunk_size < minimum_chunk_size {
                return Err(JsError::new(&format!(
                    "chunk size {chunk_size} is below the minimum {minimum_chunk_size}"
                )));
            }

            let (ids, _) = scratch.vectors_mut();
            #[cfg(feature = "opt-level-select")]
            let telemetry =
                crate::pretokenize::fast::level_select::with_scalar_scanner(scalar_scanner, || {
                    encode_chunked_streaming(
                        &mut self.tokenizer,
                        |id| token_length(&self.token_lengths, id),
                        self.omega,
                        input,
                        chunk_size,
                        ids,
                    )
                })
                .map_err(js_error)?;
            #[cfg(not(feature = "opt-level-select"))]
            let telemetry = encode_chunked_streaming(
                &mut self.tokenizer,
                |id| token_length(&self.token_lengths, id),
                self.omega,
                input,
                chunk_size,
                ids,
            )
            .map_err(js_error)?;
            self.chunk_telemetry = telemetry.as_u32(chunk_size).map_err(js_error)?;
            Ok(js_sys::Uint32Array::from(ids.as_slice()))
        })();
        self.scratch = scratch;
        result
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = minimumChunkSize)]
    pub fn minimum_chunk_size(&self) -> Result<u32, JsError> {
        self.omega
            .checked_mul(2)
            .ok_or_else(|| JsError::new("minimum chunk size exceeds u32"))
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = defaultChunkSize)]
    pub fn default_chunk_size(&self) -> Result<u32, JsError> {
        self.omega
            .checked_mul(32)
            .ok_or_else(|| JsError::new("default chunk size exceeds u32"))
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = exportWorkerImage)]
    pub fn export_worker_image(&self) -> Result<Vec<u8>, JsError> {
        #[cfg(feature = "opt-resolver-provenance")]
        if let Some(image) = &self.resolver_worker_image {
            return Ok(image.to_vec());
        }
        self.worker_model
            .as_ref()
            .map(|model| model.to_bytes())
            .ok_or_else(|| JsError::new("worker images require a compatible .htk source"))
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = vocabularyDigest)]
    pub fn vocabulary_digest(&self) -> Result<Vec<u8>, JsError> {
        self.worker_model
            .as_ref()
            .map(|model| model.source_digest().to_vec())
            .ok_or_else(|| JsError::new("vocabulary identity requires a compatible .htk source"))
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = workerInputSupported)]
    pub fn worker_input_supported(&self, input: &[u8]) -> bool {
        self.worker_model.is_some()
            && !self.worker_unsupported_patterns.iter().any(|pattern| {
                input
                    .windows(pattern.len())
                    .any(|window| window == pattern.as_ref())
            })
    }

    #[cfg(feature = "htk")]
    #[wasm_bindgen(js_name = chunkTelemetry)]
    pub fn chunk_telemetry(&self) -> Vec<u32> {
        self.chunk_telemetry.to_vec()
    }

    /// Complete 64-byte blocks: examined, scalar-dispatched, mixed, ASCII.
    #[cfg(feature = "opt-block-dispatch")]
    #[wasm_bindgen(js_name = blockDispatchTelemetry)]
    pub fn block_dispatch_telemetry(&self, input: &[u8]) -> Result<Vec<u32>, JsError> {
        std::str::from_utf8(input).map_err(|_| JsError::new("input must be valid UTF-8"))?;
        Ok(crate::pretokenize::fast::block_dispatch::count_classes(input).to_vec())
    }

    #[wasm_bindgen(js_name = vocabSize)]
    pub fn vocab_size(&self) -> usize {
        self.tokenizer.vocab_size()
    }
}

#[cfg(feature = "decode-profile-api")]
#[cfg_attr(feature = "decode-profiling-sampling", inline(never))]
fn decode_profile_gather(
    tokenizer: &Tokenizer,
    token_lengths: &TokenLengths,
    ids: &[u32],
) -> Result<Vec<u8>, JsError> {
    for &id in ids {
        if token_length(token_lengths, id).is_none() {
            return Err(JsError::new(&format!("unknown token id {id}")));
        }
    }
    let ids = ids.iter().copied().map(TokenId::from).collect::<Vec<_>>();
    Ok(tokenizer.decode(&ids).collect::<Vec<_>>())
}

#[cfg(feature = "htk")]
#[wasm_bindgen]
pub struct WasmReservedEncoding {
    ids: Vec<u32>,
    starts: Vec<u32>,
    found_json: String,
}

#[cfg(feature = "htk")]
#[wasm_bindgen]
impl WasmReservedEncoding {
    pub fn ids(&self) -> Vec<u32> {
        self.ids.clone()
    }

    pub fn starts(&self) -> Vec<u32> {
        self.starts.clone()
    }

    #[wasm_bindgen(js_name = foundJson)]
    pub fn found_json(&self) -> String {
        self.found_json.clone()
    }
}

#[cfg(feature = "htk")]
#[wasm_bindgen]
pub struct WasmTransferredTokenizer {
    encoder: HtkWorkerEncoder,
    #[cfg(feature = "opt-scratch-reuse")]
    scratch: WasmScratch,
}

#[cfg(feature = "htk")]
#[wasm_bindgen]
impl WasmTransferredTokenizer {
    #[wasm_bindgen(js_name = fromWorkerImage)]
    pub fn from_worker_image(
        image: &[u8],
        expected_source_digest: &[u8],
    ) -> Result<WasmTransferredTokenizer, JsError> {
        crate::cold_construction::begin();
        let model =
            Arc::new(HtkWorkerModel::from_bytes(image, expected_source_digest).map_err(js_error)?);
        let tokenizer = Self {
            encoder: HtkWorkerEncoder::new(model),
            #[cfg(feature = "opt-scratch-reuse")]
            scratch: WasmScratch::new(),
        };
        crate::cold_construction::finish();
        Ok(tokenizer)
    }

    #[cfg(not(feature = "opt-scratch-reuse"))]
    #[wasm_bindgen(js_name = encodePretoken)]
    pub fn encode_pretoken(&mut self, input: &[u8]) -> Result<Vec<u32>, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        Ok(self.encoder.encode_pretoken(input))
    }

    #[cfg(feature = "opt-scratch-reuse")]
    #[wasm_bindgen(js_name = encodePretoken)]
    pub fn encode_pretoken_reused(&mut self, input: &[u8]) -> Result<js_sys::Uint32Array, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        self.encoder
            .encode_pretoken_into(input, self.scratch.output_mut());
        Ok(self.scratch.output_array())
    }

    #[cfg(feature = "opt-scratch-reuse")]
    #[wasm_bindgen(js_name = scratchOutputCapacityBytes)]
    pub fn scratch_output_capacity_bytes(&self) -> usize {
        self.scratch.output_capacity_bytes()
    }

    #[wasm_bindgen(js_name = vocabSize)]
    pub fn vocab_size(&self) -> usize {
        self.encoder.model().vocab_size()
    }

    #[wasm_bindgen(js_name = sourceDigest)]
    pub fn source_digest(&self) -> Vec<u8> {
        self.encoder.model().source_digest().to_vec()
    }
}

#[cfg(feature = "htk")]
fn flat_range(range: Option<Range<usize>>) -> Result<Vec<u32>, JsError> {
    match range {
        Some(range) => Ok(vec![
            u32::try_from(range.start)
                .map_err(|_| JsError::new("overlap range exceeds WebAssembly memory"))?,
            u32::try_from(range.end)
                .map_err(|_| JsError::new("overlap range exceeds WebAssembly memory"))?,
        ]),
        None => Ok(Vec::new()),
    }
}

#[cfg(feature = "htk")]
fn split_encoded_results(
    flat_ids: &[u32],
    lengths: &[u32],
    expected: usize,
) -> Result<Vec<Vec<u32>>, JsError> {
    if lengths.len() != expected {
        return Err(JsError::new(&format!(
            "received {} encoded ranges, expected {expected}",
            lengths.len()
        )));
    }
    let mut offset = 0_usize;
    let mut encoded = Vec::with_capacity(lengths.len());
    for &length in lengths {
        let length = usize::try_from(length)
            .map_err(|_| JsError::new("encoded range length exceeds usize"))?;
        let end = offset
            .checked_add(length)
            .ok_or_else(|| JsError::new("encoded range length overflow"))?;
        let ids = flat_ids
            .get(offset..end)
            .ok_or_else(|| JsError::new("encoded range lengths exceed the id buffer"))?;
        encoded.push(ids.to_vec());
        offset = end;
    }
    if offset != flat_ids.len() {
        return Err(JsError::new(
            "encoded range lengths do not consume the id buffer",
        ));
    }
    Ok(encoded)
}

/// Incremental overlap verifier used when initial ranges are encoded by
/// independent browser Workers. Boundary agreement and enlargement decisions
/// remain inside the same Rust implementation as synchronous chunking.
#[cfg(feature = "htk")]
#[wasm_bindgen]
pub struct WasmOverlapReconciler {
    ranges: Vec<Range<usize>>,
    state: Option<OverlapReconciliation>,
    token_lengths: TokenLengths,
}

#[cfg(feature = "htk")]
#[wasm_bindgen]
impl WasmOverlapReconciler {
    #[wasm_bindgen(js_name = initialRanges)]
    pub fn initial_ranges(&self) -> Result<Vec<u32>, JsError> {
        let mut flat = Vec::with_capacity(self.ranges.len() * 2);
        for range in &self.ranges {
            flat.extend(flat_range(Some(range.clone()))?);
        }
        Ok(flat)
    }

    #[wasm_bindgen(js_name = acceptInitial)]
    pub fn accept_initial(
        &mut self,
        flat_ids: &[u32],
        lengths: &[u32],
    ) -> Result<Vec<u32>, JsError> {
        if self.state.is_some() {
            return Err(JsError::new(
                "initial overlap results were already accepted",
            ));
        }
        let encoded = split_encoded_results(flat_ids, lengths, self.ranges.len())?;
        let token_lengths = &self.token_lengths;
        let state = OverlapReconciliation::new(self.ranges.clone(), encoded, &|id| {
            token_length(token_lengths, id)
        })
        .map_err(js_error)?;
        let requested = state.requested_range();
        self.state = Some(state);
        flat_range(requested)
    }

    #[wasm_bindgen(js_name = acceptEnlargement)]
    pub fn accept_enlargement(&mut self, ids: &[u32]) -> Result<Vec<u32>, JsError> {
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| JsError::new("initial overlap results are missing"))?;
        let token_lengths = &self.token_lengths;
        state
            .accept_enlargement(ids.to_vec(), &|id| token_length(token_lengths, id))
            .map_err(js_error)?;
        flat_range(state.requested_range())
    }

    #[wasm_bindgen(js_name = takeIds)]
    pub fn take_ids(&mut self) -> Result<Vec<u32>, JsError> {
        let state = self
            .state
            .take()
            .ok_or_else(|| JsError::new("initial overlap results are missing"))?;
        state.finish().map(|result| result.ids).map_err(js_error)
    }
}
