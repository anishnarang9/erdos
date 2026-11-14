mod cache;
mod decrypt;
mod files;
mod package;
mod prove;

use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

use serde_json::{json, Value};
use ubc26_compiler::{validate_plan, MAX_PLAN_BYTES};

fn args<'a>(
    raw: &'a [OsString],
    required: &[&str],
    optional: &[&str],
) -> Result<BTreeMap<&'a str, &'a Path>, Value> {
    let mut paths = BTreeMap::new();
    let (pairs, remainder) = raw.as_chunks::<2>();
    for pair in pairs {
        let Some(flag) = pair[0].to_str() else {
            return Err(usage());
        };
        if !(required.contains(&flag) || optional.contains(&flag))
            || paths.insert(flag, Path::new(&pair[1])).is_some()
        {
            return Err(usage());
        }
    }
    if !remainder.is_empty() || required.iter().any(|flag| !paths.contains_key(flag)) {
        return Err(usage());
    }
    Ok(paths)
}

fn run(raw: &[OsString]) -> Result<Value, Value> {
    let Some((command, flags)) = raw.split_first() else {
        return Err(usage());
    };
    match command.as_os_str().to_str() {
        Some("capabilities") if flags.is_empty() => Ok(serde_json::from_slice(include_bytes!(
            "../../capabilities-v1.json"
        ))
        .expect("bundled capability catalog")),
        Some("validate") => {
            let paths = args(flags, &["--plan"], &[])?;
            let bytes = files::read_input(paths["--plan"], MAX_PLAN_BYTES, "input_io")?;
            validate_plan(&bytes)
                .map(|plan| json!(plan))
                .map_err(|err| json!(err))
        }
        Some("eval") => {
            let paths = args(
                flags,
                &["--plan", "--deliverables"],
                &["--reference", "--evidence", "--job"],
            )?;
            evaluate(
                paths["--plan"],
                paths["--deliverables"],
                paths.get("--reference").copied(),
                paths.get("--evidence").copied(),
                paths.get("--job").copied(),
            )
        }
        Some("compile") => {
            let paths = args(flags, &["--plan", "--reference", "--out"], &[])?;
            package::compile(paths["--plan"], paths["--reference"], paths["--out"])
        }
        Some("execute") => {
            let paths = args(
                flags,
                &["--package", "--job", "--deliverables", "--reference"],
                &["--evidence"],
            )?;
            prove::prove(
                paths["--package"],
                paths["--job"],
                paths["--deliverables"],
                paths["--reference"],
                paths.get("--evidence").copied(),
                None,
            )
        }
        Some("prove") => {
            let paths = args(
                flags,
                &[
                    "--package",
                    "--job",
                    "--deliverables",
                    "--reference",
                    "--out",
                ],
                &["--evidence"],
            )?;
            prove::prove(
                paths["--package"],
                paths["--job"],
                paths["--deliverables"],
                paths["--reference"],
                paths.get("--evidence").copied(),
                Some(paths["--out"]),
            )
        }
        Some("decrypt") => {
            let paths = args(flags, &["--submission", "--key-file", "--out"], &[])?;
            decrypt::decrypt(paths["--submission"], paths["--key-file"], paths["--out"])
        }
        _ => Err(usage()),
    }
}

fn evaluate(
    plan: &Path,
    deliverables: &Path,
    reference: Option<&Path>,
    evidence: Option<&Path>,
    job: Option<&Path>,
) -> Result<Value, Value> {
    use ubc26_protocol::{
        encode_bundle, reference_hash, rules_hash, structure_hash, BundleKind, FundedContext,
    };

    let bytes = files::read_input(plan, MAX_PLAN_BYTES, "input_io")?;
    let plan = json!(validate_plan(&bytes).map_err(|err| json!(err))?);
    let structure = plan["structureJcs"]
        .as_str()
        .expect("validated structure")
        .as_bytes();
    let parameters = plan["parametersJcs"]
        .as_str()
        .expect("validated parameters")
        .as_bytes();
    let reference = match reference {
        Some(path) => files::import_bundle(path, BundleKind::Reference)?,
        None => encode_bundle(BundleKind::Reference, &[]).expect("valid empty bundle"),
    };
    let delivery = files::import_bundle(deliverables, BundleKind::Delivery)?;
    let mut context = FundedContext {
        chain_id: [0; 32],
        escrow: [0; 20],
        job_id: [0; 32],
        provider: [0; 20],
        rules_hash: rules_hash(&structure_hash(structure), parameters),
        reference_hash: reference_hash(&reference),
    };
    if let Some(job) = job {
        let bytes = files::read_input(job, 4096, "invalid_job")?;
        let job = ubc26_protocol::strict_json::from_slice(&bytes)
            .map_err(|err| files::error("invalid_job", err))?;
        let bytes = job["context"]
            .as_str()
            .and_then(|hex| hex.strip_prefix("0x"))
            .and_then(|hex| hex::decode(hex).ok())
            .ok_or_else(|| files::error("invalid_job", "Expected context hex"))?;
        context = FundedContext::decode(&bytes).map_err(|err| files::error("invalid_job", err))?;
    }
    let evidence = match evidence {
        Some(path) => files::import_bundle(path, BundleKind::Evidence)?,
        None => vec![1, 0, 0],
    };
    // Preview discards both the private ciphertext and the local test context.
    let (journal, _) = ubc26_guest_runtime::check_with_evidence(
        structure, parameters, &reference, &delivery, &evidence, &context, &[0; 32], &[0; 12],
    )
    .map_err(|err| files::error("invalid_deliverable", err))?;
    Ok(json!({"verdict": journal.verdict as u8}))
}

fn usage() -> Value {
    json!({"code":"usage", "message":"Use engine capabilities, validate, eval, compile, execute, prove, or decrypt. See engine/README.md for arguments."})
}

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let code = match run(&args) {
        Ok(report) => {
            let mut stdout = io::stdout().lock();
            if let Err(err) = writeln!(stdout, "{report}") {
                eprintln!("{}", files::error("output_io", err));
                2
            } else {
                0
            }
        }
        Err(error) => {
            eprintln!("{error}");
            match error["code"].as_str() {
                Some(
                    "build_failure" | "prover_setup" | "prover_failure" | "randomness_failure",
                ) => 3,
                _ => 2,
            }
        }
    };
    ExitCode::from(code)
}
