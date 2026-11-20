use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

use risc0_binfmt::ProgramBinary;
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

#[test]
fn concurrent_cold_compiles_build_the_same_guest_once() {
    let root = tempfile::tempdir().unwrap();
    let reference = root.path().join("reference");
    fs::create_dir(&reference).unwrap();
    let binary = ProgramBinary::decode(include_bytes!(
        "../../evaluation/proofs/allocation-scheduling/package/guest.elf"
    ))
    .unwrap();
    fs::write(root.path().join("checker"), binary.user_elf).unwrap();
    let docker = root.path().join("docker");
    fs::write(
        &docker,
        "#!/bin/sh\nset -eu\nprintf 'build\\n' >> \"$UBC26_TEST_ROOT/builds\"\n/bin/sleep 2\nout=${5#type=local,dest=}\n/bin/mkdir \"$out\"\n/bin/cp \"$UBC26_TEST_ROOT/checker\" \"$out/checker\"\n",
    )
    .unwrap();
    fs::set_permissions(docker, fs::Permissions::from_mode(0o700)).unwrap();

    let start = |name| {
        Command::new(env!("CARGO_BIN_EXE_engine"))
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
            .arg(root.path().join(name))
            .env("PATH", root.path())
            .env("UBC26_TEST_ROOT", root.path())
            .env("TMPDIR", root.path().join("tmp"))
            .env("UBC26_ENGINE_CACHE", root.path().join("cache"))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap()
    };
    let first = start("first");
    let second = start("second");
    let reports = [first, second].map(|child| {
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice::<Value>(&result.stdout).unwrap()
    });
    assert_eq!(
        fs::read_to_string(root.path().join("builds")).unwrap(),
        "build\n"
    );
    assert_eq!(reports[0]["imageId"], reports[1]["imageId"]);
    assert_ne!(reports[0]["cacheHit"], reports[1]["cacheHit"]);
}
