use hypertok_format::{ReadError, ValidatedFile, compute_digest};

pub(crate) enum DigestGate<'a> {
    Trusted,
    Untrusted(ValidatedFile<'a>),
}

pub(crate) fn validate_or_trust(
    bytes: &[u8],
    trusted_digest: Option<[u8; 32]>,
) -> Result<DigestGate<'_>, ReadError> {
    let actual = digest(bytes);
    if trusted_digest.is_some_and(|expected| expected == actual) {
        Ok(DigestGate::Trusted)
    } else {
        ValidatedFile::read(bytes).map(DigestGate::Untrusted)
    }
}

pub(crate) fn digest(bytes: &[u8]) -> [u8; 32] {
    compute_digest(bytes)
}
