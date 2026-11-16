use std::fs;
use std::process::Command;

use serde_json::Value;

#[test]
fn evaluates_both_verdicts_without_a_prover() {
    let temp = tempfile::tempdir().unwrap();
    let delivery = temp.path().join("delivery");
    fs::create_dir(&delivery).unwrap();
    let plan = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/expense-report-plan.json"
    );
    for (amount, verdict) in [("9400", 1), ("10400", 0)] {
        fs::write(
            delivery.join("expense-report.json"),
            format!(r#"{{"totalCents":"{amount}","markedComplete":true}}"#),
        )
        .unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_engine"))
            .args(["eval", "--plan", plan, "--deliverables"])
            .arg(&delivery)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let report: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(report["verdict"], verdict);
        assert!(report.get("seal").is_none());
    }
}
