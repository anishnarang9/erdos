use ubc26_protocol::*;

const KEY: [u8; 32] = [0x55; 32];
const NONCE: [u8; 12] = [0x66; 12];

fn context() -> FundedContext {
    let mut chain_id = [0; 32];
    chain_id[28..].copy_from_slice(&5042002u32.to_be_bytes());
    let mut job_id = [0; 32];
    job_id[31] = 7;
    FundedContext {
        chain_id,
        escrow: [0x11; 20],
        job_id,
        provider: [0x22; 20],
        rules_hash: [0x33; 32],
        reference_hash: [0x44; 32],
    }
}

fn golden_bundle() -> Vec<u8> {
    hex::decode("0100010005612e747874000000026f6b").unwrap()
}

fn fixture_bytes(value: &serde_json::Value) -> Vec<u8> {
    hex::decode(value.as_str().unwrap().strip_prefix("0x").unwrap()).unwrap()
}

#[test]
fn matches_wire_v1_bytes() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/wire-v1.json")).unwrap();
    assert_eq!(fixture["version"], VERSION);
    assert_eq!(fixture["synthetic"], true);

    let context = context();
    let bytes = context.encode();
    assert_eq!(bytes.as_slice(), fixture_bytes(&fixture["context"]));
    assert_eq!(FundedContext::decode(&bytes), Ok(context));

    let file = &fixture["files"][0];
    let contents = fixture_bytes(&file["contents"]);
    let bundle = encode_bundle(
        BundleKind::Delivery,
        &[NamedFile {
            name: file["name"].as_str().unwrap(),
            contents: &contents,
        }],
    )
    .unwrap();
    assert_eq!(bundle, fixture_bytes(&fixture["bundle"]));

    let key = fixture_bytes(&fixture["key"]).try_into().unwrap();
    let nonce = fixture_bytes(&fixture["nonce"]).try_into().unwrap();
    let envelope = encrypt_delivery(&context, &key, &nonce, &bundle).unwrap();
    assert_eq!(envelope, fixture_bytes(&fixture["envelope"]));
    assert_eq!(decrypt_delivery(&context, &key, &envelope).unwrap(), bundle);

    let journal = Journal {
        context,
        verdict: Verdict::Pass,
        envelope_hash: sha256(&envelope),
        key_commitment: key_commitment(&context, &key),
    };
    assert_eq!(fixture["verdict"], journal.verdict as u8);
    assert_eq!(
        journal.envelope_hash.as_slice(),
        fixture_bytes(&fixture["envelopeHash"])
    );
    assert_eq!(
        journal.key_commitment.as_slice(),
        fixture_bytes(&fixture["keyCommitment"])
    );
    let bytes = journal.encode();
    assert_eq!(bytes.as_slice(), fixture_bytes(&fixture["journal"]));
    assert_eq!(Journal::decode(&bytes), Ok(journal));
    assert_eq!(
        journal.digest().as_slice(),
        fixture_bytes(&fixture["journalDigest"])
    );
}

#[test]
fn rejects_malformed_public_bytes() {
    let mut bytes = context().encode();
    assert!(FundedContext::decode(&bytes[..168]).is_err());
    bytes[0] = 2;
    assert!(FundedContext::decode(&bytes).is_err());
    let mut bytes = Journal {
        context: context(),
        verdict: Verdict::Fail,
        envelope_hash: [0; 32],
        key_commitment: [0; 32],
    }
    .encode();
    assert_eq!(Journal::decode(&bytes).unwrap().verdict, Verdict::Fail);
    assert!(Journal::decode(&bytes[..233]).is_err());
    bytes[169] = 2;
    assert!(Journal::decode(&bytes).is_err());
}

#[test]
fn rejects_wrong_key_context_and_modified_envelope() {
    let context = context();
    let bundle = golden_bundle();
    let mut envelope = encrypt_delivery(&context, &KEY, &NONCE, &bundle).unwrap();
    assert!(decrypt_delivery(&context, &[0; 32], &envelope).is_err());
    let mut other_job = context;
    other_job.job_id[31] ^= 1;
    assert!(decrypt_delivery(&other_job, &KEY, &envelope).is_err());
    envelope[12] ^= 1;
    assert!(decrypt_delivery(&context, &KEY, &envelope).is_err());
    assert!(decrypt_delivery(&context, &KEY, &envelope[..27]).is_err());
}

#[test]
fn sorts_bundle_and_rejects_noncanonical_input() {
    let files = [
        NamedFile {
            name: "b.bin",
            contents: &[0xff, 0x00],
        },
        NamedFile {
            name: "A",
            contents: &[],
        },
    ];
    let mut bytes = encode_bundle(BundleKind::Reference, &files).unwrap();
    assert_eq!(
        decode_bundle(BundleKind::Reference, &bytes).unwrap(),
        [files[1], files[0]]
    );
    bytes.push(0);
    assert!(decode_bundle(BundleKind::Reference, &bytes).is_err());
    assert!(decode_bundle(
        BundleKind::Reference,
        &hex::decode("0100020001620000000000016100000000").unwrap()
    )
    .is_err());
    assert!(decode_bundle(
        BundleKind::Reference,
        &hex::decode("0100020001610000000000016100000000").unwrap()
    )
    .is_err());
    assert!(decode_bundle(
        BundleKind::Reference,
        &hex::decode("010001000161ffffffff").unwrap()
    )
    .is_err());
    assert!(encode_bundle(BundleKind::Evidence, &[files[0], files[0]]).is_err());
    for name in ["", ".", "..", "../x", "a/b", "a\\b", "é"] {
        assert!(encode_bundle(
            BundleKind::Reference,
            &[NamedFile {
                name,
                contents: &[]
            }]
        )
        .is_err());
    }
}

#[test]
fn enforces_bundle_limits() {
    let max_delivery = vec![0; 16 * 1024 - 10];
    let mut max_reference = vec![0; 32 * 1024 - 10];
    let valid = encode_bundle(
        BundleKind::Delivery,
        &[NamedFile {
            name: "a",
            contents: &max_delivery,
        }],
    )
    .unwrap();
    assert_eq!(valid.len(), 16 * 1024);
    let valid = encode_bundle(
        BundleKind::Evidence,
        &[NamedFile {
            name: "a",
            contents: &max_reference,
        }],
    )
    .unwrap();
    assert_eq!(valid.len(), 32 * 1024);
    assert!(decode_bundle(BundleKind::Delivery, &valid).is_err());
    max_reference.push(0);
    assert!(encode_bundle(
        BundleKind::Reference,
        &[NamedFile {
            name: "a",
            contents: &max_reference
        }]
    )
    .is_err());
    assert!(decode_bundle(BundleKind::Reference, &[1, 0, 17]).is_err());
    assert_eq!(
        encode_bundle(BundleKind::Reference, &[]).unwrap(),
        [1, 0, 0]
    );
}

#[test]
fn uses_domain_tags_for_plan_commitments() {
    assert_eq!(structure_hash(b"{}"), sha256(b"UBC26/structure/v1{}"));
    assert_eq!(
        reference_hash(&[1, 0, 0]),
        sha256(b"UBC26/reference/v1\x01\x00\x00")
    );
    let structure = structure_hash(b"{}");
    let params = sha256(b"[]");
    assert_eq!(
        rules_hash(&structure, b"[]"),
        sha256(&[b"UBC26/rules/v1".as_slice(), &structure, &params].concat())
    );
}
