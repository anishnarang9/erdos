use anyhow::{Context, Result, bail, ensure};
use risc0_ethereum_contracts::encode_seal;
use risc0_zkvm::{
    Executor, ExecutorEnv, ExitCode, ExternalProver, InnerReceipt, Prover, ProverOpts,
    compute_image_id,
};
use serde_json::json;
use std::{env, process::Command, time::Instant};

#[allow(dead_code)]
mod methods {
    include!(concat!(env!("OUT_DIR"), "/methods.rs"));
}

const JOURNAL: &[u8] = b"UBC26/proof-smoke/v1";
const PROVER_IMAGE: &str = "risczero/risc0-groth16-prover:v2026-10-20.1";
const PROVER_IMAGE_DIGEST: &str = "risczero/risc0-groth16-prover@sha256:49093ed164b82aca9305dd80e4a6eb996bd443201ac7bd50b52909b2761ef583";
const SEAL_SELECTOR: [u8; 4] = [0xe7, 0x1e, 0x66, 0x20];

fn main() -> Result<()> {
    let mode = match env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [mode] if mode == "execute" => "execute",
        [mode] if mode == "prove" => "prove",
        _ => bail!("usage: ubc26-proof-smoke <execute|prove>"),
    };
    ensure!(
        env::var_os("RISC0_DEV_MODE").is_none(),
        "unset RISC0_DEV_MODE before running the smoke check"
    );

    ensure!(
        env::var_os("RUST_LOG").is_none(),
        "unset RUST_LOG to keep the JSON output free of r0vm logs"
    );

    let elf = methods::UBC26_SMOKE_GUEST_ELF;
    let image_id = compute_image_id(elf).context("compute the guest image ID")?;
    ensure!(
        image_id.as_words() == &methods::UBC26_SMOKE_GUEST_ID,
        "embedded image ID mismatch"
    );

    let r0vm = env::var_os("RISC0_SERVER_PATH").unwrap_or_else(|| "r0vm".into());
    let version = Command::new(&r0vm)
        .arg("--version")
        .output()
        .context("launch r0vm 3.1.0")?;
    ensure!(
        version.status.success()
            && String::from_utf8_lossy(&version.stdout).trim() == "risc0-r0vm 3.1.0",
        "expected r0vm 3.1.0"
    );

    let prover = ExternalProver::new("ipc", r0vm);
    let executor_env = ExecutorEnv::builder().build()?;
    let image_id_hex = format!("0x{image_id}");
    let journal_hex = format!("0x{}", hex::encode(JOURNAL));

    if mode == "execute" {
        let session = prover
            .execute(executor_env, elf)
            .context("execute the smoke guest")?;
        ensure!(
            session.exit_code == ExitCode::Halted(0),
            "guest exit was not successful"
        );
        ensure!(session.journal.bytes == JOURNAL, "unexpected guest journal");
        println!(
            "{}",
            json!({
                "imageId": image_id_hex,
                "journal": journal_hex,
                "userCycles": session.cycles(),
            })
        );
        return Ok(());
    }

    let image = Command::new("docker")
        .args([
            "image",
            "inspect",
            "--format",
            "{{join .RepoDigests \" \"}}",
            PROVER_IMAGE,
        ])
        .output()
        .context("inspect the local Groth16 prover image")?;
    ensure!(
        image.status.success()
            && String::from_utf8_lossy(&image.stdout)
                .split_whitespace()
                .any(|digest| digest == PROVER_IMAGE_DIGEST),
        "the local Groth16 prover image must match {PROVER_IMAGE_DIGEST}. See README.md"
    );

    let start = Instant::now();
    let proof = prover
        .prove_with_opts(executor_env, elf, &ProverOpts::groth16())
        .context("create a real local Groth16 receipt")?;
    let prove_millis = start.elapsed().as_millis();
    let receipt = proof.receipt;
    ensure!(
        matches!(receipt.inner, InnerReceipt::Groth16(_)),
        "expected a real Groth16 receipt"
    );
    receipt
        .verify(image_id)
        .context("verify the Groth16 receipt")?;
    ensure!(
        receipt.journal.bytes == JOURNAL,
        "unexpected receipt journal"
    );
    let seal = encode_seal(&receipt).context("encode the EVM seal")?;
    ensure!(
        seal.len() == 260 && seal.starts_with(&SEAL_SELECTOR),
        "unexpected EVM seal format"
    );

    let mut modified_receipt = receipt.clone();
    modified_receipt.journal.bytes[0] ^= 1;
    ensure!(
        modified_receipt.verify(image_id).is_err(),
        "changed journal passed verification"
    );
    let mut wrong_image_id = image_id;
    wrong_image_id.as_mut_bytes()[0] ^= 1;
    ensure!(
        receipt.verify(wrong_image_id).is_err(),
        "changed image ID passed verification"
    );

    println!(
        "{}",
        json!({
            "imageId": image_id_hex,
            "journal": journal_hex,
            "seal": format!("0x{}", hex::encode(seal)),
            "userCycles": proof.stats.user_cycles,
            "proveMillis": prove_millis,
        })
    );
    Ok(())
}
