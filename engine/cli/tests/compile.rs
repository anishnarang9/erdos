use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

use serde_json::Value;

#[test]
fn reaches_the_guest_builder_with_a_missing_configured_temp_directory() {
    let root = tempfile::tempdir().unwrap();
    let temp = root.path().join("state/tmp");
    let cache = root.path().join("state/cache");
    let reference = root.path().join("reference");
    fs::create_dir(&reference).unwrap();
    let docker = root.path().join("docker");
    fs::write(&docker, "#!/bin/sh\nexit 42\n").unwrap();
    fs::set_permissions(docker, fs::Permissions::from_mode(0o700)).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_engine"))
        .args([
            "compile",
            "--plan",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../fixtures/expense-report-plan.json"
            ),
            "--reference",
        ])
        .arg(&reference)
        .arg("--out")
        .arg(root.path().join("package"))
        .env("PATH", root.path())
        .env("TMPDIR", &temp)
        .env("UBC26_ENGINE_CACHE", &cache)
        .output()
        .unwrap();

    assert_eq!(result.status.code(), Some(3));
    let report: Value = serde_json::from_slice(&result.stderr).unwrap();
    assert_eq!(report["code"], "build_failure");
    assert_eq!(report["message"], "Guest build failed with exit status: 42");
    assert!(temp.is_dir());
    assert!(cache.is_dir());
    assert_eq!(fs::read_dir(&temp).unwrap().count(), 0);
    assert!(!root.path().join("package").exists());
}
