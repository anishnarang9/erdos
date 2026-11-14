use serde_json::Value;
use ubc26_guest_runtime::evidence_crypto::{eip712_digest, verify};
use ubc26_protocol::FundedContext;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../fixtures/evidence-v1/vectors.json")).unwrap()
}
fn bytes(value: &Value) -> Vec<u8> {
    hex::decode(value.as_str().unwrap().strip_prefix("0x").unwrap()).unwrap()
}

#[test]
fn accepts_independent_signatures_for_all_six_profiles() {
    let input = fixture();
    let context = FundedContext::decode(&bytes(&input["context"])).unwrap();
    let payload = bytes(&input["payload"]);
    assert_eq!(
        hex::encode(eip712_digest(&context, &payload)),
        input["eip712Digest"]
            .as_str()
            .unwrap()
            .trim_start_matches("0x")
    );
    for vector in input["vectors"].as_array().unwrap() {
        let profile = vector["profile"].as_str().unwrap();
        let signer = bytes(&vector["signer"]);
        let encoded = vector["encoded"].as_str().unwrap().as_bytes();
        assert_eq!(
            verify(profile, &signer, &context, encoded).unwrap(),
            payload,
            "{profile}"
        );
        let mut wrong_key = signer.clone();
        wrong_key[0] ^= 1;
        assert!(
            verify(profile, &wrong_key, &context, encoded).is_err(),
            "{profile}"
        );
        let mut wrong = encoded.to_vec();
        let index = wrong.len() - 4;
        wrong[index] = if wrong[index] == b'A' { b'B' } else { b'A' };
        assert!(
            verify(profile, &signer, &context, &wrong).is_err(),
            "{profile}"
        );
    }
}

#[test]
fn binds_eip712_to_the_job_and_rejects_high_s_and_bad_recovery() {
    let input = fixture();
    let mut context = FundedContext::decode(&bytes(&input["context"])).unwrap();
    let vector = &input["vectors"][1];
    let signer = bytes(&vector["signer"]);
    let encoded = vector["encoded"].as_str().unwrap();
    context.job_id[31] ^= 1;
    assert!(verify("eip712/v1", &signer, &context, encoded.as_bytes()).is_err());
    context.job_id[31] ^= 1;
    let mut envelope: Value = serde_json::from_str(encoded).unwrap();
    envelope["signature"] = input["eip712HighS"].clone();
    assert!(verify(
        "eip712/v1",
        &signer,
        &context,
        &serde_json::to_vec(&envelope).unwrap()
    )
    .is_err());
    envelope = serde_json::from_str(encoded).unwrap();
    let mut signature = bytes(&envelope["signature"]);
    signature[64] = 35;
    envelope["signature"] = serde_json::json!(format!("0x{}", hex::encode(&signature)));
    assert!(verify(
        "eip712/v1",
        &signer,
        &context,
        &serde_json::to_vec(&envelope).unwrap()
    )
    .is_err());
}

#[test]
fn rejects_jws_header_discovery_and_algorithm_substitution() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let input = fixture();
    let context = FundedContext::decode(&bytes(&input["context"])).unwrap();
    let vector = &input["vectors"][2];
    let signer = bytes(&vector["signer"]);
    let compact = vector["encoded"].as_str().unwrap();
    for header in [
        r#"{"alg":"none"}"#,
        r#"{"alg":"Ed25519","jku":"https://example.com/key"}"#,
        r#"{"alg":"Ed25519","alg":"Ed25519"}"#,
        r#"{"alg":"Ed25519","crit":["b64"],"b64":false}"#,
    ] {
        let (_, suffix) = compact.split_once('.').unwrap();
        let changed = format!("{}.{}", URL_SAFE_NO_PAD.encode(header), suffix);
        assert!(verify("jws/Ed25519/v1", &signer, &context, changed.as_bytes()).is_err());
    }
}
