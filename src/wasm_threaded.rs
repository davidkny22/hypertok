use crate::bpe::Tokenizer;
use crate::load_tokenizer::htk_chunk::{ChunkConfig, ChunkError, encode_overlap_batched};
use crate::load_tokenizer::htk_worker::{HtkWorkerEncoder, HtkWorkerModel};
#[cfg(feature = "source-loaders")]
use crate::load_tokenizer::tiktoken_slice::load_tiktoken_slice;
use crate::pretokenize::{Pretoken, PretokenizerType, SpanIter};
use rayon::prelude::*;
use std::ops::Range;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;

const DEFAULT_CHUNK_MULTIPLIER: usize = 32;

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

struct PrivateCachePool {
    slots: Vec<Mutex<PrivateEncoder>>,
    task_counts: Vec<AtomicU32>,
}

enum PrivateEncoder {
    Core(Tokenizer),
    Transferred(HtkWorkerEncoder),
}

impl PrivateEncoder {
    fn encode(&mut self, bytes: &[u8]) -> Vec<u32> {
        match self {
            Self::Core(tokenizer) => {
                let mut ids = Vec::new();
                tokenizer
                    .memoized_encode_flat(SpanIter(std::iter::once(Pretoken(bytes))), &mut ids);
                ids
            }
            Self::Transferred(encoder) => encoder.encode_pretoken(bytes),
        }
    }
}

impl PrivateCachePool {
    fn new(prototype: &Tokenizer, worker_count: usize) -> Self {
        Self {
            slots: (0..worker_count)
                .map(|_| Mutex::new(PrivateEncoder::Core(prototype.fork())))
                .collect(),
            task_counts: (0..worker_count).map(|_| AtomicU32::new(0)).collect(),
        }
    }

    fn from_worker_model(model: Arc<HtkWorkerModel>, worker_count: usize) -> Self {
        Self {
            slots: (0..worker_count)
                .map(|_| {
                    Mutex::new(PrivateEncoder::Transferred(HtkWorkerEncoder::new(
                        Arc::clone(&model),
                    )))
                })
                .collect(),
            task_counts: (0..worker_count).map(|_| AtomicU32::new(0)).collect(),
        }
    }

    fn reset_telemetry(&self) {
        for count in &self.task_counts {
            count.store(0, Ordering::Relaxed);
        }
    }

    fn active_workers(&self) -> usize {
        self.task_counts
            .iter()
            .filter(|count| count.load(Ordering::Relaxed) != 0)
            .count()
    }

    fn task_count(&self) -> u32 {
        self.task_counts
            .iter()
            .map(|count| count.load(Ordering::Relaxed))
            .sum()
    }

    fn encode(&self, bytes: &[u8]) -> Result<Vec<u32>, ChunkError> {
        let slot = rayon::current_thread_index().unwrap_or(0) % self.slots.len();
        let mut encoder = self.slots[slot]
            .lock()
            .map_err(|_| ChunkError::EncoderUnavailable)?;
        self.task_counts[slot].fetch_add(1, Ordering::Relaxed);
        Ok(encoder.encode(bytes))
    }
}

struct PretokenEncoding {
    ids: Vec<u32>,
    initial_chunks: usize,
    enlargements: usize,
}

/// Threaded byte-level tokenizer for a dedicated Web Worker controller.
/// Immutable model tables are shared in linear memory; each Rayon worker has
/// one private tokenizer fork and therefore one private pretoken cache.
#[wasm_bindgen]
pub struct ThreadedWasmTokenizer {
    pretokenizer: PretokenizerType,
    caches: PrivateCachePool,
    token_lengths: Vec<usize>,
    omega: u32,
    vocab_size: usize,
    telemetry: [u32; 5],
    source_digest: Option<[u8; 32]>,
}

#[wasm_bindgen]
impl ThreadedWasmTokenizer {
    #[cfg(feature = "source-loaders")]
    #[wasm_bindgen(js_name = fromTiktoken)]
    pub fn from_tiktoken(
        data: &[u8],
        scheme: &str,
        worker_count: u32,
    ) -> Result<ThreadedWasmTokenizer, JsError> {
        let pretokenizer = PretokenizerType::from_name(scheme).ok_or_else(|| {
            JsError::new(&format!(
                "unknown pretokenizer scheme {scheme:?}; expected one of {}",
                PretokenizerType::NAMES.join(", ")
            ))
        })?;
        let worker_count = usize::try_from(worker_count)
            .map_err(|_| JsError::new("worker count exceeds usize"))?;
        if worker_count == 0 {
            return Err(JsError::new("worker count must be positive"));
        }
        let actual_workers = rayon::current_num_threads();
        if actual_workers != worker_count {
            return Err(JsError::new(&format!(
                "thread pool has {actual_workers} workers, expected {worker_count}; call initThreadPool first"
            )));
        }

        let tokenizer = load_tiktoken_slice(data, pretokenizer, Vec::new()).map_err(js_error)?;
        let mut token_lengths = vec![0; tokenizer.vocab_size()];
        let mut omega = 0_u32;
        for (id, token) in tokenizer.vocab_entries() {
            let length = u32::try_from(token.len())
                .map_err(|_| JsError::new("token byte length exceeds the chunking limit"))?;
            token_lengths[id as usize] = token.len();
            omega = omega.max(length);
        }
        if omega == 0 {
            return Err(JsError::new("vocabulary has no non-empty tokens"));
        }

        Ok(Self {
            pretokenizer,
            caches: PrivateCachePool::new(&tokenizer, worker_count),
            token_lengths,
            omega,
            vocab_size: tokenizer.vocab_size(),
            telemetry: [0; 5],
            source_digest: None,
        })
    }

    #[wasm_bindgen(js_name = fromWorkerImage)]
    pub fn from_worker_image(
        image: &[u8],
        expected_source_digest: &[u8],
        worker_count: u32,
    ) -> Result<ThreadedWasmTokenizer, JsError> {
        let worker_count = usize::try_from(worker_count)
            .map_err(|_| JsError::new("worker count exceeds usize"))?;
        if worker_count == 0 {
            return Err(JsError::new("worker count must be positive"));
        }
        let actual_workers = rayon::current_num_threads();
        if actual_workers != worker_count {
            return Err(JsError::new(&format!(
                "thread pool has {actual_workers} workers, expected {worker_count}; call initThreadPool first"
            )));
        }
        let model =
            Arc::new(HtkWorkerModel::from_bytes(image, expected_source_digest).map_err(js_error)?);
        let token_lengths = (0..model.vocab_size())
            .map(|id| model.token_length(id as u32).unwrap_or(0))
            .collect();
        Ok(Self {
            pretokenizer: model.pretokenizer(),
            caches: PrivateCachePool::from_worker_model(Arc::clone(&model), worker_count),
            token_lengths,
            omega: model.omega(),
            vocab_size: model.vocab_size(),
            telemetry: [0; 5],
            source_digest: Some(model.source_digest()),
        })
    }

    pub fn encode(&mut self, input: &[u8]) -> Result<Vec<u32>, JsError> {
        std::str::from_utf8(input)
            .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))?;
        let base = input.as_ptr() as usize;
        let ranges = self
            .pretokenizer
            .pretokenize(input)
            .map(|pretoken| {
                let bytes = pretoken.as_ref();
                let start = bytes.as_ptr() as usize - base;
                start..start + bytes.len()
            })
            .collect::<Vec<Range<usize>>>();
        let chunk_size = usize::try_from(self.omega)
            .ok()
            .and_then(|omega| omega.checked_mul(DEFAULT_CHUNK_MULTIPLIER))
            .ok_or_else(|| JsError::new("default chunk size overflow"))?;
        let omega = self.omega;
        let token_lengths = &self.token_lengths;
        let caches = &self.caches;

        caches.reset_telemetry();
        let encoded = ranges
            .par_iter()
            .map(|range| {
                let pretoken = &input[range.clone()];
                if pretoken.len() <= chunk_size {
                    return caches.encode(pretoken).map(|ids| PretokenEncoding {
                        ids,
                        initial_chunks: 1,
                        enlargements: 0,
                    });
                }
                encode_overlap_batched(
                    pretoken,
                    omega,
                    ChunkConfig::default(),
                    false,
                    |chunk_ranges| {
                        chunk_ranges
                            .par_iter()
                            .map(|chunk_range| caches.encode(&pretoken[chunk_range.clone()]))
                            .collect()
                    },
                    |id| {
                        token_lengths
                            .get(id as usize)
                            .copied()
                            .filter(|length| *length != 0)
                    },
                )
                .map(|result| PretokenEncoding {
                    ids: result.ids,
                    initial_chunks: result.initial_chunks,
                    enlargements: result.enlargements,
                })
            })
            .collect::<Result<Vec<_>, ChunkError>>()
            .map_err(js_error)?;

        let mut ids = Vec::new();
        let mut initial_chunks = 0_usize;
        let mut enlargements = 0_usize;
        for result in encoded {
            initial_chunks = initial_chunks
                .checked_add(result.initial_chunks)
                .ok_or_else(|| JsError::new("thread telemetry overflow"))?;
            enlargements = enlargements
                .checked_add(result.enlargements)
                .ok_or_else(|| JsError::new("thread telemetry overflow"))?;
            ids.extend(result.ids);
        }
        let telemetry_value =
            |value| u32::try_from(value).map_err(|_| JsError::new("thread telemetry exceeds u32"));
        self.telemetry = [
            telemetry_value(ranges.len())?,
            caches.task_count(),
            telemetry_value(initial_chunks)?,
            telemetry_value(enlargements)?,
            telemetry_value(caches.active_workers())?,
        ];
        Ok(ids)
    }

    #[wasm_bindgen(js_name = threadTelemetry)]
    pub fn thread_telemetry(&self) -> Vec<u32> {
        self.telemetry.to_vec()
    }

    #[wasm_bindgen(js_name = workerCount)]
    pub fn worker_count(&self) -> usize {
        self.caches.slots.len()
    }

    #[wasm_bindgen(js_name = vocabSize)]
    pub fn vocab_size(&self) -> usize {
        self.vocab_size
    }

    #[wasm_bindgen(js_name = importedWorkerImage)]
    pub fn imported_worker_image(&self) -> bool {
        self.source_digest.is_some()
    }

    #[wasm_bindgen(js_name = sourceDigest)]
    pub fn source_digest(&self) -> Vec<u8> {
        self.source_digest
            .map_or_else(Vec::new, |digest| digest.to_vec())
    }
}
