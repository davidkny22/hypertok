use super::{DigestGate, digest, validate_or_trust};
use hypertok_format::{DIGEST_RANGE, ReadError};

fn tracked_vocabulary() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("hypertok-vocab/gpt2/vocab.htk"),
    )
    .expect("read tracked GPT-2 vocabulary")
}

#[test]
fn externally_trusted_digest_selects_the_fast_path() {
    let bytes = tracked_vocabulary();
    let trusted = digest(&bytes);
    assert!(matches!(
        validate_or_trust(&bytes, Some(trusted)).expect("trusted digest match"),
        DigestGate::Trusted
    ));
}

#[test]
fn absent_trust_uses_the_full_validation_path() {
    let bytes = tracked_vocabulary();
    assert!(matches!(
        validate_or_trust(&bytes, None).expect("ordinary validation"),
        DigestGate::Untrusted(_)
    ));
}

#[test]
fn self_consistent_header_digest_cannot_bypass_external_trust() {
    let bytes = tracked_vocabulary();
    let trusted = digest(&bytes);
    let mut malformed = bytes;
    malformed[0] ^= 1;
    let self_declared = digest(&malformed);
    malformed[DIGEST_RANGE].copy_from_slice(&self_declared);
    assert!(matches!(
        validate_or_trust(&malformed, Some(trusted)),
        Err(ReadError::MagicMismatch)
    ));
}
