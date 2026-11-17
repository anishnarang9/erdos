use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::{Command, Output};

use serde_json::{json, Value};
use ubc26_protocol::{
    encode_bundle, encrypt_delivery, key_commitment, sha256, BundleKind, FundedContext, Journal,
    NamedFile, Verdict,
};

const KEY: [u8; 32] = [7; 32];

fn prefixed(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn submission() -> Value {
    let context = FundedContext {
        chain_id: [1; 32],
        escrow: [2; 20],
        job_id: [3; 32],
        provider: [4; 20],
        rules_hash: [5; 32],
        reference_hash: [6; 32],
    };
    let bundle = encode_bundle(
        BundleKind::Delivery,
        &[
            NamedFile {
                name: "result.txt",
                contents: b"result\n",
            },
            NamedFile {
                name: "data.bin",
                contents: &[0, 255, 128],
            },
        ],
    )
    .unwrap();
    let envelope = encrypt_delivery(&context, &KEY, &[8; 12], &bundle).unwrap();
    let journal = Journal {
        context,
        verdict: Verdict::Pass,
        envelope_hash: sha256(&envelope),
        key_commitment: key_commitment(&context, &KEY),
    };
    json!({
        "version": 1,
        "context": prefixed(&context.encode()),
        "imageId": prefixed(&[0; 32]),
        "verdict": 1,
        "envelope": prefixed(&envelope),
        "keyCommitment": prefixed(&journal.key_commitment),
        "journal": prefixed(&journal.encode()),
        "seal": prefixed(&[]),
    })
}

fn run(root: &Path, submission: &Value, key: &str) -> Output {
    let submission_path = root.join("proof.json");
    let key_path = root.join("key");
    fs::write(&submission_path, submission.to_string()).unwrap();
    fs::write(&key_path, key).unwrap();
    Command::new(env!("CARGO_BIN_EXE_engine"))
        .arg("decrypt")
        .arg("--submission")
        .arg(submission_path)
        .arg("--key-file")
        .arg(key_path)
        .arg("--out")
        .arg(root.join("output"))
        .output()
        .unwrap()
}

#[test]
fn decrypts_all_files_and_refuses_existing_destinations() {
    let root = tempfile::tempdir().unwrap();
    let submission = submission();
    let key = format!("{}\n", prefixed(&KEY));
    let output = run(root.path(), &submission, &key);
    assert!(output.status.success(), "{:?}", output);
    let destination = root.path().join("output");
    assert_eq!(
        fs::read(destination.join("result.txt")).unwrap(),
        b"result\n"
    );
    assert_eq!(
        fs::read(destination.join("data.bin")).unwrap(),
        [0, 255, 128]
    );
    assert!(!run(root.path(), &submission, &key).status.success());
    assert_eq!(
        fs::read(destination.join("result.txt")).unwrap(),
        b"result\n"
    );

    fs::remove_dir_all(&destination).unwrap();
    let other = root.path().join("other");
    fs::create_dir(&other).unwrap();
    symlink(&other, &destination).unwrap();
    assert!(!run(root.path(), &submission, &key).status.success());
    assert_eq!(fs::read_dir(other).unwrap().count(), 0);
}

#[test]
fn failures_leave_no_destination() {
    let root = tempfile::tempdir().unwrap();
    let mut submission = submission();
    let key = prefixed(&KEY);
    for bad_key in [prefixed(&[9; 32]), format!(" {key}")] {
        assert!(!run(root.path(), &submission, &bad_key).status.success());
        assert!(!root.path().join("output").exists());
    }

    let mut envelope = hex::decode(&submission["envelope"].as_str().unwrap()[2..]).unwrap();
    envelope[12] ^= 1;
    submission["envelope"] = json!(prefixed(&envelope));
    assert!(!run(root.path(), &submission, &key).status.success());
    assert!(!root.path().join("output").exists());

    let mut journal =
        Journal::decode(&hex::decode(&submission["journal"].as_str().unwrap()[2..]).unwrap())
            .unwrap();
    journal.envelope_hash = sha256(&envelope);
    submission["journal"] = json!(prefixed(&journal.encode()));
    assert!(!run(root.path(), &submission, &key).status.success());
    assert!(!root.path().join("output").exists());
}
