use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use ubc26_compiler::validate_plan;
use ubc26_guest_runtime::check_with_evidence;
use ubc26_protocol::{
    encode_bundle, reference_hash, rules_hash, sha256, structure_hash, BundleKind, FundedContext,
    NamedFile, Verdict,
};

fn bundle(kind: BundleKind, name: &str, contents: &[u8]) -> Vec<u8> {
    encode_bundle(kind, &[NamedFile { name, contents }]).unwrap()
}

#[test]
fn checks_approved_signer_artifact_and_context_before_projecting_evidence() {
    let key = SigningKey::from_bytes(&[31; 32]);
    let plan = json!({"version":1,"deliverables":[{"name":"note.txt","parser":"text/v1"}],"references":[],"evidence":[{
        "name":"signed.json","profile":"ed25519/v1","signer":format!("0x{}",hex::encode(key.verifying_key().as_bytes())),
        "parser":"json/v1","fields":[{"name":"artifactHash","type":"string"},{"name":"challenge","type":"string"},{"name":"score","type":"i64"}],
        "bindings":[{"field":"artifactHash","file":"note.txt"}],"contextField":"challenge"
    }],"rules":[{"op":"gte","left":{"op":"field","source":"evidence","file":"signed.json","field":"score"},"right":{"op":"literal","type":"i64","value":"8"}}]});
    let validated =
        serde_json::to_value(validate_plan(&serde_json::to_vec(&plan).unwrap()).unwrap()).unwrap();
    let structure = validated["structureJcs"].as_str().unwrap().as_bytes();
    let parameters = validated["parametersJcs"].as_str().unwrap().as_bytes();
    let reference = encode_bundle(BundleKind::Reference, &[]).unwrap();
    let context = FundedContext {
        chain_id: [0; 32],
        escrow: [0; 20],
        job_id: [0; 32],
        provider: [0; 20],
        rules_hash: rules_hash(&structure_hash(structure), parameters),
        reference_hash: reference_hash(&reference),
    };
    let payload = json!({"artifactHash":format!("0x{}",hex::encode(sha256(b"ok"))),"challenge":format!("0x{}",hex::encode(sha256(&context.encode()))),"score":"9"});
    let sign = |payload: &Value| {
        let payload = serde_json_canonicalizer::to_vec(payload).unwrap();
        let mut message = b"UBC26/evidence/v1".to_vec();
        message.extend_from_slice(&payload);
        let envelope=serde_json::to_vec(&json!({"payload":format!("0x{}",hex::encode(&payload)),"signature":format!("0x{}",hex::encode(key.sign(&message).to_bytes()))})).unwrap();
        bundle(BundleKind::Evidence, "signed.json", &envelope)
    };
    let evidence = sign(&payload);
    let delivery = bundle(BundleKind::Delivery, "note.txt", b"ok");
    let check = |evidence: &[u8], delivery: &[u8], context: &FundedContext| {
        check_with_evidence(
            structure, parameters, &reference, delivery, evidence, context, &[1; 32], &[2; 12],
        )
    };
    assert_eq!(
        check(&evidence, &delivery, &context).unwrap().0.verdict,
        Verdict::Pass
    );
    assert!(check(
        &evidence,
        &bundle(BundleKind::Delivery, "note.txt", b"changed"),
        &context
    )
    .is_err());
    let mut replay = context;
    replay.job_id[31] = 7;
    assert!(check(&evidence, &delivery, &replay).is_err());
    let mut lower = payload.clone();
    lower["score"] = json!("7");
    assert_eq!(
        check(&sign(&lower), &delivery, &context).unwrap().0.verdict,
        Verdict::Fail
    );
    assert!(check(&[1, 0, 0], &delivery, &context).is_err());
}
