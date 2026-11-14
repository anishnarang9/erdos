use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use include_dir::{include_dir, Dir};
use risc0_binfmt::ProgramBinary;
use risc0_zkvm::compute_image_id;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ubc26_compiler::{validate_plan, MAX_PLAN_BYTES};
use ubc26_protocol::{reference_hash, sha256, strict_json, BundleKind};

use crate::files::{error, import_bundle, publish_directory, read_input};

const TEMPLATE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/src/checker-template");
const PROTOCOL_SOURCE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../protocol/src");
const RUNTIME_SOURCE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../guest-runtime/src");
const PROTOCOL_MANIFEST: &[u8] = include_bytes!("../../protocol/Cargo.toml");
const RUNTIME_MANIFEST: &[u8] = include_bytes!("../../guest-runtime/Cargo.toml");
const MAX_ELF_BYTES: usize = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 8 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    version: u8,
    pub(crate) image_id: String,
    pub(crate) structure_hash: String,
    pub(crate) rules_hash: String,
    pub(crate) reference_hash: String,
    guest_sha256: String,
    parameters_sha256: String,
    structure_sha256: String,
    guest_builder: String,
    risc_zero: String,
}

pub(crate) struct Package {
    pub(crate) manifest: Manifest,
    pub(crate) guest: Vec<u8>,
    pub(crate) parameters: Vec<u8>,
    pub(crate) structure: Vec<u8>,
}

pub(crate) fn as_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

pub(crate) fn stage_output(out: &Path, prefix: &str) -> Result<tempfile::TempDir, Value> {
    use std::os::unix::fs::PermissionsExt;
    if out.file_name().is_none() {
        return Err(error("output_io", "Expected an output directory path"));
    }
    let parent = out
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    tempfile::Builder::new()
        .prefix(prefix)
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(parent)
        .map_err(|err| error("output_io", err))
}

fn copy_crate(path: &Path, manifest: &[u8], source: &Dir<'_>) -> io::Result<()> {
    fs::create_dir(path)?;
    fs::write(path.join("Cargo.toml"), manifest)?;
    let src = path.join("src");
    fs::create_dir(&src)?;
    source.extract(src)
}

fn extract_template(path: &Path, structure: &[u8]) -> io::Result<()> {
    TEMPLATE.extract(path)?;
    fs::write(path.join("structure.jcs"), structure)?;
    copy_crate(&path.join("protocol"), PROTOCOL_MANIFEST, &PROTOCOL_SOURCE)?;
    copy_crate(
        &path.join("guest-runtime"),
        RUNTIME_MANIFEST,
        &RUNTIME_SOURCE,
    )
}

fn build_guest(structure: &[u8]) -> Result<Vec<u8>, Value> {
    let build_error = |err: io::Error| error("build_failure", err);
    let stage = tempfile::tempdir().map_err(build_error)?;
    let input = stage.path().join("source");
    let output = stage.path().join("output");
    fs::create_dir(&input).map_err(build_error)?;
    extract_template(&input, structure).map_err(build_error)?;
    let mut export = std::ffi::OsString::from("type=local,dest=");
    export.push(&output);
    let status = Command::new("docker")
        .args(["build", "--platform", "linux/amd64", "--output"])
        .arg(export)
        .arg(&input)
        .stdin(Stdio::null())
        .stdout(Stdio::from(io::stderr()))
        .status()
        .map_err(build_error)?;
    if !status.success() {
        return Err(error(
            "build_failure",
            format!("Guest build failed with {status}"),
        ));
    }
    let user = read_input(&output.join("checker"), MAX_ELF_BYTES, "build_failure")?;
    Ok(ProgramBinary::new(&user, risc0_zkos_v1compat::V1COMPAT_ELF).encode())
}

pub(crate) fn compile(plan: &Path, reference: &Path, out: &Path) -> Result<Value, Value> {
    let plan = read_input(plan, MAX_PLAN_BYTES, "input_io")?;
    let validated = validate_plan(&plan).map_err(|err| json!(err))?;
    let report = json!(validated);
    let structure = report["structureJcs"]
        .as_str()
        .expect("validated structure")
        .as_bytes();
    let parameters = report["parametersJcs"]
        .as_str()
        .expect("validated parameters")
        .as_bytes();
    let reference = import_bundle(reference, BundleKind::Reference)?;
    ubc26_guest_runtime::validate_reference(structure, &reference)
        .map_err(|err| error("invalid_reference", err))?;
    let stage = stage_output(out, ".engine-compile-")?;
    let guest = build_guest(structure)?;
    let image_id = compute_image_id(&guest).map_err(|err| error("build_failure", err))?;
    let manifest = Manifest {
        version: 1,
        image_id: format!("0x{image_id}"),
        structure_hash: report["structureHash"].as_str().expect("structure hash").into(),
        rules_hash: report["rulesHash"].as_str().expect("rules hash").into(),
        reference_hash: as_hex(&reference_hash(&reference)),
        guest_sha256: as_hex(&sha256(&guest)),
        parameters_sha256: as_hex(&sha256(parameters)),
        structure_sha256: as_hex(&sha256(structure)),
        guest_builder: "risczero/risc0-guest-builder:r0.1.97.0@sha256:6f6c300e4af57ea3efe62b7f04a17629efe0f0caa6ad3699d6766bf19e0e62fb".into(),
        risc_zero: "3.1.0".into(),
    };
    for (name, contents) in [
        ("guest.elf", guest.as_slice()),
        ("structure.jcs", structure),
        ("parameters.jcs", parameters),
    ] {
        fs::write(stage.path().join(name), contents).map_err(|err| error("output_io", err))?;
    }
    let manifest = json!(manifest);
    let mut file = fs::File::create(stage.path().join("manifest.json"))
        .map_err(|err| error("output_io", err))?;
    serde_json::to_writer_pretty(&mut file, &manifest).map_err(|err| error("output_io", err))?;
    writeln!(file).map_err(|err| error("output_io", err))?;
    publish_directory(stage.path(), out).map_err(|err| error("output_io", err))?;
    Ok(manifest)
}

pub(crate) fn load(dir: &Path) -> Result<Package, Value> {
    let bad_package = "invalid_package";
    let bytes = read_input(&dir.join("manifest.json"), MAX_MANIFEST_BYTES, bad_package)?;
    let manifest: Manifest = serde_json::from_value(
        strict_json::from_slice(&bytes).map_err(|err| error(bad_package, err))?,
    )
    .map_err(|err| error(bad_package, err))?;
    let guest = read_input(&dir.join("guest.elf"), MAX_ELF_BYTES, bad_package)?;
    let structure = read_input(&dir.join("structure.jcs"), MAX_PLAN_BYTES, bad_package)?;
    let parameters = read_input(&dir.join("parameters.jcs"), MAX_PLAN_BYTES, bad_package)?;
    let image = compute_image_id(&guest).map_err(|err| error(bad_package, err))?;
    let structure_hash = ubc26_protocol::structure_hash(&structure);
    if manifest.version != 1
        || manifest.guest_sha256 != as_hex(&sha256(&guest))
        || manifest.structure_sha256 != as_hex(&sha256(&structure))
        || manifest.parameters_sha256 != as_hex(&sha256(&parameters))
        || manifest.image_id != format!("0x{image}")
        || manifest.structure_hash != as_hex(&structure_hash)
        || manifest.rules_hash != as_hex(&ubc26_protocol::rules_hash(&structure_hash, &parameters))
    {
        return Err(error(
            bad_package,
            "Checker package commitments differ from its files",
        ));
    }
    Ok(Package {
        manifest,
        guest,
        parameters,
        structure,
    })
}
