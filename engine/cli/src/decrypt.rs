use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use serde_json::{json, Value};
use ubc26_protocol::{
    decode_bundle, decrypt_delivery, key_commitment, sha256, strict_json, BundleKind,
    FundedContext, Journal, NamedFile, Verdict, CONTEXT_BYTES, JOURNAL_BYTES, NONCE_BYTES,
    TAG_BYTES, VERSION,
};

use crate::files::{error, publish_directory, read_input};

const ENVELOPE_LIMIT: usize = BundleKind::Delivery.max_bytes() + NONCE_BYTES + TAG_BYTES;
const SUBMISSION_LIMIT: usize = 128 * 1024;

pub(crate) fn decrypt(submission: &Path, key_file: &Path, out: &Path) -> Result<Value, Value> {
    let submission = read_input(submission, SUBMISSION_LIMIT, "submission_input")?;
    let submission: Value =
        strict_json::from_slice(&submission).map_err(|err| error("invalid_submission", err))?;
    if submission["version"].as_u64() != Some(u64::from(VERSION))
        || submission["verdict"].as_u64() != Some(Verdict::Pass as u64)
    {
        return Err(error(
            "invalid_submission",
            "Expected a version 1 passing submission",
        ));
    }

    let context_bytes = submission_hex(&submission, "context", CONTEXT_BYTES)?;
    let context =
        FundedContext::decode(&context_bytes).map_err(|err| error("invalid_submission", err))?;
    let journal_bytes = submission_hex(&submission, "journal", JOURNAL_BYTES)?;
    let journal =
        Journal::decode(&journal_bytes).map_err(|err| error("invalid_submission", err))?;
    let envelope = submission_hex(&submission, "envelope", ENVELOPE_LIMIT)?;
    let commitment = submission_hex(&submission, "keyCommitment", 32)?;
    if journal.context != context
        || journal.verdict != Verdict::Pass
        || journal.key_commitment.as_slice() != commitment
        || journal.envelope_hash != sha256(&envelope)
    {
        return Err(error(
            "journal_mismatch",
            "Submission fields differ from the journal",
        ));
    }

    let key = read_input(key_file, 67, "key_input")?;
    let key = key.strip_suffix(b"\n").unwrap_or(&key);
    let key = key
        .strip_prefix(b"0x")
        .filter(|bytes| {
            bytes.len() == 64
                && bytes
                    .iter()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })
        .and_then(|bytes| hex::decode(bytes).ok())
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| {
            error(
                "invalid_key",
                "Expected a 32-byte key in lowercase 0x-prefixed hex",
            )
        })?;
    if key_commitment(&context, &key) != journal.key_commitment {
        return Err(error(
            "key_mismatch",
            "The key differs from the journal commitment",
        ));
    }

    let bundle = decrypt_delivery(&context, &key, &envelope)
        .map_err(|err| error("invalid_envelope", err))?;
    let files = decode_bundle(BundleKind::Delivery, &bundle)
        .map_err(|err| error("invalid_envelope", err))?;
    write_bundle(out, &files).map_err(|err| error("output_io", err))?;
    Ok(json!({"files": files.len()}))
}

fn submission_hex(submission: &Value, field: &str, limit: usize) -> Result<Vec<u8>, Value> {
    submission[field]
        .as_str()
        .and_then(|text| text.strip_prefix("0x"))
        .filter(|text| text.len() <= limit * 2)
        .and_then(|text| hex::decode(text).ok())
        .ok_or_else(|| error("invalid_submission", format!("Invalid {field} hex")))
}

fn write_bundle(out: &Path, files: &[NamedFile<'_>]) -> io::Result<()> {
    let parent = out
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = out
        .file_name()
        .ok_or_else(|| io::Error::other("Expected an output directory path"))?;
    let target = parent.join(name);
    let stage = tempfile::Builder::new()
        .prefix(".engine-decrypt-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(parent)?;
    for file in files {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(stage.path().join(file.name))?
            .write_all(file.contents)?;
    }
    publish_directory(stage.path(), &target)
}
