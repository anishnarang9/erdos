use serde_json::{json, Value};
use ubc26_guest_runtime::{check, validate_reference, CheckError};
use ubc26_protocol::{
    decrypt_delivery, encode_bundle, key_commitment, reference_hash, rules_hash, sha256,
    structure_hash, BundleKind, FundedContext, Journal, NamedFile, Verdict,
};

const KEY: [u8; 32] = [0x55; 32];
const NONCE: [u8; 12] = [0x66; 12];

fn bundle(kind: BundleKind, files: &[(&str, &[u8])]) -> Vec<u8> {
    let files: Vec<_> = files
        .iter()
        .map(|&(name, contents)| NamedFile { name, contents })
        .collect();
    encode_bundle(kind, &files).unwrap()
}

fn canonical(value: &Value) -> Vec<u8> {
    serde_json_canonicalizer::to_vec(value).unwrap()
}

fn context(structure: &[u8], parameters: &[u8], reference: &[u8]) -> FundedContext {
    FundedContext {
        chain_id: [0; 32],
        job_id: [1; 32],
        escrow: [2; 20],
        provider: [3; 20],
        rules_hash: rules_hash(&structure_hash(structure), parameters),
        reference_hash: reference_hash(reference),
    }
}

fn run(
    structure: &Value,
    parameters: &Value,
    delivery: &[u8],
    reference: &[u8],
) -> Result<(Journal, Vec<u8>), CheckError> {
    let structure = canonical(structure);
    let parameters = canonical(parameters);
    check(
        &structure,
        &parameters,
        reference,
        delivery,
        &context(&structure, &parameters, reference),
        &KEY,
        &NONCE,
    )
}

fn structure(rules: Value) -> Value {
    json!({
        "version": 1,
        "evidence": [],
        "references": [],
        "deliverables": [{
            "name": "report.json",
            "parser": "json/v1",
            "fields": [{"name": "total", "type": "i64"}, {"name": "complete", "type": "bool"}]
        }],
        "rules": rules,
    })
}

fn field(index: usize) -> Value {
    json!({"op": "field", "source": "deliverable", "file": 0, "field": index})
}

fn i64_parameter(slot: usize) -> Value {
    json!({"op": "parameter", "slot": slot, "type": "i64"})
}

fn binary(op: &str, left: Value, right: Value) -> Value {
    json!({"op": op, "left": left, "right": right})
}

#[test]
fn signed_i64_and_boolean_operations_match_the_scalar_rules() {
    let add = binary("add", field(0), i64_parameter(0));
    let sub = binary("sub", add, i64_parameter(1));
    let mul = binary("mul", sub, i64_parameter(2));
    let lt = binary("lt", mul, i64_parameter(3));
    let lte = binary("lte", field(0), i64_parameter(4));
    let gt = binary("gt", field(0), i64_parameter(5));
    let gte = binary("gte", field(0), i64_parameter(6));
    let eq = binary("eq", field(0), i64_parameter(8));
    let ne = binary("ne", field(0), i64_parameter(7));
    let not = json!({"op": "not", "value": field(1)});
    let and = binary("and", not, eq);
    let or = binary("or", field(1), and);
    let structure = structure(json!([lt, lte, gt, gte, ne, or]));
    let parameters =
        json!([2, 3, 4, -23, -5, -6, -5, -6, -5]
            .map(|i| json!({"type": "i64", "value": i.to_string()})));
    let reference = bundle(BundleKind::Reference, &[]);
    let delivery = bundle(
        BundleKind::Delivery,
        &[("report.json", br#"{"total":"-5","complete":false}"#)],
    );
    assert_eq!(
        run(&structure, &parameters, &delivery, &reference)
            .unwrap()
            .0
            .verdict,
        Verdict::Pass
    );
    let delivery = bundle(
        BundleKind::Delivery,
        &[("report.json", br#"{"total":"-4","complete":true}"#)],
    );
    assert_eq!(
        run(&structure, &parameters, &delivery, &reference)
            .unwrap()
            .0
            .verdict,
        Verdict::Fail
    );
}

#[test]
fn uses_declared_indices_and_encrypts_exact_delivery_bytes_for_both_verdicts() {
    let mut structure = structure(json!([
        field(1),
        binary(
            "eq",
            json!({"op": "field", "source": "deliverable", "file": 1}),
            json!({"op": "field", "source": "reference", "file": 0}),
        ),
    ]));
    structure["references"] = json!([{"name": "reference.txt", "parser": "text/v1", "fields": []}]);
    structure["deliverables"].as_array_mut().unwrap().extend([
        json!({"name": "note.txt", "parser": "text/v1", "fields": []}),
        json!({"name": "blob", "parser": "opaque/v1", "fields": []}),
    ]);
    let reference = bundle(BundleKind::Reference, &[("reference.txt", b"hi\n")]);
    for (text, expected) in [(b"hi\n".as_slice(), Verdict::Pass), (b"hi", Verdict::Fail)] {
        let delivery = bundle(
            BundleKind::Delivery,
            &[
                (
                    "report.json",
                    b"{ \"total\":\"9223372036854775807\",\"complete\": true }\n",
                ),
                ("note.txt", text),
                ("blob", &[0xff]),
            ],
        );
        let (journal, envelope) = run(&structure, &json!([]), &delivery, &reference).unwrap();
        assert_eq!(journal.verdict, expected);
        assert_eq!(
            journal.key_commitment,
            key_commitment(&journal.context, &KEY)
        );
        assert_eq!(journal.envelope_hash, sha256(&envelope));
        assert_eq!(
            decrypt_delivery(&journal.context, &KEY, &envelope).unwrap(),
            delivery
        );
    }
}

#[test]
fn rejects_malformed_files_and_bundle_sets() {
    let structure = structure(json!([field(1)]));
    let reference = bundle(BundleKind::Reference, &[]);
    let invalid = [
        br#"{"complete":true}"#.as_slice(),
        br#"{"total":"0","complete":1}"#,
        br#"{"total":"0","complete":true,"complete":false}"#,
        br#"{"total":"9223372036854775808","complete":true}"#,
        br#"{"total":1.0,"complete":true}"#,
        br#"{"total":1,"complete":true}"#,
        br#"{"total":"-9223372036854775809","complete":true}"#,
        br#"{"total":"01","complete":true}"#,
        br#"{"total":"-0","complete":true}"#,
        b"{\"total\":\"1\",\"complete\":true,\"other\":\"\xff\"}",
    ];
    for contents in invalid {
        let delivery = bundle(BundleKind::Delivery, &[("report.json", contents)]);
        assert_eq!(
            run(&structure, &json!([]), &delivery, &reference),
            Err(CheckError::FileContents)
        );
    }
    for files in [
        vec![],
        vec![("other.json", br#"{}"#.as_slice())],
        vec![("report.json", br#"{}"#.as_slice()), ("extra.txt", b"")],
    ] {
        let delivery = bundle(BundleKind::Delivery, &files);
        assert_eq!(
            run(&structure, &json!([]), &delivery, &reference),
            Err(CheckError::FileSet)
        );
    }
}

#[test]
fn rejects_malformed_or_uncommitted_parameters_and_reference() {
    let structure = canonical(&structure(json!([binary(
        "eq",
        field(0),
        i64_parameter(0)
    )])));
    let parameters = br#"[{"type":"i64","value":"1"}]"#;
    let reference = bundle(BundleKind::Reference, &[]);
    let delivery = bundle(
        BundleKind::Delivery,
        &[("report.json", br#"{"total":"1","complete":true}"#)],
    );
    let funded = context(&structure, parameters, &reference);
    let invalid = [
        br#"[ { "type": "i64", "value": "1" } ]"#.as_slice(),
        br#"[{"type":"i64","type":"i64","value":"1"}]"#,
        br#"[{"type":"i64","value":"01"}]"#,
        br#"[{"type":"i64","value":1}]"#,
        br#"[{"type":"bool","value":true}]"#,
        br#"[{"type":"i64","value":"9223372036854775808"}]"#,
        br#"[{"type":"i64","value":"1"},{"type":"i64","value":"2"}]"#,
        b"[]",
    ];
    for input in invalid {
        assert_eq!(
            check(
                &structure,
                input,
                &reference,
                &delivery,
                &context(&structure, input, &reference),
                &KEY,
                &NONCE
            ),
            Err(CheckError::Parameters)
        );
    }
    assert_eq!(
        check(
            &structure,
            br#"[{"type":"i64","value":"2"}]"#,
            &reference,
            &delivery,
            &funded,
            &KEY,
            &NONCE
        ),
        Err(CheckError::RulesHash)
    );
    let substituted = bundle(BundleKind::Reference, &[("other", b"changed")]);
    assert_eq!(
        check(
            &structure,
            parameters,
            &substituted,
            &delivery,
            &funded,
            &KEY,
            &NONCE
        ),
        Err(CheckError::ReferenceHash)
    );
}

#[test]
fn rejects_overflow_in_every_arithmetic_operator() {
    let reference = bundle(BundleKind::Reference, &[]);
    let delivery = bundle(
        BundleKind::Delivery,
        &[(
            "report.json",
            br#"{"total":"9223372036854775807","complete":true}"#,
        )],
    );
    for (op, decimal) in [("add", "1"), ("sub", "-1"), ("mul", "2")] {
        let overflow = binary(op, field(0), i64_parameter(0));
        let comparison = binary("eq", overflow, field(0));
        let structure = structure(json!([binary("or", field(1), comparison)]));
        assert_eq!(
            run(
                &structure,
                &json!([{"type":"i64","value":decimal}]),
                &delivery,
                &reference
            ),
            Err(CheckError::Overflow)
        );
    }
}

#[test]
fn enforces_rule_depth_and_node_limits() {
    let reference = bundle(BundleKind::Reference, &[]);
    let delivery = bundle(
        BundleKind::Delivery,
        &[("report.json", br#"{"total":"1","complete":true}"#)],
    );
    let mut expression = field(1);
    for _ in 0..31 {
        expression = json!({"op": "not", "value": expression});
    }
    assert!(run(
        &structure(json!([expression])),
        &json!([]),
        &delivery,
        &reference
    )
    .is_ok());
    let deep = json!({"op": "not", "value": expression});
    assert_eq!(
        run(&structure(json!([deep])), &json!([]), &delivery, &reference),
        Err(CheckError::Rule)
    );
    let mut many = vec![field(1); 256];
    assert!(run(&structure(json!(many)), &json!([]), &delivery, &reference).is_ok());
    many[255] = json!({"op": "not", "value": field(1)});
    assert_eq!(
        run(&structure(json!(many)), &json!([]), &delivery, &reference),
        Err(CheckError::Rule)
    );
}

#[test]
fn validates_reference_and_accepts_both_i64_limits() {
    let mut structure = structure(json!([binary("eq", field(0), i64_parameter(0))]));
    structure["references"] = structure["deliverables"].clone();
    for decimal in ["-9223372036854775808", "9223372036854775807"] {
        let contents = format!(r#"{{"total":"{decimal}","complete":true}}"#);
        let files = [("report.json", contents.as_bytes())];
        let reference = bundle(BundleKind::Reference, &files);
        let delivery = bundle(BundleKind::Delivery, &files);
        assert!(validate_reference(&canonical(&structure), &reference).is_ok());
        assert_eq!(
            run(
                &structure,
                &json!([{"type":"i64","value":decimal}]),
                &delivery,
                &reference
            )
            .unwrap()
            .0
            .verdict,
            Verdict::Pass,
        );
    }
    let missing = bundle(BundleKind::Reference, &[]);
    assert_eq!(
        validate_reference(&canonical(&structure), &missing),
        Err(CheckError::FileSet)
    );
    let invalid = bundle(
        BundleKind::Reference,
        &[("report.json", br#"{"total":0,"complete":true}"#)],
    );
    assert_eq!(
        validate_reference(&canonical(&structure), &invalid),
        Err(CheckError::FileContents)
    );
}
