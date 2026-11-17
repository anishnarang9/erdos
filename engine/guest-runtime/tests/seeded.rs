//! Deterministic compiler/runtime checks against case-specific independent oracles.
//!
//! Run all cases: cargo test -p ubc26-guest-runtime --test seeded -- --nocapture
//! Save coverage: UBC26_SEEDED_REPORT=/tmp/seeded.json cargo test ...
//! Replay one case: UBC26_SEEDED_CASE=123 cargo test ...
//! Failures include exact plans, bundles, parameter bytes, and replay commands.
//! The engine evaluator never supplies expected results. Arithmetic uses i128,
//! collections use host Vec calculations, and rejection cases use fixed rules.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use ubc26_compiler::validate_plan;
use ubc26_guest_runtime::{check, check_generated, Expression};
use ubc26_protocol::{reference_hash, rules_hash, structure_hash, FundedContext, Verdict};

const BASE_SEED: u64 = 0x5542_4332_365f_7631;
const CASES: usize = 10_000;
const FAMILIES: [&str; 40] = [
    "add",
    "sub",
    "mul",
    "lt",
    "lte",
    "gt",
    "gte",
    "eq_i64",
    "ne_i64",
    "and",
    "or",
    "not",
    "eq_string",
    "ne_bool",
    "count",
    "count_where",
    "sum",
    "all",
    "any",
    "unique",
    "lookup_hit",
    "lookup_missing",
    "lookup_duplicate",
    "nested_scopes",
    "file_size",
    "file_hash",
    "text",
    "reference_field",
    "malformed_i64",
    "malformed_json",
    "malformed_collection",
    "file_set",
    "eager_boolean_overflow",
    "sum_prefix_overflow",
    "literal_normalization",
    "bundle_size",
    "compiler_rejection",
    "malformed_parameters",
    "rule_limits",
    "eager_quantifier_error",
];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // SplitMix64. This algorithm and BASE_SEED define the corpus version.
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn small(&mut self) -> i64 {
        (self.next() % 101) as i64 - 50
    }
    fn integer(&mut self) -> i64 {
        const EDGES: [i64; 13] = [
            i64::MIN,
            i64::MIN + 1,
            -3_037_000_500,
            -3_037_000_499,
            -2,
            -1,
            0,
            1,
            2,
            3_037_000_499,
            3_037_000_500,
            i64::MAX - 1,
            i64::MAX,
        ];
        if self.next() & 1 == 0 {
            EDGES[self.next() as usize % EDGES.len()]
        } else {
            self.next() as i64
        }
    }
}

#[derive(Clone)]
struct File {
    name: String,
    contents: Vec<u8>,
}
fn file(name: &str, contents: impl Into<Vec<u8>>) -> File {
    File {
        name: name.into(),
        contents: contents.into(),
    }
}
fn literal(kind: &str, value: Value) -> Value {
    json!({"op":"literal","type":kind,"value":value})
}
fn int(value: i64) -> Value {
    literal("i64", json!(value.to_string()))
}
fn boolean(value: bool) -> Value {
    literal("bool", json!(value))
}
fn string(value: &str) -> Value {
    literal("string", json!(value))
}
fn binary(op: &str, left: Value, right: Value) -> Value {
    json!({"op":op,"left":left,"right":right})
}
fn field(source: &str, name: &str) -> Value {
    json!({"op":"field","source":source,"file":"data.json","field":name})
}
fn rows(source: &str) -> Value {
    json!({"source":source,"file":"data.json","field":"rows"})
}
fn record(name: &str, level: usize) -> Value {
    json!({"op":"record_field","field":name,"level":level})
}
fn aggregate(op: &str) -> Value {
    json!({"op":op,"collection":rows("deliverable")})
}
fn schema() -> Value {
    json!({"name":"data.json","parser":"json/v1","fields":[
        {"name":"a","type":"i64"},{"name":"b","type":"i64"},
        {"name":"p","type":"bool"},{"name":"q","type":"bool"},
        {"name":"s","type":"string"}],"collections":[{"name":"rows","fields":[
        {"name":"id","type":"string"},{"name":"amount","type":"i64"},
        {"name":"ok","type":"bool"}]}]})
}
fn row(id: impl Into<String>, amount: i64, ok: bool) -> Value {
    json!({"id":id.into(),"amount":amount.to_string(),"ok":ok})
}
fn content(a: i64, b: i64, p: bool, q: bool, s: &str, rows: &[Value]) -> Value {
    json!({"a":a.to_string(),"b":b.to_string(),"p":p,"q":q,"s":s,"rows":rows})
}

struct Case {
    id: usize,
    seed: u64,
    family: &'static str,
    input: String,
    expected: String,
    plan: Value,
    delivery: Vec<File>,
    reference: Vec<File>,
    delivery_override: Option<Vec<u8>>,
    parameter_mutation: Option<usize>,
}
impl Case {
    fn verdict(&mut self, passed: bool) {
        self.expected = if passed { "pass" } else { "fail" }.into();
    }
    fn runtime_error(&mut self, category: &str) {
        self.expected = format!("runtime:{category}");
    }
    fn compiler_error(&mut self, category: &str) {
        self.expected = format!("compiler:{category}");
    }
    fn rule(&mut self, rule: Value) {
        self.plan["rules"] = json!([rule]);
    }
    fn contents(&mut self, value: Value) {
        self.delivery[0].contents = serde_json::to_vec(&value).unwrap();
    }
    fn opaque(&mut self, contents: Vec<u8>) {
        self.plan["deliverables"] = json!([{"name":"blob.bin","parser":"opaque/v1"}]);
        self.delivery = vec![file("blob.bin", contents)];
    }
}

fn generated_case(id: usize) -> Case {
    let seed = BASE_SEED.wrapping_add(id as u64);
    let mut rng = Rng(seed);
    let family = id % FAMILIES.len();
    let sample = id / FAMILIES.len();
    let a = rng.integer();
    let b = if sample.is_multiple_of(5) {
        a
    } else {
        rng.integer()
    };
    let p = rng.next() & 1 != 0;
    let q = rng.next() & 1 != 0;
    let text = ["", "a", "a\n", "\0", "é", "e\u{301}", "🦀", "\"\\"][sample % 8];
    let length = if family == 14 && sample.is_multiple_of(31) {
        256
    } else if sample.is_multiple_of(17) {
        0
    } else {
        (rng.next() % 7 + 1) as usize
    };
    let amounts: Vec<i64> = (0..length).map(|_| rng.small()).collect();
    let flags: Vec<bool> = (0..length).map(|_| rng.next() & 1 != 0).collect();
    let records: Vec<Value> = amounts
        .iter()
        .zip(&flags)
        .enumerate()
        .map(|(i, (&n, &ok))| row(format!("k{i}"), n, ok))
        .collect();
    let mut c = Case {
        id,
        seed,
        family: FAMILIES[family],
        input: "valid_generated".into(),
        expected: "pass".into(),
        plan: json!({"version":1,"deliverables":[schema()],"references":[],"rules":[boolean(true)]}),
        delivery: vec![file(
            "data.json",
            serde_json::to_vec(&content(a, b, p, q, text, &records)).unwrap(),
        )],
        reference: vec![],
        delivery_override: None,
        parameter_mutation: None,
    };
    let fa = || field("deliverable", "a");
    let fb = || field("deliverable", "b");
    let fp = || field("deliverable", "p");
    let fq = || field("deliverable", "q");
    match family {
        0..=2 => {
            let op = ["add", "sub", "mul"][family];
            let wide = match family {
                0 => a as i128 + b as i128,
                1 => a as i128 - b as i128,
                _ => a as i128 * b as i128,
            };
            let actual = i64::try_from(wide);
            let expected_value = actual.unwrap_or(0);
            let target = if sample.is_multiple_of(3) {
                expected_value ^ 1
            } else {
                expected_value
            };
            c.rule(binary("eq", binary(op, fa(), fb()), int(target)));
            match actual {
                Ok(n) => c.verdict(n == target),
                Err(_) => c.runtime_error("Overflow"),
            }
            c.input = if actual.is_ok() {
                "i64_in_range"
            } else {
                "i64_overflow"
            }
            .into();
        }
        3..=8 => {
            let op = ["lt", "lte", "gt", "gte", "eq", "ne"][family - 3];
            c.rule(binary(op, fa(), fb()));
            c.verdict(match family {
                3 => a < b,
                4 => a <= b,
                5 => a > b,
                6 => a >= b,
                7 => a == b,
                _ => a != b,
            });
            c.input = if a == b {
                "equal_operands"
            } else {
                "unequal_operands"
            }
            .into();
        }
        9..=11 => {
            c.rule(match family {
                9 => binary("and", fp(), fq()),
                10 => binary("or", fp(), fq()),
                _ => json!({"op":"not","value":fp()}),
            });
            c.verdict(match family {
                9 => p && q,
                10 => p || q,
                _ => !p,
            });
            c.input = format!("bool_{p}_{q}");
        }
        12 => {
            let other = if sample.is_multiple_of(2) {
                text.to_owned()
            } else {
                format!("{text}x")
            };
            c.rule(binary("eq", field("deliverable", "s"), string(&other)));
            c.verdict(text == other);
            c.input = "unicode_or_escaped_string".into();
        }
        13 => {
            c.rule(binary("ne", fp(), fq()));
            c.verdict(p != q);
        }
        14..=18 => {
            let op = ["count", "count", "sum", "all", "any"][family - 14];
            let mut expr = aggregate(op);
            if matches!(family, 15 | 17 | 18) {
                expr["where"] = record("ok", 0);
            }
            if family == 16 {
                expr["value"] = record("amount", 0);
            }
            if family <= 16 {
                let expected = match family {
                    14 => length as i64,
                    15 => flags.iter().filter(|&&v| v).count() as i64,
                    _ => amounts.iter().map(|&v| v as i128).sum::<i128>() as i64,
                };
                let target = expected + i64::from(sample.is_multiple_of(3));
                c.rule(binary("eq", expr, int(target)));
                c.verdict(expected == target);
            } else {
                c.rule(expr);
                c.verdict(if family == 17 {
                    flags.iter().all(|&v| v)
                } else {
                    flags.iter().any(|&v| v)
                });
            }
            c.input = if length == 0 {
                "empty_collection"
            } else {
                "nonempty_collection"
            }
            .into();
        }
        19 => {
            let mut modified = records.clone();
            if sample.is_multiple_of(2) && !modified.is_empty() {
                modified.push(modified[0].clone());
            }
            let key_field = ["id", "amount", "ok"][sample % 3];
            // Each schema fixes one key type. Native equality supplies the oracle.
            let unique = match key_field {
                "id" => modified
                    .iter()
                    .map(|v| v["id"].as_str().unwrap())
                    .collect::<BTreeSet<_>>()
                    .len(),
                "amount" => modified
                    .iter()
                    .map(|v| v["amount"].as_str().unwrap().parse::<i64>().unwrap())
                    .collect::<BTreeSet<_>>()
                    .len(),
                _ => modified
                    .iter()
                    .map(|v| v["ok"].as_bool().unwrap())
                    .collect::<BTreeSet<_>>()
                    .len(),
            } == modified.len();
            c.verdict(unique);
            c.rule(json!({"op":"unique","collection":rows("deliverable"),"field":key_field}));
            c.contents(content(a, b, p, q, text, &modified));
            c.input = format!(
                "{}_keys_{}",
                if unique { "unique" } else { "duplicate" },
                key_field
            );
        }
        20..=22 => {
            let n = rng.small();
            let key = format!("target{}", rng.next() % 1000);
            let mut ledger = vec![row(&key, n, true), row("unrelated", 1, false)];
            let search = if family == 21 { "missing" } else { &key };
            if family == 22 {
                ledger.push(row(
                    if sample.is_multiple_of(2) {
                        &key
                    } else {
                        "unrelated"
                    },
                    2,
                    false,
                ));
            }
            c.plan["references"] = json!([schema()]);
            c.reference = vec![file(
                "data.json",
                serde_json::to_vec(&content(0, 0, false, false, "", &ledger)).unwrap(),
            )];
            let target = n + i64::from(sample.is_multiple_of(3));
            c.rule(binary(
                "eq",
                json!({"op":"lookup","collection":rows("reference"),
                "keyField":"id","key":string(search),"valueField":"amount"}),
                int(target),
            ));
            if family == 20 {
                c.verdict(n == target);
            } else {
                c.runtime_error("Rule");
            }
            c.input = if family == 22 && !sample.is_multiple_of(2) {
                "duplicate_unrelated_lookup_key"
            } else {
                FAMILIES[family]
            }
            .into();
        }
        23 => {
            // Count records below some other record. A wrong scope level makes
            // both sides refer to the same row and changes this result.
            let predicate = binary("lt", record("amount", 1), record("amount", 0));
            let expression = json!({"op":"count","collection":rows("deliverable"),"where":{
                "op":"any","collection":rows("deliverable"),"where":predicate}});
            let expected = amounts
                .iter()
                .filter(|&&outer| amounts.iter().any(|&inner| outer < inner))
                .count() as i64;
            let target = expected + i64::from(sample.is_multiple_of(3));
            c.rule(binary("eq", expression, int(target)));
            c.verdict(expected == target);
            c.input = if length == 0 {
                "nested_empty"
            } else {
                "nested_scope_levels"
            }
            .into();
        }
        24 | 25 => {
            let n = [0, 1, 2, 3, 31, 32, 255, 256, 1024][sample % 9];
            let bytes: Vec<u8> = (0..n).map(|_| rng.next() as u8).collect();
            let op = if family == 24 {
                "file_size"
            } else {
                "file_hash"
            };
            let expected = if family == 24 {
                int(n as i64 + i64::from(sample.is_multiple_of(3)))
            } else {
                let digest = format!("0x{}", hex::encode(Sha256::digest(&bytes)));
                string(&if sample.is_multiple_of(3) {
                    format!("{digest}0")
                } else {
                    digest
                })
            };
            c.opaque(bytes);
            c.rule(binary(
                "eq",
                json!({"op":op,"source":"deliverable","file":"blob.bin"}),
                expected,
            ));
            c.verdict(!sample.is_multiple_of(3));
            c.input = format!("opaque_bytes_{n}");
        }
        26 => {
            c.plan["deliverables"] = json!([{"name":"note.txt","parser":"text/v1"}]);
            c.delivery = vec![file("note.txt", text.as_bytes())];
            let expected = if sample.is_multiple_of(3) {
                format!("{text}\n")
            } else {
                text.into()
            };
            c.rule(binary(
                "eq",
                json!({"op":"field","source":"deliverable","file":"note.txt"}),
                string(&expected),
            ));
            c.verdict(text == expected);
            c.input = "text_exact_utf8".into();
        }
        27 => {
            c.plan["references"] = json!([schema()]);
            c.reference = vec![file(
                "data.json",
                serde_json::to_vec(&content(b, a, q, p, text, &records)).unwrap(),
            )];
            c.rule(binary("gte", fa(), field("reference", "a")));
            c.verdict(a >= b);
            c.input = "declared_reference_field".into();
        }
        28 => {
            let invalid = [
                json!("01"),
                json!("-0"),
                json!("+1"),
                json!(" 1"),
                json!("1 "),
                json!(""),
                json!("9223372036854775808"),
                json!("-9223372036854775809"),
                json!(1),
                json!(1.0),
                json!(true),
                Value::Null,
            ];
            let mut data = content(a, b, p, q, text, &records);
            data["a"] = invalid[sample % invalid.len()].clone();
            c.contents(data);
            c.rule(boolean(true));
            c.runtime_error("FileContents");
            c.input = format!("invalid_i64_{}", sample % invalid.len());
        }
        29 => {
            let valid = serde_json::to_string(&content(a, b, p, q, text, &records)).unwrap();
            c.delivery[0].contents = match sample % 7 {
                0 => valid.replacen('{', "{\"a\":\"0\",", 1).into_bytes(),
                1 => b"[]".to_vec(),
                2 => b"{".to_vec(),
                3 => {
                    let mut data = content(a, b, p, q, text, &records);
                    data.as_object_mut().unwrap().remove("p");
                    serde_json::to_vec(&data).unwrap()
                }
                4 => {
                    let mut data = content(a, b, p, q, text, &records);
                    data["p"] = json!("true");
                    serde_json::to_vec(&data).unwrap()
                }
                5 => {
                    let mut bytes = valid.into_bytes();
                    bytes.push(0xff);
                    bytes
                }
                _ => {
                    let mut bytes = valid.into_bytes();
                    bytes.extend_from_slice(b" false");
                    bytes
                }
            };
            c.runtime_error("FileContents");
            c.input = format!("invalid_json_{}", sample % 7);
        }
        30 => {
            let mut data = content(a, b, p, q, text, &records);
            data["rows"] = match sample % 6 {
                0 => Value::Null,
                1 => json!({}),
                2 => json!([null]),
                3 => json!([{"id":"a","amount":"1"}]),
                4 => json!([{"id":"a","amount":"01","ok":true}]),
                _ => json!(vec![row("x", 0, true); 257]),
            };
            c.contents(data);
            c.runtime_error("FileContents");
            c.input = format!("invalid_collection_{}", sample % 6);
        }
        31 => {
            match sample % 3 {
                0 => c.delivery.clear(),
                1 => c.delivery[0].name = "other.json".into(),
                _ => c.delivery.push(file("extra.bin", vec![])),
            };
            c.runtime_error("FileSet");
            c.input = format!("wrong_file_set_{}", sample % 3);
        }
        32 => {
            let hidden = binary("eq", binary("add", int(i64::MAX), int(1)), int(0));
            c.rule(binary(
                if sample.is_multiple_of(2) {
                    "or"
                } else {
                    "and"
                },
                boolean(sample.is_multiple_of(2)),
                hidden,
            ));
            c.runtime_error("Overflow");
            c.input = "overflow_in_boolean_right_operand".into();
        }
        33 => {
            // A final sum of MAX is insufficient. Every prefix must fit i64.
            let (values, overflow) = match sample % 4 {
                0 => (vec![i64::MAX, 1, -1], true),
                1 => (vec![i64::MIN, -1, 1], true),
                2 => (vec![i64::MAX, -1, 1], false),
                _ => (vec![i64::MIN, 1, -1], false),
            };
            let rr: Vec<_> = values
                .iter()
                .enumerate()
                .map(|(i, &v)| row(i.to_string(), v, true))
                .collect();
            c.contents(content(a, b, p, q, text, &rr));
            let total = values.iter().map(|&v| v as i128).sum::<i128>() as i64;
            c.rule(binary(
                "eq",
                json!({"op":"sum","collection":rows("deliverable"),"value":record("amount",0)}),
                int(total),
            ));
            if overflow {
                c.runtime_error("Overflow");
            }
            c.input = format!("prefix_sum_order_{}", sample % 4);
        }
        34 => {
            let n = if sample.is_multiple_of(2) {
                rng.small()
            } else {
                a
            };
            let decimal = if n < 0 {
                format!("-000{}", -(n as i128))
            } else {
                format!("000{n}")
            };
            c.rule(binary("eq", literal("i64", json!(decimal)), int(n)));
            c.input = "compiler_normalizes_leading_zero_literal".into();
        }
        35 => {
            let size = [16_383, 16_384, 16_385][sample % 3];
            // Header 3 + filename length 2 + name 8 + content length 4 = 17.
            c.opaque(vec![(rng.next() & 255) as u8; size - 17]);
            c.rule(binary(
                "eq",
                json!({"op":"file_size","source":"deliverable","file":"blob.bin"}),
                int((size - 17) as i64),
            ));
            if size > 16_384 {
                c.runtime_error("Wire(BundleSize)");
            }
            c.input = format!("delivery_bundle_bytes_{size}");
        }
        36 => {
            match sample % 10 {
                0 => c.rule(literal("i64", json!("9223372036854775808"))),
                1 => c.rule(binary("and", int(1), boolean(true))),
                2 => c.rule(record("amount", 0)),
                3 => c.plan["deliverables"][0]["name"] = json!("../data.json"),
                4 => c.plan["deliverables"]
                    .as_array_mut()
                    .unwrap()
                    .push(schema()),
                5 => c.rule(field("deliverable", "missing")),
                6 => c.rule(
                    json!({"op":"sum","collection":rows("deliverable"),"value":record("ok",0)}),
                ),
                7 => c.rule(literal("bool", json!("true"))),
                8 => c.rule(json!({"op":"unknown_operation"})),
                _ => {
                    c.plan["deliverables"] = json!((0..17)
                        .map(|i| json!({"name":format!("f{i}"),"parser":"opaque/v1"}))
                        .collect::<Vec<_>>())
                }
            }
            c.compiler_error(if sample % 10 == 8 {
                "unsupported_capability"
            } else {
                "invalid_plan"
            });
            c.input = format!("invalid_plan_{}", sample % 10);
        }
        37 => {
            c.rule(binary("eq", fa(), int(a)));
            c.parameter_mutation = Some(sample % 8);
            c.runtime_error("Parameters");
            c.input = format!("invalid_parameters_{}", sample % 8);
        }
        38 => {
            match sample % 4 {
                0 | 1 => {
                    let depth = if sample.is_multiple_of(4) { 32 } else { 33 };
                    // One field node plus depth-1 not nodes.
                    let mut expr = fp();
                    for _ in 1..depth {
                        expr = json!({"op":"not","value":expr});
                    }
                    c.rule(expr);
                    c.verdict(if depth % 2 == 0 { !p } else { p });
                    if depth == 33 {
                        c.compiler_error("invalid_plan");
                    }
                    c.input = format!("rule_depth_{depth}");
                }
                _ => {
                    let nodes = if sample % 4 == 2 { 256 } else { 257 };
                    c.plan["rules"] = json!(vec![fp(); nodes]);
                    c.verdict(p);
                    if nodes == 257 {
                        c.compiler_error("invalid_plan");
                    }
                    c.input = format!("rule_nodes_{nodes}");
                }
            }
        }
        39 => {
            let rr = if sample.is_multiple_of(2) {
                vec![row("a", 0, true), row("b", i64::MAX, false)]
            } else {
                vec![row("a", 0, false), row("b", i64::MAX, true)]
            };
            c.contents(content(a, b, p, q, text, &rr));
            let overflow = binary("eq", binary("add", record("amount", 0), int(1)), int(1));
            c.rule(json!({"op":if sample.is_multiple_of(2) {"any"} else {"all"},"collection":rows("deliverable"),"where":overflow}));
            c.runtime_error("Overflow");
            c.input = "overflow_after_decisive_quantifier_row".into();
        }
        _ => unreachable!(),
    }
    c
}

/// Independent wire construction lets the checker receive an oversized bundle.
/// The production encoder would reject that input before the checker sees it.
fn bundle(files: &[File]) -> Vec<u8> {
    let mut files: Vec<_> = files.iter().collect();
    files.sort_by(|a, b| a.name.cmp(&b.name));
    let mut out = vec![1];
    out.extend_from_slice(&(files.len() as u16).to_be_bytes());
    for file in files {
        out.extend_from_slice(&(file.name.len() as u16).to_be_bytes());
        out.extend_from_slice(file.name.as_bytes());
        out.extend_from_slice(&(file.contents.len() as u32).to_be_bytes());
        out.extend_from_slice(&file.contents);
    }
    out
}
fn mutation(index: usize, original: &Value) -> Vec<u8> {
    match index {
        0 => br#"[{"type":"i64","value":"01"}]"#.to_vec(),
        1 => br#"[{"type":"i64","value":"-0"}]"#.to_vec(),
        2 => br#"[{"type":"i64","value":1}]"#.to_vec(),
        3 => br#"[{"type":"i64","value":"9223372036854775808"}]"#.to_vec(),
        4 => br#"[{"type":"bool","value":true}]"#.to_vec(),
        5 => b"[]".to_vec(),
        6 => {
            let mut value = original.clone();
            value
                .as_array_mut()
                .unwrap()
                .push(json!({"type":"i64","value":"0"}));
            serde_json_canonicalizer::to_vec(&value).unwrap()
        }
        _ => br#"[{"type":"i64","type":"i64","value":"0"}]"#.to_vec(),
    }
}
fn outcome(
    result: Result<(ubc26_protocol::Journal, Vec<u8>), ubc26_guest_runtime::CheckError>,
) -> String {
    match result {
        Ok((j, _)) => if j.verdict == Verdict::Pass {
            "pass"
        } else {
            "fail"
        }
        .into(),
        Err(e) => format!("runtime:{e:?}"),
    }
}
fn operations(value: &Value, counts: &mut BTreeMap<String, usize>) {
    match value {
        Value::Object(map) => {
            if let Some(op) = map.get("op").and_then(Value::as_str) {
                *counts.entry(op.into()).or_default() += 1;
            }
            for value in map.values() {
                operations(value, counts);
            }
        }
        Value::Array(values) => {
            for value in values {
                operations(value, counts);
            }
        }
        _ => (),
    }
}

struct Run {
    actual: String,
    compiled: Option<Value>,
    parameters: Vec<u8>,
    delivery: Vec<u8>,
    reference: Vec<u8>,
}
fn execute(c: &Case) -> Run {
    let delivery = c
        .delivery_override
        .clone()
        .unwrap_or_else(|| bundle(&c.delivery));
    let reference = bundle(&c.reference);
    let mut run = Run {
        actual: String::new(),
        compiled: None,
        parameters: vec![],
        delivery,
        reference,
    };
    let validated = match validate_plan(&serde_json::to_vec(&c.plan).unwrap()) {
        Ok(plan) => serde_json::to_value(plan).unwrap(),
        Err(error) => {
            let error = serde_json::to_value(error).unwrap();
            run.actual = format!("compiler:{}", error["code"].as_str().unwrap());
            return run;
        }
    };
    let structure = validated["structureJcs"].as_str().unwrap().as_bytes();
    let parameters = match c.parameter_mutation {
        Some(i) => mutation(i, &validated["parameters"]),
        None => validated["parametersJcs"]
            .as_str()
            .unwrap()
            .as_bytes()
            .to_vec(),
    };
    let ctx = FundedContext {
        chain_id: [1; 32],
        escrow: [2; 20],
        job_id: [3; 32],
        provider: [4; 20],
        rules_hash: rules_hash(&structure_hash(structure), &parameters),
        reference_hash: reference_hash(&run.reference),
    };
    let interpreted = outcome(check(
        structure,
        &parameters,
        &run.reference,
        &run.delivery,
        &ctx,
        &[5; 32],
        &[6; 12],
    ));
    let expressions: Vec<Expression> =
        serde_json::from_value(validated["structure"]["rules"].clone()).unwrap();
    let generated = outcome(check_generated(
        structure,
        &parameters,
        &run.reference,
        &run.delivery,
        &[1, 0, 0],
        &ctx,
        &[5; 32],
        &[6; 12],
        expressions,
    ));
    run.actual = if interpreted == generated {
        interpreted
    } else {
        format!("path_disagreement:{interpreted}/{generated}")
    };
    run.parameters = parameters;
    run.compiled = Some(validated);
    run
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn failure_dir() -> PathBuf {
    std::env::var_os("UBC26_SEEDED_FAILURE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/seeded-failures"))
}
fn selected_fields(value: &Value, selected: &mut BTreeSet<(String, String, String)>) {
    match value {
        Value::Object(map) => {
            if let (Some(source), Some(file), Some(field)) = (
                map.get("source").and_then(Value::as_str),
                map.get("file").and_then(Value::as_str),
                map.get("field").and_then(Value::as_str),
            ) {
                selected.insert((source.into(), file.into(), field.into()));
            }
            for value in map.values() {
                selected_fields(value, selected);
            }
        }
        Value::Array(values) => {
            for value in values {
                selected_fields(value, selected);
            }
        }
        _ => (),
    }
}
fn prune_files(
    schema: &mut Value,
    files: &mut [File],
    source: &str,
    selected: &BTreeSet<(String, String, String)>,
) {
    for declaration in schema.as_array_mut().unwrap() {
        if declaration["parser"] != "json/v1" {
            continue;
        }
        let name = declaration["name"].as_str().unwrap().to_owned();
        let mut removed = BTreeSet::new();
        for group in ["fields", "collections"] {
            if let Some(items) = declaration[group].as_array_mut() {
                items.retain(|item| {
                    let field = item["name"].as_str().unwrap();
                    let keep = selected.contains(&(source.into(), name.clone(), field.into()));
                    if !keep {
                        removed.insert(field.to_owned());
                    }
                    keep
                });
            }
        }
        if let Some(file) = files.iter_mut().find(|file| file.name == name) {
            if let Ok(Value::Object(mut data)) = serde_json::from_slice(&file.contents) {
                for field in removed {
                    data.remove(&field);
                }
                file.contents = serde_json::to_vec(&data).unwrap();
            }
        }
    }
}

fn preserve(c: &Case, run: &Run) {
    let dir = failure_dir().join(format!("case-{:05}-{:016x}", c.id, c.seed));
    std::fs::create_dir_all(&dir).unwrap();
    write_json(&dir.join("plan.json"), &c.plan);
    write_json(
        &dir.join("failure.json"),
        &json!({"id":c.id,"seed":format!("0x{:016x}",c.seed),
        "family":c.family,"inputCategory":c.input,"expected":c.expected,"actual":run.actual,
        "replay":format!("UBC26_SEEDED_CASE={} cargo test -p ubc26-guest-runtime --test seeded -- --nocapture",c.id)}),
    );
    std::fs::write(dir.join("delivery.bundle"), &run.delivery).unwrap();
    std::fs::write(dir.join("reference.bundle"), &run.reference).unwrap();
    std::fs::write(dir.join("parameters.jcs"), &run.parameters).unwrap();
    if let Some(compiled) = &run.compiled {
        write_json(&dir.join("compiled.json"), compiled);
    }
    // Remove unused schema declarations and their input values. This preserves
    // the fixed oracle for otherwise valid inputs. Keep all limit-dependent
    // rules and collection rows. This reducer does not claim global minimality.
    if !matches!(
        c.expected.as_str(),
        "pass" | "fail" | "runtime:Overflow" | "runtime:Rule"
    ) {
        return;
    }
    let mut selected = BTreeSet::new();
    selected_fields(&c.plan["rules"], &mut selected);
    let mut reduced = Case {
        id: c.id,
        seed: c.seed,
        family: c.family,
        input: c.input.clone(),
        expected: c.expected.clone(),
        plan: c.plan.clone(),
        delivery: c.delivery.clone(),
        reference: c.reference.clone(),
        delivery_override: c.delivery_override.clone(),
        parameter_mutation: c.parameter_mutation,
    };
    prune_files(
        &mut reduced.plan["deliverables"],
        &mut reduced.delivery,
        "deliverable",
        &selected,
    );
    prune_files(
        &mut reduced.plan["references"],
        &mut reduced.reference,
        "reference",
        &selected,
    );
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute(&reduced)));
    if let Ok(reduced_run) = result {
        if reduced_run.actual == run.actual && reduced_run.actual != reduced.expected {
            write_json(&dir.join("reduced-plan.json"), &reduced.plan);
            std::fs::write(dir.join("reduced-delivery.bundle"), &reduced_run.delivery).unwrap();
            std::fs::write(dir.join("reduced-reference.bundle"), &reduced_run.reference).unwrap();
            if let Some(compiled) = reduced_run.compiled {
                write_json(&dir.join("reduced-compiled.json"), &compiled);
            }
        }
    }
}

#[test]
fn ten_thousand_seeded_cases_match_independent_oracles() {
    let selected = std::env::var("UBC26_SEEDED_CASE")
        .ok()
        .map(|s| s.parse::<usize>().expect("case ID must be an integer"));
    if let Some(id) = selected {
        assert!(id < CASES, "case ID must be below {CASES}");
    }
    let ids: Vec<_> = selected.map_or_else(|| (0..CASES).collect(), |id| vec![id]);
    let mut families = BTreeMap::<String, usize>::new();
    let mut inputs = BTreeMap::<String, usize>::new();
    let mut expected = BTreeMap::<String, usize>::new();
    let mut actual = BTreeMap::<String, usize>::new();
    let mut ops = BTreeMap::<String, usize>::new();
    let mut failures = Vec::new();
    for id in &ids {
        let case = generated_case(*id);
        *families.entry(case.family.into()).or_default() += 1;
        *inputs.entry(case.input.clone()).or_default() += 1;
        *expected.entry(case.expected.clone()).or_default() += 1;
        operations(&case.plan["rules"], &mut ops);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute(&case)));
        let run = match result {
            Ok(run) => run,
            Err(_) => Run {
                actual: "panic".into(),
                compiled: None,
                parameters: vec![],
                delivery: bundle(&case.delivery),
                reference: bundle(&case.reference),
            },
        };
        *actual.entry(run.actual.clone()).or_default() += 1;
        if let Some(compiled) = &run.compiled {
            let mut lowered = BTreeMap::new();
            operations(&compiled["structure"]["rules"], &mut lowered);
            if let Some(count) = lowered.get("parameter") {
                *ops.entry("parameter".into()).or_default() += count;
            }
        }
        if run.actual != case.expected {
            preserve(&case, &run);
            failures.push(
                json!({"id":id,"seed":format!("0x{:016x}",case.seed),"family":case.family,
                "inputCategory":case.input,"expected":case.expected,"actual":run.actual}),
            );
        }
    }
    let report = json!({"corpusVersion":1,"baseSeed":format!("0x{BASE_SEED:016x}"),"cases":ids.len(),
        "families":families,"inputCategories":inputs,"expectedOutcomes":expected,"actualOutcomes":actual,
        "operationOccurrences":ops,"failures":failures,
        "oracle":"Case-specific host formulas. i128 arithmetic with i64 range checks. No engine evaluation supplies expected outcomes.",
        "limits":"10,000 generated cases do not establish universal correctness. Native tests do not establish zkVM proof correctness."});
    if let Some(path) = std::env::var_os("UBC26_SEEDED_REPORT") {
        write_json(Path::new(&path), &report);
    }
    println!("UBC26_SEEDED_COVERAGE={report}");
    if selected.is_none() {
        assert_eq!(families.len(), 40);
        assert!(families.values().all(|&count| count == 250));
        for op in [
            "field",
            "parameter",
            "file_hash",
            "file_size",
            "record_field",
            "count",
            "sum",
            "all",
            "any",
            "unique",
            "lookup",
            "not",
            "add",
            "sub",
            "mul",
            "lt",
            "lte",
            "gt",
            "gte",
            "eq",
            "ne",
            "and",
            "or",
        ] {
            assert!(ops.contains_key(op), "operation {op} lacks coverage");
        }
    }
    assert!(
        failures.is_empty(),
        "{} oracle mismatches. Failure files: {}. Details: {}",
        failures.len(),
        failure_dir().display(),
        json!(failures)
    );
}
