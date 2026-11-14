use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ubc26_protocol::{sha256, strict_json};

use crate::files::{publish_directory, read_input};
use crate::package::as_hex;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    fingerprint: String,
    image_id: String,
    guest_sha256: String,
}

pub(crate) fn directory() -> io::Result<PathBuf> {
    let root = std::env::var_os("UBC26_ENGINE_CACHE")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
                .map(|base| base.join("ubc26-engine-v1"))
        })
        .ok_or_else(|| io::Error::other("Set UBC26_ENGINE_CACHE to a cache directory"))?;
    fs::create_dir_all(&root)?;
    Ok(root)
}

pub(crate) fn load(root: &Path, fingerprint: &str) -> Option<Vec<u8>> {
    let path = root.join(fingerprint);
    let bytes = read_input(&path.join("entry.json"), 4096, "invalid_cache").ok()?;
    let entry: Entry = serde_json::from_value(strict_json::from_slice(&bytes).ok()?).ok()?;
    let guest = read_input(&path.join("guest.elf"), 16 * 1024 * 1024, "invalid_cache").ok()?;
    let image = risc0_zkvm::compute_image_id(&guest).ok()?;
    if entry.fingerprint != fingerprint
        || entry.image_id != format!("0x{image}")
        || entry.guest_sha256 != as_hex(&sha256(&guest))
    {
        return None;
    }
    Some(guest)
}

pub(crate) fn store(root: &Path, fingerprint: &str, guest: &[u8]) -> io::Result<()> {
    let image = risc0_zkvm::compute_image_id(guest).map_err(io::Error::other)?;
    let entry = Entry {
        fingerprint: fingerprint.into(),
        image_id: format!("0x{image}"),
        guest_sha256: as_hex(&sha256(guest)),
    };
    let target = root.join(fingerprint);
    if target.symlink_metadata().is_ok() {
        if load(root, fingerprint).is_some() {
            return Ok(());
        }
        // Retain invalid cache data for inspection and let this build repair the entry.
        let placeholder = tempfile::Builder::new()
            .prefix(".invalid-")
            .tempdir_in(root)?;
        let quarantine = placeholder.path().with_extension("cache");
        fs::rename(&target, quarantine)?;
    }
    let stage = tempfile::Builder::new()
        .prefix(".build-")
        .tempdir_in(root)?;
    fs::write(stage.path().join("guest.elf"), guest)?;
    fs::write(stage.path().join("entry.json"), serde_json::to_vec(&entry)?)?;
    match publish_directory(stage.path(), &target) {
        Ok(()) => Ok(()),
        Err(_) if load(root, fingerprint).is_some() => Ok(()),
        Err(err) => Err(err),
    }
}
