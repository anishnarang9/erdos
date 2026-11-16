use risc0_zkvm::{Executor, ExecutorEnv, ExternalProver};
use std::{fs, path::Path};
use ubc26_protocol::{encode_bundle, BundleKind, FundedContext, NamedFile};

#[test]
#[ignore = "Requires a maximum-delivery package in UBC26_LIMIT_FIXTURE and local r0vm"]
fn guest_accepts_the_full_delivery_cap_and_rejects_oversized_frames() {
    let root = std::env::var_os("UBC26_LIMIT_FIXTURE").expect("prepared maximum-delivery fixture");
    let root = Path::new(&root);
    let guest = fs::read(root.join("package/guest.elf")).unwrap();
    let structure = fs::read(root.join("package/structure.jcs")).unwrap();
    let parameters = fs::read(root.join("package/parameters.jcs")).unwrap();
    let job: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("job.json")).unwrap()).unwrap();
    let context = hex::decode(job["context"].as_str().unwrap().trim_start_matches("0x")).unwrap();
    let context = FundedContext::decode(&context).unwrap();
    let contents = fs::read(root.join("delivery/blob.bin")).unwrap();
    let delivery = encode_bundle(
        BundleKind::Delivery,
        &[NamedFile {
            name: "blob.bin",
            contents: &contents,
        }],
    )
    .unwrap();
    assert_eq!(delivery.len(), 16 * 1024);
    let empty = vec![1, 0, 0];
    let expected = ubc26_guest_runtime::check_with_evidence(
        &structure,
        &parameters,
        &empty,
        &delivery,
        &empty,
        &context,
        &[4; 32],
        &[5; 12],
    )
    .unwrap()
    .0;
    let prover = ExternalProver::new(
        "ipc",
        std::env::var_os("RISC0_SERVER_PATH").expect("local r0vm"),
    );
    let run = |parameters: &[u8], reference: &[u8], delivery: &[u8], evidence: &[u8]| {
        let env = ExecutorEnv::builder()
            .write_frame(parameters)
            .write_frame(reference)
            .write_frame(delivery)
            .write_frame(evidence)
            .write_slice(&context.encode())
            .write_slice(&[4u8; 32])
            .write_slice(&[5u8; 12])
            .build()
            .unwrap();
        prover.execute(env, &guest)
    };
    assert_eq!(
        run(&parameters, &empty, &delivery, &empty)
            .unwrap()
            .journal
            .bytes,
        expected.encode()
    );
    assert!(run(&parameters, &empty, &vec![0; 16 * 1024 + 1], &empty).is_err());
    assert!(run(&parameters, &vec![0; 32 * 1024 + 1], &delivery, &empty).is_err());
    assert!(run(&parameters, &empty, &delivery, &vec![0; 32 * 1024 + 1]).is_err());
    assert!(run(&vec![0; 256 * 1024 + 1], &empty, &delivery, &empty).is_err());
}
