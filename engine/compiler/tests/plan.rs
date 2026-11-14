use serde_json::{json, Value};
use ubc26_compiler::validate_plan;

fn plan() -> Value {
    json!({
        "version": 1,
        "deliverables": [{
            "name": "reconciliation.json",
            "parser": "json/v1",
            "fields": [{"name": "totalCents", "type": "i64"}]
        }],
        "references": [],
        "rules": [{
            "op": "lte",
            "left": {"op": "field", "source": "deliverable", "file": "reconciliation.json", "field": "totalCents"},
            "right": {"op": "literal", "type": "i64", "value": "001000"}
        }]
    })
}

fn validate(plan: &Value) -> Result<Value, Value> {
    validate_plan(&serde_json::to_vec(plan).unwrap())
        .map(|result| serde_json::to_value(result).unwrap())
        .map_err(|error| serde_json::to_value(error).unwrap())
}

#[test]
fn normalizes_parameters_without_changing_the_structure_hash() {
    let mut input = plan();
    let first = validate(&input).unwrap();
    assert_eq!(
        first["parameters"],
        json!([{"type": "i64", "value": "1000"}])
    );
    assert_eq!(
        first["structure"]["rules"][0]["right"],
        json!({"op": "parameter", "slot": 0, "type": "i64"})
    );
    input["rules"][0]["right"]["value"] = json!("1001");
    let second = validate(&input).unwrap();
    assert_eq!(first["structureHash"], second["structureHash"]);
    assert_ne!(first["rulesHash"], second["rulesHash"]);
    input["rules"][0]["op"] = json!("lt");
    assert_ne!(
        first["structureHash"],
        validate(&input).unwrap()["structureHash"]
    );
}

#[test]
fn rejects_duplicate_and_unknown_fields() {
    let text = plan()
        .to_string()
        .replace(r#""op":"lte""#, r#""op":"lte","op":"gte""#);
    assert_eq!(
        serde_json::to_value(validate_plan(text.as_bytes()).unwrap_err()).unwrap()["code"],
        "invalid_plan"
    );
    let mut input = plan();
    input["rules"][0]["right"]["unexpected"] = json!(1);
    assert_eq!(validate(&input).unwrap_err()["code"], "invalid_plan");
}

#[test]
fn rejects_unknown_field_overflow_and_non_boolean_rule() {
    let mut input = plan();
    input["rules"][0]["left"]["field"] = json!("missing");
    assert_eq!(validate(&input).unwrap_err()["path"], "/rules/0/left");
    input = plan();
    input["rules"][0]["right"]["value"] = json!("9223372036854775808");
    assert_eq!(
        validate(&input).unwrap_err()["path"],
        "/rules/0/right/value"
    );
    input["rules"] = json!([{"op":"literal","type":"i64","value":"2"}]);
    assert_eq!(validate(&input).unwrap_err()["path"], "/rules/0");
}

#[test]
fn reports_unsupported_operations_with_a_fileable_request() {
    let mut input = plan();
    input["rules"][0] = json!({"op": "regex_match", "list": "records"});
    let error = validate(&input).unwrap_err();
    assert_eq!(error["code"], "unsupported_capability");
    assert_eq!(error["path"], "/rules/0/op");
    assert_eq!(
        error["request"],
        json!({"kind": "operation", "name": "regex_match"})
    );
}

#[test]
fn rejects_paths_and_duplicate_file_names() {
    let mut input = plan();
    input["deliverables"][0]["name"] = json!("../private.json");
    assert_eq!(
        validate(&input).unwrap_err()["path"],
        "/deliverables/0/name"
    );
    input = plan();
    input["deliverables"]
        .as_array_mut()
        .unwrap()
        .push(plan()["deliverables"][0].clone());
    assert_eq!(
        validate(&input).unwrap_err()["path"],
        "/deliverables/1/name"
    );
}

#[test]
fn preserves_strings_in_canonical_parameters() {
    let text = json!({"op": "literal", "type": "string", "value": " ok 🦀\n"});
    let mut input = plan();
    input["rules"][0] = json!({
        "op": "eq",
        "left": {"op": "field", "source": "deliverable", "file": "note.txt"},
        "right": text
    });
    input["deliverables"] = json!([{"name": "note.txt", "parser": "text/v1"}]);
    let result = validate(&input).unwrap();
    assert_eq!(result["parameters"][0]["value"], text["value"]);
    assert_eq!(
        serde_json::from_str::<Value>(result["parametersJcs"].as_str().unwrap()).unwrap(),
        result["parameters"]
    );
}

#[test]
fn reports_a_complete_evidence_request_as_unsupported() {
    let mut input = plan();
    input["evidence"] = json!([{
        "profile": "missing/v1",
        "signer": "0x1234",
        "schema": {"amount": "i64"},
        "bindings": ["artifactHash"]
    }]);
    let error = validate(&input).unwrap_err();
    assert_eq!(error["path"], "/evidence/0/profile");
    assert_eq!(
        error["request"],
        json!({"kind": "evidence", "name": "missing/v1"})
    );
}
