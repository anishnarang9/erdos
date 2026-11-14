mod decrypt;
mod files;
mod package;
mod prove;

use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
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
        Some("validate") => {
            let paths = args(flags, &["--plan"], &[])?;
            let mut bytes = Vec::new();
            File::open(paths["--plan"])
                .and_then(|file| {
                    file.take((MAX_PLAN_BYTES + 1) as u64)
                        .read_to_end(&mut bytes)
                })
                .map_err(|error| json!({"code":"input_io", "message":error.to_string()}))?;
            validate_plan(&bytes)
                .map(|plan| json!(plan))
                .map_err(|err| json!(err))
        }
        Some("compile") => {
            let paths = args(flags, &["--plan", "--reference", "--out"], &[])?;
            package::compile(paths["--plan"], paths["--reference"], paths["--out"])
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
                paths["--out"],
            )
        }
        Some("decrypt") => {
            let paths = args(flags, &["--submission", "--key-file", "--out"], &[])?;
            decrypt::decrypt(paths["--submission"], paths["--key-file"], paths["--out"])
        }
        _ => Err(usage()),
    }
}

fn usage() -> Value {
    json!({"code":"usage", "message":"Use engine validate, compile, prove, or decrypt. See engine/README.md for arguments."})
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
