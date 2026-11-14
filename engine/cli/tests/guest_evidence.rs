// Run against a package prepared by tests/evidence-fixture.cjs.
use risc0_zkvm::{Executor, ExecutorEnv, ExternalProver};
use serde_json::Value;
use std::{fs, path::Path};
use ubc26_protocol::{encode_bundle, BundleKind, NamedFile};

fn bundle(path: &Path, kind: BundleKind) -> Vec<u8> {
    let files: Vec<_> = fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().into_string().unwrap(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect();
    let named: Vec<_> = files
        .iter()
        .map(|(name, contents)| NamedFile { name, contents })
        .collect();
    encode_bundle(kind, &named).unwrap()
}

#[test]
#[ignore = "Requires a signed package in UBC26_EVIDENCE_FIXTURE and local r0vm 3.1.0"]
fn guest_checks_every_enabled_evidence_profile_before_emitting_a_journal() {
    let root = std::env::var_os("UBC26_EVIDENCE_FIXTURE").expect("prepared fixture path");
    let root = Path::new(&root);
    let guest = fs::read(root.join("package/guest.elf")).unwrap();
    let parameters = fs::read(root.join("package/parameters.jcs")).unwrap();
    let job: Value = serde_json::from_slice(&fs::read(root.join("job.json")).unwrap()).unwrap();
    let context = hex::decode(job["context"].as_str().unwrap().trim_start_matches("0x")).unwrap();
    let delivery = bundle(&root.join("delivery"), BundleKind::Delivery);
    let reference = bundle(&root.join("reference"), BundleKind::Reference);
    let evidence = bundle(&root.join("evidence"), BundleKind::Evidence);
    let prover = ExternalProver::new(
        "ipc",
        std::env::var_os("RISC0_SERVER_PATH").expect("local r0vm"),
    );
    let run = |evidence: &[u8]| {
        let env = ExecutorEnv::builder()
            .write_frame(&parameters)
            .write_frame(&reference)
            .write_frame(&delivery)
            .write_frame(evidence)
            .write_slice(&context)
            .write_slice(&[4u8; 32])
            .write_slice(&[5u8; 12])
            .build()
            .unwrap();
        prover.execute(env, &guest)
    };
    let baseline = run(&evidence).unwrap();
    assert_eq!(baseline.journal.bytes.len(), 234);
    assert_eq!(baseline.journal.bytes[169], 1);
    let files = ubc26_protocol::decode_bundle(BundleKind::Evidence, &evidence).unwrap();
    assert_eq!(files.len(), 6);
    for index in 0..files.len() {
        let mut contents = files[index].contents.to_vec();
        if files[index].name.ends_with(".jws") {
            let position = contents.iter().rposition(|&byte| byte == b'.').unwrap() + 1;
            contents[position] = if contents[position] == b'A' {
                b'B'
            } else {
                b'A'
            };
        } else {
            let mut envelope: Value = serde_json::from_slice(&contents).unwrap();
            let mut signature = hex::decode(
                envelope["signature"]
                    .as_str()
                    .unwrap()
                    .trim_start_matches("0x"),
            )
            .unwrap();
            signature[0] ^= 1;
            envelope["signature"] = serde_json::json!(format!("0x{}", hex::encode(signature)));
            contents = serde_json::to_vec(&envelope).unwrap();
        }
        let files: Vec<_> = files
            .iter()
            .enumerate()
            .map(|(other, file)| NamedFile {
                name: file.name,
                contents: if index == other {
                    &contents
                } else {
                    file.contents
                },
            })
            .collect();
        let changed = encode_bundle(BundleKind::Evidence, &files).unwrap();
        assert!(
            run(&changed).is_err(),
            "Guest accepted invalid signature for {}",
            files[index].name
        );
    }
}
