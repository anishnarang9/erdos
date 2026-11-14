use std::env;
use std::fs::File;
use std::io::{self, Read, Write};
use std::process::ExitCode;

use serde_json::{json, Value};
use ubc26_compiler::{validate_plan, MAX_PLAN_BYTES};

fn run() -> Result<(), Value> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let [command, flag, path] = args.as_slice() else {
        return Err(usage());
    };
    if command != "validate" || flag != "--plan" {
        return Err(usage());
    }

    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| {
            file.take((MAX_PLAN_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| json!({"code":"input_io", "message":error.to_string()}))?;
    let plan = validate_plan(&bytes).map_err(|error| json!(error))?;
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &plan)
        .map_err(|error| json!({"code":"output_io", "message":error.to_string()}))?;
    writeln!(stdout).map_err(|error| json!({"code":"output_io", "message":error.to_string()}))?;
    Ok(())
}

fn usage() -> Value {
    json!({"code":"usage", "message":"Usage: engine validate --plan PLAN"})
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}
