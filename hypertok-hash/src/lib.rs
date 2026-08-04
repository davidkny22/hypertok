mod image;
mod table;

#[cfg(all(feature = "builder", not(target_arch = "wasm32")))]
mod builder;

#[cfg(all(feature = "builder", target_arch = "wasm32"))]
compile_error!("the builder feature is native-only");

#[cfg(all(feature = "builder", not(target_arch = "wasm32")))]
pub use builder::{BuildError, build};
pub use image::{HashImage, ImageError, VerifyError, fingerprint, table_hash};
pub use table::{
    DEFAULT_TABLE_LOAD_PERMILLE, FingerprintTable, TableBuildError, TableImageError, TableKey,
};
