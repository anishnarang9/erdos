use crate::{WireError, VERSION};
use alloc::vec::Vec;

pub const MAX_FILES: usize = 16;
pub const MAX_NAME_BYTES: usize = 128;
const HEADER_BYTES: usize = 3;
const RECORD_LENGTH_BYTES: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BundleKind {
    Delivery,
    Reference,
    Evidence,
}

impl BundleKind {
    pub const fn max_bytes(self) -> usize {
        match self {
            Self::Delivery => 16 * 1024,
            Self::Reference | Self::Evidence => 32 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NamedFile<'a> {
    pub name: &'a str,
    pub contents: &'a [u8],
}

/// Encodes named files in ascending filename byte order.
pub fn encode_bundle(kind: BundleKind, files: &[NamedFile<'_>]) -> Result<Vec<u8>, WireError> {
    if files.len() > MAX_FILES {
        return Err(WireError::FileCount);
    }

    let mut size = HEADER_BYTES;
    for file in files {
        check_filename(file.name)?;
        size += RECORD_LENGTH_BYTES + file.name.len();
        size = size
            .checked_add(file.contents.len())
            .filter(|&length| length <= kind.max_bytes())
            .ok_or(WireError::BundleSize)?;
    }

    let mut ordered = files.to_vec();
    ordered.sort_unstable_by_key(|file| file.name);
    if ordered.windows(2).any(|pair| pair[0].name == pair[1].name) {
        return Err(WireError::FileOrder);
    }

    let mut bytes = Vec::with_capacity(size);
    bytes.push(VERSION);
    bytes.extend_from_slice(&(ordered.len() as u16).to_be_bytes());
    for file in ordered {
        bytes.extend_from_slice(&(file.name.len() as u16).to_be_bytes());
        bytes.extend_from_slice(file.name.as_bytes());
        bytes.extend_from_slice(&(file.contents.len() as u32).to_be_bytes());
        bytes.extend_from_slice(file.contents);
    }
    Ok(bytes)
}

/// Validates a canonical bundle and borrows its names and contents.
pub fn decode_bundle(kind: BundleKind, mut bytes: &[u8]) -> Result<Vec<NamedFile<'_>>, WireError> {
    if bytes.len() > kind.max_bytes() {
        return Err(WireError::BundleSize);
    }

    let header = take(&mut bytes, HEADER_BYTES)?;
    if header[0] != VERSION {
        return Err(WireError::Version);
    }
    let count = u16::from_be_bytes([header[1], header[2]]) as usize;
    if count > MAX_FILES {
        return Err(WireError::FileCount);
    }

    let mut files = Vec::with_capacity(count);
    let mut previous = "";
    for _ in 0..count {
        let name_length = u16::from_be_bytes(take(&mut bytes, 2)?.try_into().unwrap());
        let name_bytes = take(&mut bytes, usize::from(name_length))?;
        let name = core::str::from_utf8(name_bytes).map_err(|_| WireError::FileName)?;
        check_filename(name)?;
        if name <= previous {
            return Err(WireError::FileOrder);
        }
        previous = name;

        let length = u32::from_be_bytes(take(&mut bytes, 4)?.try_into().unwrap());
        let length = usize::try_from(length).map_err(|_| WireError::BundleSize)?;
        let contents = take(&mut bytes, length)?;
        files.push(NamedFile { name, contents });
    }
    if !bytes.is_empty() {
        return Err(WireError::TrailingBundleBytes);
    }
    Ok(files)
}

fn take<'a>(bytes: &mut &'a [u8], count: usize) -> Result<&'a [u8], WireError> {
    let (field, remainder) = bytes
        .split_at_checked(count)
        .ok_or(WireError::TruncatedBundle)?;
    *bytes = remainder;
    Ok(field)
}

pub fn check_filename(name: &str) -> Result<(), WireError> {
    let name = name.as_bytes();
    if !(1..=MAX_NAME_BYTES).contains(&name.len())
        || matches!(name, b"." | b"..")
        || !name
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(WireError::FileName);
    }
    Ok(())
}
