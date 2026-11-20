use serde_json::{json, Value};
use ubc26_compiler::validate_plan;
use ubc26_guest_runtime::{check, CheckError};
use ubc26_protocol::{
    encode_bundle, reference_hash, rules_hash, structure_hash, BundleKind, FundedContext,
    NamedFile, Verdict,
};

fn collection(source: &str, file: &str, field: &str) -> Value {
    json!({"source": source,"file":file,"field":field})
}

fn field(name: &str) -> Value {
    json!({"op":"record_field","field":name})
}
fn literal(value: &str) -> Value {
    json!({"op":"literal","type":"i64","value":value})
}

fn plan() -> Value {
    let rows = collection("deliverable", "result.json", "rows");
    let ledger = collection("reference", "ledger.json", "rows");
    json!({
        "version":1,
        "deliverables":[{"name":"result.json","parser":"json/v1","collections":[{
            "name":"rows","fields":[{"name":"id","type":"string"},{"name":"amount","type":"i64"}]
        }]}],
        "references":[{"name":"ledger.json","parser":"json/v1","collections":[{
            "name":"rows","fields":[{"name":"id","type":"string"},{"name":"amount","type":"i64"}]
        }]}],
        "rules":[
            {"op":"unique","collection":rows,"field":"id"},
            {"op":"gte","left":{"op":"count","collection":rows},"right":literal("1")},
            {"op":"eq","left":{"op":"sum","collection":rows,"value":field("amount")},"right":literal("30")},
            {"op":"all","collection":rows,"where":{"op":"eq","left":field("amount"),"right":{
                "op":"lookup","collection":ledger,"keyField":"id","key":field("id"),"valueField":"amount"
            }}},
            {"op":"any","collection":rows,"where":{"op":"gt","left":field("amount"),"right":literal("15")}},
            {"op":"eq","left":{"op":"count","collection":rows,"where":{"op":"gt","left":field("amount"),"right":literal("15")}},"right":literal("1")}
        ]
    })
}

fn run(plan: &Value, rows: Value, ledger: Value) -> Result<Verdict, CheckError> {
    let report =
        serde_json::to_value(validate_plan(&serde_json::to_vec(plan).unwrap()).unwrap()).unwrap();
    let structure = report["structureJcs"].as_str().unwrap().as_bytes();
    let parameters = report["parametersJcs"].as_str().unwrap().as_bytes();
    let input = serde_json::to_vec(&json!({"rows": rows})).unwrap();
    let reference = serde_json::to_vec(&json!({"rows": ledger})).unwrap();
    let delivery = encode_bundle(
        BundleKind::Delivery,
        &[NamedFile {
            name: "result.json",
            contents: &input,
        }],
    )
    .unwrap();
    let reference = encode_bundle(
        BundleKind::Reference,
        &[NamedFile {
            name: "ledger.json",
            contents: &reference,
        }],
    )
    .unwrap();
    let context = FundedContext {
        chain_id: [0; 32],
        escrow: [0; 20],
        job_id: [0; 32],
        provider: [0; 20],
        rules_hash: rules_hash(&structure_hash(structure), parameters),
        reference_hash: reference_hash(&reference),
    };
    check(
        structure, parameters, &reference, &delivery, &context, &[4; 32], &[8; 12],
    )
    .map(|(journal, _)| journal.verdict)
}

fn rows() -> Value {
    json!([{"id":"a","amount":"10"},{"id":"b","amount":"20"}])
}

#[test]
fn reconciles_records_and_detects_a_changed_result() {
    assert_eq!(run(&plan(), rows(), rows()).unwrap(), Verdict::Pass);
    let mut changed = rows();
    changed[0]["amount"] = json!("11");
    assert_eq!(run(&plan(), changed, rows()).unwrap(), Verdict::Fail);
}

#[test]
fn requires_exactly_one_join_and_bounded_record_lists() {
    let mut duplicate = rows();
    duplicate.as_array_mut().unwrap().push(rows()[0].clone());
    assert!(run(&plan(), rows(), duplicate).is_err());
    assert!(run(&plan(), rows(), json!([])).is_err());
    assert!(run(&plan(), json!(vec![rows()[0].clone(); 257]), rows()).is_err());
}

#[test]
fn checks_duplicate_join_keys_only_when_that_key_field_is_used() {
    let mut input = plan();
    // The extra rows have distinct IDs and share an amount. The ID lookup stays valid.
    let ledger = json!([
        {"id":"a","amount":"10"},
        {"id":"b","amount":"20"},
        {"id":"c","amount":"30"},
        {"id":"d","amount":"30"}
    ]);
    assert_eq!(run(&input, rows(), ledger.clone()), Ok(Verdict::Pass));

    let amount_lookup = json!({
        "op":"eq",
        "left":{
            "op":"lookup","collection":collection("reference", "ledger.json", "rows"),
            "keyField":"amount","key":literal("10"),"valueField":"id"
        },
        "right":{"op":"literal","type":"string","value":"a"}
    });
    input["rules"].as_array_mut().unwrap().push(amount_lookup);
    assert_eq!(run(&input, rows(), rows()), Ok(Verdict::Pass));
    // A lookup for 10 rejects duplicate keys elsewhere in the same index.
    assert_eq!(run(&input, rows(), ledger), Err(CheckError::Rule));
}

#[test]
fn an_if_guard_skips_only_the_unselected_lookup() {
    let mut input = plan();
    let condition = json!({"op":"literal","type":"bool","value":false});
    let lookup = json!({
        "op":"lookup","collection":collection("reference","ledger.json","rows"),
        "keyField":"id","key":{"op":"literal","type":"string","value":"missing"},
        "valueField":"amount"
    });
    input["rules"] = json!([{"op":"eq","left":{
        "op":"if","condition":condition,"then":lookup,"else":literal("10")
    },"right":literal("10")}]);
    assert_eq!(run(&input, rows(), rows()), Ok(Verdict::Pass));
    input["rules"][0]["right"] = literal("11");
    assert_eq!(run(&input, rows(), rows()), Ok(Verdict::Fail));
    input["rules"][0]["left"]["condition"]["value"] = json!(true);
    assert_eq!(run(&input, rows(), rows()), Err(CheckError::Rule));
}

#[test]
fn handles_empty_quantifiers_and_repeated_runtime_parameters() {
    let mut input = plan();
    let collection = collection("deliverable", "result.json", "rows");
    let predicate = json!({"op":"gte","left":field("amount"),"right":literal("0")});
    input["rules"] = json!([{"op":"all","collection":collection,"where":predicate}]);
    assert_eq!(run(&input, json!([]), rows()).unwrap(), Verdict::Pass);
    assert_eq!(run(&input, rows(), rows()).unwrap(), Verdict::Pass);
    input["rules"][0]["op"] = json!("any");
    assert_eq!(run(&input, json!([]), rows()).unwrap(), Verdict::Fail);
}

#[test]
fn sum_uses_checked_i64_and_keys_retain_their_types() {
    let mut input = plan();
    input["rules"] = json!([{"op":"gte","left":{"op":"sum","collection":collection("deliverable","result.json","rows"),"value":field("amount")},"right":literal("0")}]);
    assert_eq!(
        run(
            &input,
            json!([{"id":"a","amount":"9223372036854775807"},{"id":"b","amount":"1"}]),
            rows()
        ),
        Err(CheckError::Overflow)
    );
    input["rules"][0]["left"]["value"]["field"] = json!("missing");
    assert!(validate_plan(&serde_json::to_vec(&input).unwrap()).is_err());
}
