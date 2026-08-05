mod digest;
mod error;
mod reader;
mod schema;
mod varint;

pub use digest::{DIGEST_RANGE, compute_digest};
pub use error::{ReadError, VarintError};
pub use reader::{LengthIter, TokenIter, ValidatedFile};
pub use schema::{
    BYTE_BPE_EXHAUSTIVE_SPLITS_FLAG, BYTE_BPE_IGNORE_MERGES_FLAG, DecoderStepKind, FORMAT_VERSION,
    HEADER_LEN, HashScheme, Header, MAGIC, MAX_VOCAB_SIZE, NamedPattern, NormStepKind,
    PostPosition, PretokStepKind, SECTION_TABLE_ENTRY_LEN, SectionEntry, SectionId,
    StructuralClass,
};
pub use varint::{decode_u32, encode_u32};
