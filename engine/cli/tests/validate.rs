use std::process::Command;

use serde_json::Value;

const PLAN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../fixtures/expense-report-plan.json"
);

#[test]
fn validates_a_plan_from_disk() {
    let output = Command::new(env!("CARGO_BIN_EXE_engine"))
        .args(["validate", "--plan", PLAN])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert!(output.stderr.is_empty());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["parameters"][0]["value"], "10000");
    assert_eq!(result["structureHash"].as_str().unwrap().len(), 66);
}

#[test]
fn writes_io_diagnostics_to_stderr() {
    let output = Command::new(env!("CARGO_BIN_EXE_engine"))
        .args(["validate", "--plan", "/missing/ubc26-plan.json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["code"], "input_io");
}
