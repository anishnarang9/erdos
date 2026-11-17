use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use rustix::fs::{openat, Dir, Mode, OFlags};
use serde_json::{json, Value};
use ubc26_protocol::{check_filename, encode_bundle, BundleKind, NamedFile, MAX_FILES};

pub(crate) fn error(code: &str, message: impl std::fmt::Display) -> Value {
    json!({"code": code, "message": message.to_string()})
}

pub(crate) fn read_input(path: &Path, limit: usize, code: &str) -> Result<Vec<u8>, Value> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|err| error(code, err))?;
    read_bounded(file, limit).map_err(|err| error(code, err))
}

fn read_bounded(file: File, limit: usize) -> io::Result<Vec<u8>> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::other("Expected a regular file"));
    }
    if metadata.len() > limit as u64 {
        return Err(io::Error::other("Input exceeds its byte limit"));
    }

    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::other("Input exceeds its byte limit"));
    }
    Ok(bytes)
}

pub(crate) fn import_bundle(path: &Path, kind: BundleKind) -> Result<Vec<u8>, Value> {
    let bundle_error = |err: io::Error| error("bundle_input", err);
    // Remove trailing separators so the final-component symlink check applies.
    let path: PathBuf = path.components().collect();
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&path)
        .map_err(bundle_error)?;

    let mut files = Vec::new();
    // The wire header uses three bytes. Each record has six length bytes.
    let mut remaining = kind.max_bytes() - 3;
    let entries = Dir::read_from(&directory).map_err(|err| bundle_error(err.into()))?;
    for entry in entries {
        let entry = entry.map_err(|err| bundle_error(err.into()))?;
        let name = entry.file_name();
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        if files.len() == MAX_FILES {
            return Err(error("bundle_input", "Bundle exceeds its file limit"));
        }
        let filename = name
            .to_str()
            .map_err(|_| error("bundle_input", "Invalid bundle filename"))?;
        check_filename(filename).map_err(|err| error("bundle_input", err))?;
        remaining = remaining
            .checked_sub(6 + filename.len())
            .ok_or_else(|| error("bundle_input", "Bundle exceeds its byte limit"))?;
        let file = openat(
            &directory,
            name,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|err| bundle_error(err.into()))?;
        let contents = read_bounded(file, remaining).map_err(bundle_error)?;
        remaining -= contents.len();
        files.push((filename.to_owned(), contents));
    }

    let named_files: Vec<_> = files
        .iter()
        .map(|(name, contents)| NamedFile { name, contents })
        .collect();
    encode_bundle(kind, &named_files).map_err(|err| error("bundle_input", err))
}

pub(crate) fn publish_directory(stage: &Path, target: &Path) -> io::Result<()> {
    let stage = CString::new(stage.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    // Publish the complete directory without replacing an existing destination.
    #[cfg(target_os = "macos")]
    let status = unsafe { libc::renamex_np(stage.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let status = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            stage.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;

    use ubc26_protocol::decode_bundle;

    use super::*;

    #[test]
    fn imports_sorted_files_at_the_wire_limit() {
        let dir = tempfile::tempdir().unwrap();
        let kind = BundleKind::Delivery;
        let contents = vec![1; kind.max_bytes() - 3 - 2 * 7];
        fs::write(dir.path().join("z"), &contents).unwrap();
        fs::write(dir.path().join("a"), []).unwrap();
        let bundle = import_bundle(dir.path(), kind).unwrap();
        assert_eq!(bundle.len(), kind.max_bytes());
        let files = decode_bundle(kind, &bundle).unwrap();
        assert_eq!(files[0].name, "a");
        assert_eq!(files[1].contents, contents);

        fs::write(dir.path().join("a"), [1]).unwrap();
        assert!(import_bundle(dir.path(), kind).is_err());
    }

    #[test]
    fn rejects_symbolic_links_and_nested_directories() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("bundle");
        let file = root.path().join("file");
        fs::create_dir(&dir).unwrap();
        fs::write(&file, []).unwrap();

        let link = root.path().join("link");
        symlink(&dir, &link).unwrap();
        assert!(import_bundle(&link, BundleKind::Delivery).is_err());
        assert!(import_bundle(&link.join("."), BundleKind::Delivery).is_err());

        let entry = dir.join("entry");
        symlink(&file, &entry).unwrap();
        assert!(import_bundle(&dir, BundleKind::Delivery).is_err());

        fs::remove_file(&entry).unwrap();
        fs::create_dir(&entry).unwrap();
        assert!(import_bundle(&dir, BundleKind::Delivery).is_err());
    }
}
