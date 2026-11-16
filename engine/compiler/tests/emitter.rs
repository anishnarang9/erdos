use serde_json::{json, Value};
use ubc26_compiler::{emit_rules, validate_plan};

#[test]
fn generated_source_contains_only_normalized_operations_and_indices() {
    let mut plan: Value =
        serde_json::from_str(include_str!("../../fixtures/expense-report-plan.json")).unwrap();
    plan["rules"][0] = json!({"op":"eq","left":{"op":"literal","type":"string","value":"\"; panic!(\"injected\"); //"},"right":{"op":"literal","type":"string","value":"same"}});
    let report =
        serde_json::to_value(validate_plan(&serde_json::to_vec(&plan).unwrap()).unwrap()).unwrap();
    let generated = emit_rules(&report["structure"]).unwrap();
    assert!(generated.contains("E::Eq(B{"));
    assert!(generated.contains("E::Parameter{slot:0,kind:K::String}"));
    assert!(!generated.contains("panic!"));
    assert!(!generated.contains("totalCents"));
    assert!(emit_rules(&json!({"rules":[{"op":"system","command":"anything"}]})).is_err());
}

#[test]
fn changing_a_threshold_preserves_generated_source() {
    let mut plan: Value =
        serde_json::from_str(include_str!("../../fixtures/reconciliation/plan.json")).unwrap();
    let original =
        serde_json::to_value(validate_plan(&serde_json::to_vec(&plan).unwrap()).unwrap()).unwrap();
    plan["rules"][2]["right"]["value"] = json!("2");
    let changed =
        serde_json::to_value(validate_plan(&serde_json::to_vec(&plan).unwrap()).unwrap()).unwrap();
    assert_eq!(
        emit_rules(&original["structure"]).unwrap(),
        emit_rules(&changed["structure"]).unwrap()
    );
}
