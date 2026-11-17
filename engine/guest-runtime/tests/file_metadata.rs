use serde_json::json;
use ubc26_compiler::validate_plan;
use ubc26_guest_runtime::check;
use ubc26_protocol::{
    encode_bundle, reference_hash, rules_hash, sha256, structure_hash, BundleKind, FundedContext,
    NamedFile, Verdict,
};

#[test]
fn checks_exact_opaque_file_size_and_hash() {
    let bytes = b"\0\xff\x80";
    let plan = json!({"version":1,"deliverables":[{"name":"blob.bin","parser":"opaque/v1"}],"references":[],"rules":[
        {"op":"eq","left":{"op":"file_size","source":"deliverable","file":"blob.bin"},"right":{"op":"literal","type":"i64","value":"3"}},
        {"op":"eq","left":{"op":"file_hash","source":"deliverable","file":"blob.bin"},"right":{"op":"literal","type":"string","value":format!("0x{}",hex::encode(sha256(bytes)))}}
    ]});
    let report =
        serde_json::to_value(validate_plan(&serde_json::to_vec(&plan).unwrap()).unwrap()).unwrap();
    let structure = report["structureJcs"].as_str().unwrap().as_bytes();
    let parameters = report["parametersJcs"].as_str().unwrap().as_bytes();
    let reference = vec![1, 0, 0];
    let context = FundedContext {
        chain_id: [0; 32],
        escrow: [0; 20],
        job_id: [0; 32],
        provider: [0; 20],
        rules_hash: rules_hash(&structure_hash(structure), parameters),
        reference_hash: reference_hash(&reference),
    };
    for (contents, verdict) in [
        (bytes.as_slice(), Verdict::Pass),
        (b"abc".as_slice(), Verdict::Fail),
    ] {
        let delivery = encode_bundle(
            BundleKind::Delivery,
            &[NamedFile {
                name: "blob.bin",
                contents,
            }],
        )
        .unwrap();
        assert_eq!(
            check(structure, parameters, &reference, &delivery, &context, &[0; 32], &[0; 12])
                .unwrap()
                .0
                .verdict,
            verdict
        );
    }
}
