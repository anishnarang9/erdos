#![no_std]
#![forbid(unsafe_code)]

//! The UBC26 v1 wire formats and commitments shared by hosts and guests.

extern crate alloc;

mod bundle;

pub use bundle::{
    check_filename, decode_bundle, encode_bundle, BundleKind, NamedFile, MAX_FILES, MAX_NAME_BYTES,
};

use alloc::vec::Vec;
use chacha20poly1305::{
    aead::{AeadInPlace, KeyInit},
    ChaCha20Poly1305, Nonce, Tag,
};
use core::fmt;
use sha2::{Digest, Sha256};

pub const VERSION: u8 = 1;
pub const CONTEXT_BYTES: usize = 169;
pub const JOURNAL_BYTES: usize = 234;
pub const NONCE_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;

pub type Hash = [u8; 32];
pub type Key = [u8; 32];
pub type Address = [u8; 20];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    ContextLength,
    JournalLength,
    Version,
    Verdict,
    BundleSize,
    FileCount,
    FileName,
    FileOrder,
    TruncatedBundle,
    TrailingBundleBytes,
    EnvelopeLength,
    Authentication,
}

impl fmt::Display for WireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ContextLength => "Invalid funded context length",
            Self::JournalLength => "Invalid journal length",
            Self::Version => "Unsupported wire version",
            Self::Verdict => "Invalid journal verdict",
            Self::BundleSize => "Bundle exceeds its byte limit",
            Self::FileCount => "Bundle exceeds its file limit",
            Self::FileName => "Invalid bundle filename",
            Self::FileOrder => "Bundle filenames must be unique and sorted on the wire",
            Self::TruncatedBundle => "Incomplete bundle record or header",
            Self::TrailingBundleBytes => "Bundle has trailing bytes",
            Self::EnvelopeLength => "Invalid envelope length",
            Self::Authentication => "ChaCha20-Poly1305 operation failed",
        })
    }
}

impl core::error::Error for WireError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FundedContext {
    /// The chain ID encoded as a big-endian uint256.
    pub chain_id: [u8; 32],
    pub escrow: Address,
    /// The job ID encoded as a big-endian uint256.
    pub job_id: [u8; 32],
    pub provider: Address,
    pub rules_hash: Hash,
    pub reference_hash: Hash,
}

impl FundedContext {
    pub fn encode(&self) -> [u8; CONTEXT_BYTES] {
        let mut bytes = [0; CONTEXT_BYTES];
        bytes[0] = VERSION;
        bytes[1..33].copy_from_slice(&self.chain_id);
        bytes[33..53].copy_from_slice(&self.escrow);
        bytes[53..85].copy_from_slice(&self.job_id);
        bytes[85..105].copy_from_slice(&self.provider);
        bytes[105..137].copy_from_slice(&self.rules_hash);
        bytes[137..169].copy_from_slice(&self.reference_hash);
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        let bytes: &[u8; CONTEXT_BYTES] = bytes.try_into().map_err(|_| WireError::ContextLength)?;
        if bytes[0] != VERSION {
            return Err(WireError::Version);
        }
        Ok(Self {
            chain_id: bytes[1..33].try_into().unwrap(),
            escrow: bytes[33..53].try_into().unwrap(),
            job_id: bytes[53..85].try_into().unwrap(),
            provider: bytes[85..105].try_into().unwrap(),
            rules_hash: bytes[105..137].try_into().unwrap(),
            reference_hash: bytes[137..169].try_into().unwrap(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Verdict {
    Fail = 0,
    Pass = 1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Journal {
    pub context: FundedContext,
    pub verdict: Verdict,
    pub envelope_hash: Hash,
    pub key_commitment: Hash,
}

impl Journal {
    pub fn encode(&self) -> [u8; JOURNAL_BYTES] {
        let mut bytes = [0; JOURNAL_BYTES];
        bytes[..CONTEXT_BYTES].copy_from_slice(&self.context.encode());
        bytes[CONTEXT_BYTES] = self.verdict as u8;
        bytes[170..202].copy_from_slice(&self.envelope_hash);
        bytes[202..234].copy_from_slice(&self.key_commitment);
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        let bytes: &[u8; JOURNAL_BYTES] = bytes.try_into().map_err(|_| WireError::JournalLength)?;
        let context = FundedContext::decode(&bytes[..CONTEXT_BYTES])?;
        let verdict = match bytes[CONTEXT_BYTES] {
            0 => Verdict::Fail,
            1 => Verdict::Pass,
            _ => return Err(WireError::Verdict),
        };
        Ok(Self {
            context,
            verdict,
            envelope_hash: bytes[170..202].try_into().unwrap(),
            key_commitment: bytes[202..234].try_into().unwrap(),
        })
    }

    pub fn digest(&self) -> Hash {
        sha256(&self.encode())
    }
}

pub fn sha256(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}

pub fn structure_hash(structure_jcs: &[u8]) -> Hash {
    hash_parts(&[b"UBC26/structure/v1", structure_jcs])
}

pub fn rules_hash(structure_hash: &Hash, parameters_jcs: &[u8]) -> Hash {
    hash_parts(&[b"UBC26/rules/v1", structure_hash, &sha256(parameters_jcs)])
}

pub fn reference_hash(bundle: &[u8]) -> Hash {
    hash_parts(&[b"UBC26/reference/v1", bundle])
}

pub fn key_commitment(context: &FundedContext, key: &Key) -> Hash {
    hash_parts(&[b"UBC26/key/v1", &context.encode(), key])
}

fn hash_parts(parts: &[&[u8]]) -> Hash {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part);
    }
    hash.finalize().into()
}

/// Encrypts the exact canonical delivery bytes with the funded context as AAD.
/// The caller must generate a fresh key and nonce for each attempt.
pub fn encrypt_delivery(
    context: &FundedContext,
    key: &Key,
    nonce: &[u8; NONCE_BYTES],
    bundle: &[u8],
) -> Result<Vec<u8>, WireError> {
    decode_bundle(BundleKind::Delivery, bundle)?;
    let mut envelope = Vec::with_capacity(NONCE_BYTES + bundle.len() + TAG_BYTES);
    envelope.extend_from_slice(nonce);
    envelope.extend_from_slice(bundle);
    let tag = ChaCha20Poly1305::new(key.into())
        .encrypt_in_place_detached(
            nonce.into(),
            &context.encode(),
            &mut envelope[NONCE_BYTES..],
        )
        .map_err(|_| WireError::Authentication)?;
    envelope.extend_from_slice(&tag);
    Ok(envelope)
}

/// Authenticates the envelope and returns the exact canonical delivery bytes.
pub fn decrypt_delivery(
    context: &FundedContext,
    key: &Key,
    envelope: &[u8],
) -> Result<Vec<u8>, WireError> {
    let overhead = NONCE_BYTES + TAG_BYTES;
    if !(overhead..=overhead + BundleKind::Delivery.max_bytes()).contains(&envelope.len()) {
        return Err(WireError::EnvelopeLength);
    }

    let (nonce, encrypted) = envelope.split_at(NONCE_BYTES);
    let (ciphertext, tag) = encrypted.split_at(encrypted.len() - TAG_BYTES);
    let mut bundle = ciphertext.to_vec();
    ChaCha20Poly1305::new(key.into())
        .decrypt_in_place_detached(
            Nonce::from_slice(nonce),
            &context.encode(),
            &mut bundle,
            Tag::from_slice(tag),
        )
        .map_err(|_| WireError::Authentication)?;
    decode_bundle(BundleKind::Delivery, &bundle)?;
    Ok(bundle)
}
