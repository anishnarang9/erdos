use serde_json::{json, Value};
use ubc26_guest_runtime::{check, validate_package, CheckError};
use ubc26_protocol::{
    encode_bundle, reference_hash, rules_hash, structure_hash, BundleKind, FundedContext,
    NamedFile, Verdict,
};

fn collection() -> Value {
    json!({"source":"deliverable","file":0,"field":0})
}

fn record(field: usize, level: usize) -> Value {
    json!({"op":"record_field","field":field,"level":level})
}

fn structure(rule: Value) -> Value {
    json!({
        "version":1,"references":[],"evidence":[],
        "deliverables":[{"name":"rows.json","parser":"json/v1","fields":[],"collections":[{
            "name":"rows","fields":[{"name":"id","type":"string"},{"name":"amount","type":"i64"}]
        }]}],
        "rules":[rule]
    })
}

fn run(input: &Value, parameters: &Value, rows: &Value) -> Result<Verdict, CheckError> {
    let structure = serde_json_canonicalizer::to_vec(input).unwrap();
    let parameters = serde_json_canonicalizer::to_vec(parameters).unwrap();
    let payload = serde_json::to_vec(&json!({"rows":rows})).unwrap();
    let delivery = encode_bundle(
        BundleKind::Delivery,
        &[NamedFile {
            name: "rows.json",
            contents: &payload,
        }],
    )
    .unwrap();
    let reference = encode_bundle(BundleKind::Reference, &[]).unwrap();
    let context = FundedContext {
        chain_id: [0; 32],
        escrow: [0; 20],
        job_id: [0; 32],
        provider: [0; 20],
        rules_hash: rules_hash(&structure_hash(&structure), &parameters),
        reference_hash: reference_hash(&reference),
    };
    check(
        &structure,
        &parameters,
        &reference,
        &delivery,
        &context,
        &[4; 32],
        &[8; 12],
    )
    .map(|(journal, _)| journal.verdict)
}

fn assert_rejected(input: &Value, parameters: &Value) {
    assert!(
        run(input, parameters, &json!([])).is_err(),
        "runtime accepted {input}"
    );
    let structure = serde_json_canonicalizer::to_vec(input).unwrap();
    let parameters = serde_json_canonicalizer::to_vec(parameters).unwrap();
    let reference = encode_bundle(BundleKind::Reference, &[]).unwrap();
    assert!(
        validate_package(&structure, &parameters, &reference).is_err(),
        "package accepted {input}"
    );
}

#[test]
fn rejects_invalid_selectors_and_types_inside_empty_quantifiers() {
    for body in [
        record(999, 0),
        record(0, 999),
        record(1, 0),
        json!({"op":"field","source":"deliverable","file":999,"field":0}),
        json!({"op":"all","collection":{"source":"reference","file":0,"field":0},"where":record(0,0)}),
        json!({"op":"add","left":record(0,0),"right":record(0,0)}),
    ] {
        assert_rejected(
            &structure(json!({"op":"all","collection":collection(),"where":body})),
            &json!([]),
        );
    }
    assert_rejected(
        &structure(json!({"op":"unique","collection":collection(),"field":999})),
        &json!([]),
    );
    assert_rejected(
        &structure(
            json!({"op":"eq","left":{"op":"sum","collection":collection(),"value":record(0,0)},"right":{"op":"count","collection":collection()}}),
        ),
        &json!([]),
    );
}

#[test]
fn validates_lookup_fields_and_key_types_even_when_outer_list_is_empty() {
    for (key_field, key, value_field) in [
        (999, record(0, 0), 1),
        (0, record(0, 0), 999),
        (0, record(1, 0), 1),
    ] {
        let lookup = json!({"op":"lookup","collection":collection(),"keyField":key_field,"key":key,"valueField":value_field});
        let rule = json!({"op":"all","collection":collection(),"where":{"op":"eq","left":lookup,"right":record(1,0)}});
        assert_rejected(&structure(rule), &json!([]));
    }
}

#[test]
fn validates_parameter_binding_in_unvisited_bodies() {
    let rule = json!({"op":"all","collection":collection(),"where":{"op":"eq","left":record(1,0),"right":{"op":"parameter","slot":0,"type":"i64"}}});
    let mut input = structure(rule);
    assert_eq!(
        run(&input, &json!([{"type":"i64","value":"1"}]), &json!([])),
        Ok(Verdict::Pass)
    );
    assert_rejected(&input, &json!([]));
    assert_rejected(&input, &json!([{"type":"bool","value":true}]));
    input["rules"][0]["where"]["right"]["slot"] = json!(1);
    assert_rejected(
        &input,
        &json!([{"type":"i64","value":"1"},{"type":"i64","value":"2"}]),
    );
}

#[test]
fn checks_outer_scopes_and_accepts_the_record_limit() {
    let rule = json!({"op":"all","collection":collection(),"where":{
        "op":"any","collection":collection(),"where":{"op":"eq","left":record(0,0),"right":record(0,1)}
    }});
    let mut input = structure(rule);
    let rows = json!((0..256)
        .map(|i| json!({"id":i.to_string(),"amount":i.to_string()}))
        .collect::<Vec<_>>());
    assert_eq!(run(&input, &json!([]), &rows), Ok(Verdict::Pass));
    input["rules"][0]["where"]["where"]["right"]["level"] = json!(2);
    assert_rejected(&input, &json!([]));
}

#[test]
fn validates_delivery_schemas_before_packaging() {
    let mut input = structure(json!({"op":"unique","collection":collection(),"field":0}));
    input["deliverables"][0]["collections"][0]["fields"][1]["name"] = json!("id");
    assert_rejected(&input, &json!([]));
    input = structure(json!({"op":"unique","collection":collection(),"field":0}));
    input["deliverables"][0]["parser"] = json!("text/v1");
    assert_rejected(&input, &json!([]));
}

#[test]
fn validates_tree_bounds_inside_empty_collections() {
    let mut body = json!({"op":"eq","left":record(0,0),"right":record(0,0)});
    for _ in 0..32 {
        body = json!({"op":"not","value":body});
    }
    assert_rejected(
        &structure(json!({"op":"all","collection":collection(),"where":body})),
        &json!([]),
    );

    let leaf = json!({"op":"eq","left":record(0,0),"right":record(0,0)});
    let mut body = leaf.clone();
    for _ in 0..6 {
        body = json!({"op":"and","left":body.clone(),"right":body});
    }
    let boundary = structure(json!({"op":"all","collection":collection(),"where":body}));
    assert_eq!(run(&boundary, &json!([]), &json!([])), Ok(Verdict::Pass));
    let over_limit = structure(
        json!({"op":"all","collection":collection(),"where":{"op":"not","value":boundary["rules"][0]["where"]}}),
    );
    assert_rejected(&over_limit, &json!([]));
}
