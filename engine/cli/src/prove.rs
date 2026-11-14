use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

use risc0_ethereum_contracts::encode_seal;
use risc0_zkvm::{
    compute_image_id, Executor, ExecutorEnv, ExternalProver, InnerReceipt, Prover, ProverOpts,
};
use serde::Deserialize;
use serde_json::{json, Value};
use ubc26_protocol::{reference_hash, strict_json, BundleKind, FundedContext, CONTEXT_BYTES};

use crate::files::{error, import_bundle, publish_directory, read_input};
use crate::package::{as_hex, load, stage_output};

const PROVER_IMAGE: &str = "risczero/risc0-groth16-prover:v2026-10-20.1";
const PROVER_DIGEST: &str = "risczero/risc0-groth16-prover@sha256:49093ed164b82aca9305dd80e4a6eb996bd443201ac7bd50b52909b2761ef583";
const SEAL_SELECTOR: [u8; 4] = [0xe7, 0x1e, 0x66, 0x20];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    context: String,
    image_id: String,
}

fn decode_context(job: &Job) -> Result<FundedContext, Value> {
    let bytes = job
        .context
        .strip_prefix("0x")
        .filter(|input| input.len() == CONTEXT_BYTES * 2)
        .and_then(|input| hex::decode(input).ok())
        .ok_or_else(|| {
            error(
                "invalid_job",
                "Expected the 169-byte funded context in 0x hex",
            )
        })?;
    FundedContext::decode(&bytes).map_err(|err| error("invalid_job", err))
}

fn local_prover(groth16: bool) -> Result<ExternalProver, Value> {
    let code = "prover_setup";
    if env::var_os("RISC0_DEV_MODE").is_some() || env::var_os("RUST_LOG").is_some() {
        return Err(error(
            code,
            "Unset RISC0_DEV_MODE and RUST_LOG before proving",
        ));
    }
    let r0vm = env::var_os("RISC0_SERVER_PATH").unwrap_or_else(|| "r0vm".into());
    let version = Command::new(&r0vm)
        .arg("--version")
        .output()
        .map_err(|err| error(code, err))?;
    if !version.status.success()
        || String::from_utf8_lossy(&version.stdout).trim() != "risc0-r0vm 3.1.0"
    {
        return Err(error(code, "Expected r0vm 3.1.0"));
    }

    if groth16 {
        let image = Command::new("docker")
            .args([
                "image",
                "inspect",
                "--format",
                "{{join .RepoDigests \" \"}}",
                PROVER_IMAGE,
            ])
            .output()
            .map_err(|err| error(code, err))?;
        if !image.status.success()
            || !String::from_utf8_lossy(&image.stdout)
                .split_whitespace()
                .any(|digest| digest == PROVER_DIGEST)
        {
            return Err(error(
                code,
                "Load the pinned Groth16 image as described in the proof smoke README",
            ));
        }
    }
    Ok(ExternalProver::new("ipc", r0vm))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn prove(
    package: &Path,
    job: &Path,
    deliverables: &Path,
    reference: &Path,
    evidence: Option<&Path>,
    out: Option<&Path>,
) -> Result<Value, Value> {
    let job = read_input(job, 4096, "invalid_job")?;
    let job: Job = serde_json::from_value(
        strict_json::from_slice(&job).map_err(|err| error("invalid_job", err))?,
    )
    .map_err(|err| error("invalid_job", err))?;
    let context = decode_context(&job)?;
    let package = load(package)?;
    let reference = import_bundle(reference, BundleKind::Reference)?;
    let delivery = import_bundle(deliverables, BundleKind::Delivery)?;
    let evidence = match evidence {
        Some(path) => import_bundle(path, BundleKind::Evidence)?,
        None => vec![1, 0, 0],
    };
    if job.image_id != package.manifest.image_id
        || as_hex(&context.rules_hash) != package.manifest.rules_hash
        || as_hex(&context.reference_hash) != package.manifest.reference_hash
        || context.reference_hash != reference_hash(&reference)
    {
        return Err(error(
            "job_mismatch",
            "Funded terms differ from the checker package or reference files",
        ));
    }
    let mut key = [0; 32];
    let mut nonce = [0; 12];
    getrandom::fill(&mut key).map_err(|err| error("randomness_failure", err))?;
    getrandom::fill(&mut nonce).map_err(|err| error("randomness_failure", err))?;
    let (journal, envelope) = ubc26_guest_runtime::check_with_evidence(
        &package.structure,
        &package.parameters,
        &reference,
        &delivery,
        &evidence,
        &context,
        &key,
        &nonce,
    )
    .map_err(|err| error("invalid_deliverable", err))?;

    let stage = out
        .map(|path| stage_output(path, ".engine-prove-"))
        .transpose()?;
    let prover = local_prover(out.is_some())?;
    let mut builder = ExecutorEnv::builder();
    builder
        .write_frame(&package.parameters)
        .write_frame(&reference)
        .write_frame(&delivery);
    if package.manifest.input_version >= 2 {
        builder.write_frame(&evidence);
    } else if evidence != [1, 0, 0] {
        return Err(error(
            "invalid_package",
            "This package requires an empty evidence bundle",
        ));
    }
    let env = builder
        .write_slice(&context.encode())
        .write_slice(&key)
        .write_slice(&nonce)
        .build()
        .map_err(|err| error("prover_failure", err))?;
    if out.is_none() {
        let session = prover
            .execute(env, &package.guest)
            .map_err(|err| error("prover_failure", err))?;
        if session.journal.bytes != journal.encode()
            || session.exit_code != risc0_zkvm::ExitCode::Halted(0)
        {
            return Err(error(
                "prover_failure",
                "Guest execution differs from the host checker",
            ));
        }
        return Ok(json!({"verdict":journal.verdict as u8,"userCycles":session.cycles()}));
    }
    let stage = stage.expect("proof output stage");
    let out = out.expect("proof output directory");
    let start = Instant::now();
    let proof = prover
        .prove_with_opts(env, &package.guest, &ProverOpts::groth16())
        .map_err(|err| error("prover_failure", err))?;
    let elapsed = start.elapsed();
    let image = compute_image_id(&package.guest).map_err(|err| error("invalid_package", err))?;
    let receipt = proof.receipt;
    if !matches!(receipt.inner, InnerReceipt::Groth16(_))
        || receipt.journal.bytes != journal.encode()
    {
        return Err(error(
            "prover_failure",
            "Receipt kind or journal differs from the expected result",
        ));
    }
    receipt
        .verify(image)
        .map_err(|err| error("prover_failure", err))?;
    let seal = encode_seal(&receipt).map_err(|err| error("prover_failure", err))?;
    if seal.len() != 260 || !seal.starts_with(&SEAL_SELECTOR) {
        return Err(error("prover_failure", "Unexpected Groth16 seal format"));
    }

    let submission = json!({
        "version": 1,
        "context": as_hex(&context.encode()),
        "imageId": package.manifest.image_id,
        "verdict": journal.verdict as u8,
        "envelope": as_hex(&envelope),
        "keyCommitment": as_hex(&journal.key_commitment),
        "journal": as_hex(&journal.encode()),
        "seal": as_hex(&seal)
    });
    write_private(
        &stage.path().join("release-key.hex"),
        as_hex(&key).as_bytes(),
    )?;
    let submission =
        serde_json::to_vec_pretty(&submission).map_err(|err| error("output_io", err))?;
    write_private(&stage.path().join("proof.json"), &submission)?;
    publish_directory(stage.path(), out).map_err(|err| error("output_io", err))?;
    Ok(json!({
        "verdict": journal.verdict as u8,
        "proofFile": "proof.json",
        "keyFile": "release-key.hex",
        "proveMillis": elapsed.as_millis(),
        "userCycles": proof.stats.user_cycles
    }))
}

fn write_private(path: &Path, value: &[u8]) -> Result<(), Value> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|err| error("output_io", err))?;
    file.write_all(value)
        .and_then(|()| file.sync_all())
        .map_err(|err| error("output_io", err))
}
