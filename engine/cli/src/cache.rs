use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
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
    let _lock = lock_entry(root, fingerprint).ok()?;
    load_entry(root, fingerprint)
}

// Keep the lock file in place. Removing it could let writers lock different inodes.
// File closes and releases the operating system lock on return or process exit.
fn lock_entry(root: &Path, fingerprint: &str) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(root.join(format!(".lock-{fingerprint}")))?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("Expected a regular cache lock file"));
    }
    file.lock()?;
    Ok(file)
}

fn load_entry(root: &Path, fingerprint: &str) -> Option<Vec<u8>> {
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
    let _lock = lock_entry(root, fingerprint)?;
    let target = root.join(fingerprint);
    if target.symlink_metadata().is_ok() {
        if let Some(cached) = load_entry(root, fingerprint) {
            if cached != guest {
                return Err(io::Error::other(
                    "Guest program bytes differ for the same build fingerprint",
                ));
            }
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
    publish_directory(stage.path(), &target)
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::sync::{Arc, Barrier};
    use std::thread;

    use super::*;

    fn guest(instruction: u32) -> Vec<u8> {
        // A minimal ELF32 RISC-V executable with one four-byte load segment.
        let mut elf = vec![0; 88];
        elf[..7].copy_from_slice(b"\x7fELF\x01\x01\x01");
        elf[16..18].copy_from_slice(&2u16.to_le_bytes());
        elf[18..20].copy_from_slice(&243u16.to_le_bytes());
        elf[20..24].copy_from_slice(&1u32.to_le_bytes());
        elf[24..28].copy_from_slice(&0x0020_0800u32.to_le_bytes());
        elf[28..32].copy_from_slice(&52u32.to_le_bytes());
        elf[40..42].copy_from_slice(&52u16.to_le_bytes());
        elf[42..44].copy_from_slice(&32u16.to_le_bytes());
        elf[44..46].copy_from_slice(&1u16.to_le_bytes());
        for (index, value) in [1u32, 84, 0x0020_0800, 0x0020_0800, 4, 4, 5, 4]
            .into_iter()
            .enumerate()
        {
            elf[52 + index * 4..56 + index * 4].copy_from_slice(&value.to_le_bytes());
        }
        elf[84..88].copy_from_slice(&instruction.to_le_bytes());
        risc0_binfmt::ProgramBinary::new(&elf, risc0_zkos_v1compat::V1COMPAT_ELF).encode()
    }

    #[test]
    fn concurrent_writers_repair_one_invalid_entry() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("fingerprint");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("entry.json"), b"invalid").unwrap();
        let guest = guest(0x0000_0073);
        let barrier = Arc::new(Barrier::new(8));
        thread::scope(|scope| {
            let mut writers = Vec::new();
            for _ in 0..8 {
                let barrier = Arc::clone(&barrier);
                let guest = &guest;
                let root = root.path();
                writers.push(scope.spawn(move || {
                    barrier.wait();
                    store(root, "fingerprint", guest)
                }));
            }
            for writer in writers {
                writer.join().unwrap().unwrap();
            }
        });
        assert_eq!(load(root.path(), "fingerprint"), Some(guest));
        let quarantines = fs::read_dir(root.path())
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "cache")
            })
            .collect::<Vec<_>>();
        assert_eq!(quarantines.len(), 1);
        assert_eq!(
            fs::read(quarantines[0].path().join("entry.json")).unwrap(),
            b"invalid"
        );
    }

    #[test]
    fn rejects_different_program_bytes_for_the_same_fingerprint() {
        let root = tempfile::tempdir().unwrap();
        let original = guest(0x0000_0073);
        let different = guest(0x0000_0013);
        assert_ne!(
            risc0_zkvm::compute_image_id(&original).unwrap(),
            risc0_zkvm::compute_image_id(&different).unwrap()
        );
        store(root.path(), "fingerprint", &original).unwrap();
        store(root.path(), "fingerprint", &original).unwrap();
        let error = store(root.path(), "fingerprint", &different).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Guest program bytes differ for the same build fingerprint"
        );
        assert_eq!(load(root.path(), "fingerprint"), Some(original));
    }

    #[test]
    fn lock_excludes_other_processes_and_releases_on_drop() {
        let root = tempfile::tempdir().unwrap();
        let lock = lock_entry(root.path(), "fingerprint").unwrap();
        let child = |blocked: bool| {
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "cache::tests::check_lock_in_child"])
                .env("UBC26_TEST_CACHE_LOCK", root.path())
                .env("UBC26_TEST_CACHE_BLOCKED", blocked.to_string())
                .output()
                .unwrap()
        };
        let output = child(true);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        drop(lock);
        let output = child(false);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    #[test]
    fn check_lock_in_child() {
        let Some(root) = std::env::var_os("UBC26_TEST_CACHE_LOCK") else {
            return;
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(Path::new(&root).join(".lock-fingerprint"))
            .unwrap();
        match std::env::var("UBC26_TEST_CACHE_BLOCKED").unwrap().as_str() {
            "true" => assert!(matches!(
                file.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            )),
            "false" => file.try_lock().unwrap(),
            _ => panic!("Invalid lock test mode"),
        }
    }
}
