pub(crate) mod bpe;
pub(crate) mod cold_construction;
#[cfg(feature = "opt-decode-assembly")]
pub(crate) mod decode_assembly;
#[cfg(feature = "decode-profiling")]
pub(crate) mod decode_profiling;
pub mod pretokenize;
#[cfg(feature = "profiling")]
pub(crate) mod profiling;
pub(crate) mod token;
#[cfg(feature = "wasm-binding")]
pub mod wasm;
#[cfg(feature = "opt-decode-boundary")]
pub(crate) mod wasm_resident_ids;
#[cfg(feature = "opt-marshalling")]
pub(crate) mod wasm_resident_input;
#[cfg(feature = "opt-encode-into")]
pub(crate) mod wasm_resident_output;
#[cfg(feature = "opt-scratch-reuse")]
pub(crate) mod wasm_scratch;
#[cfg(all(
    feature = "wasm-binding",
    feature = "htk",
    any(feature = "sentencepiece", feature = "sentencepiece-core")
))]
pub mod wasm_sentencepiece;
#[cfg(all(feature = "threaded-wasm", target_arch = "wasm32"))]
pub mod wasm_threaded;

pub use crate::bpe::Tokenizer;
#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
pub use crate::bpe::sentencepiece::EncodeState;
#[cfg(all(feature = "threaded-wasm", target_arch = "wasm32"))]
pub use wasm_bindgen_rayon::init_thread_pool;

pub mod load_tokenizer;
