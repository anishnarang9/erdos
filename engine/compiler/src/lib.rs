mod emitter;
mod evidence;
pub use emitter::emit_rules;
mod records;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ubc26_protocol::{check_filename, rules_hash, structure_hash, MAX_FILES};

use ubc26_protocol::strict_json;

pub const MAX_PLAN_BYTES: usize = 256 * 1024;
const MAX_FIELDS: usize = 256;
const MAX_RULE_NODES: usize = 256;
const MAX_RULE_DEPTH: usize = 32;

#[derive(Debug, Serialize)]
pub struct PlanError {
    code: &'static str,
    path: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    request: Option<CapabilityRequest>,
}

#[derive(Debug, Serialize)]
struct CapabilityRequest {
    kind: &'static str,
    name: String,
}

impl PlanError {
    fn invalid(path: &str, message: impl Into<String>) -> Self {
        Self {
            code: "invalid_plan",
            path: path.into(),
            message: message.into(),
            request: None,
        }
    }

    fn unsupported(path: &str, kind: &'static str, name: &str) -> Self {
        Self {
            code: "unsupported_capability",
            path: path.into(),
            message: format!("Unsupported {kind} {name:?}"),
            request: Some(CapabilityRequest {
                kind,
                name: name.into(),
            }),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    version: u8,
    deliverables: Vec<File>,
    references: Vec<File>,
    rules: Vec<Value>,
    #[serde(default)]
    evidence: Vec<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct File {
    name: String,
    parser: String,
    #[serde(default)]
    fields: Vec<Field>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    collections: Vec<Collection>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Field {
    name: String,
    #[serde(rename = "type")]
    kind: Kind,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Collection {
    name: String,
    fields: Vec<Field>,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Bool,
    I64,
    String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Source {
    Deliverable,
    Reference,
    Evidence,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileAccess {
    source: Source,
    file: String,
    field: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Literal {
    #[serde(rename = "type")]
    kind: Kind,
    value: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binary {
    left: Value,
    right: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Unary {
    value: Value,
}

fn decode<T: serde::de::DeserializeOwned>(value: Value, path: &str) -> Result<T, PlanError> {
    serde_path_to_error::deserialize(value).map_err(|error| {
        let mut pointer = path.to_owned();
        for segment in error.path() {
            use serde_path_to_error::Segment;
            let text = match segment {
                Segment::Seq { index } => index.to_string(),
                Segment::Map { key } => key.replace('~', "~0").replace('/', "~1"),
                Segment::Enum { variant } => variant.clone(),
                Segment::Unknown => continue,
            };
            pointer.push('/');
            pointer.push_str(&text);
        }
        PlanError::invalid(&pointer, error.inner().to_string())
    })
}

fn validate_files(files: &[File], path: &str) -> Result<(), PlanError> {
    if files.len() > MAX_FILES {
        return Err(PlanError::invalid(path, "At most 16 files are allowed"));
    }

    let mut names = BTreeSet::new();
    for (index, file) in files.iter().enumerate() {
        let path = format!("{path}/{index}");
        let name = &file.name;
        if check_filename(name).is_err() || !names.insert(name) {
            return Err(PlanError::invalid(
                &format!("{path}/name"),
                "Expected a unique flat ASCII file name",
            ));
        }
        match file.parser.as_str() {
            "json/v1" => (),
            "text/v1" | "opaque/v1" if file.fields.is_empty() && file.collections.is_empty() => (),
            "text/v1" | "opaque/v1" => {
                return Err(PlanError::invalid(
                    &format!("{path}/fields"),
                    "Only json/v1 accepts field declarations",
                ));
            }
            name => {
                return Err(PlanError::unsupported(
                    &format!("{path}/parser"),
                    "parser",
                    name,
                ))
            }
        }

        records::validate_collections(file, &path)?;
        if file.fields.len() > MAX_FIELDS {
            return Err(PlanError::invalid(
                &format!("{path}/fields"),
                "At most 256 field declarations are allowed",
            ));
        }
        let mut fields = BTreeSet::new();
        for (index, field) in file.fields.iter().enumerate() {
            if field.name.is_empty() || !fields.insert(&field.name) {
                return Err(PlanError::invalid(
                    &format!("{path}/fields/{index}/name"),
                    "Expected a unique nonempty field name",
                ));
            }
        }
    }
    Ok(())
}

struct Lowerer<'a> {
    plan: &'a Plan,
    evidence_files: &'a [File],
    parameters: Vec<Value>,
    nodes: usize,
    scopes: Vec<&'a [Field]>,
}

impl<'a> Lowerer<'a> {
    fn expression(
        &mut self,
        input: Value,
        path: &str,
        depth: usize,
    ) -> Result<(Kind, Value), PlanError> {
        self.nodes += 1;
        if depth > MAX_RULE_DEPTH || self.nodes > MAX_RULE_NODES {
            return Err(PlanError::invalid(
                path,
                "Rules exceed the depth or node limit",
            ));
        }

        let Value::Object(mut fields) = input else {
            return Err(PlanError::invalid(path, "Expected a rule object"));
        };
        let Some(Value::String(op)) = fields.remove("op") else {
            return Err(PlanError::invalid(
                &format!("{path}/op"),
                "Expected an operation name",
            ));
        };
        let operands = Value::Object(fields);
        match op.as_str() {
            "field" => self.field(decode(operands, path)?, path),
            "literal" => self.literal(decode(operands, path)?, path),
            "record_field" | "count" | "sum" | "all" | "any" | "unique" | "lookup" => {
                self.record_expression(&op, operands, path, depth)
            }
            "not" => {
                let input: Unary = decode(operands, path)?;
                let (kind, value) =
                    self.expression(input.value, &format!("{path}/value"), depth + 1)?;
                if kind != Kind::Bool {
                    return Err(PlanError::invalid(path, "Expected a Boolean operand"));
                }
                Ok((Kind::Bool, json!({"op": op, "value": value})))
            }
            "add" | "sub" | "mul" | "lt" | "lte" | "gt" | "gte" | "eq" | "ne" | "and" | "or" => {
                let input: Binary = decode(operands, path)?;
                let (left_kind, left) =
                    self.expression(input.left, &format!("{path}/left"), depth + 1)?;
                let (right_kind, right) =
                    self.expression(input.right, &format!("{path}/right"), depth + 1)?;
                let expected = match op.as_str() {
                    "eq" | "ne" => left_kind,
                    "and" | "or" => Kind::Bool,
                    _ => Kind::I64,
                };
                if left_kind != expected || right_kind != expected {
                    return Err(PlanError::invalid(
                        path,
                        "Operand types do not match the operation",
                    ));
                }
                let result = match op.as_str() {
                    "add" | "sub" | "mul" => Kind::I64,
                    _ => Kind::Bool,
                };
                Ok((result, json!({"op": op, "left": left, "right": right})))
            }
            _ => Err(PlanError::unsupported(
                &format!("{path}/op"),
                "operation",
                &op,
            )),
        }
    }

    fn field(&self, access: FileAccess, path: &str) -> Result<(Kind, Value), PlanError> {
        let (source, files): (&str, &[File]) = match access.source {
            Source::Deliverable => ("deliverable", &self.plan.deliverables),
            Source::Reference => ("reference", &self.plan.references),
            Source::Evidence => ("evidence", self.evidence_files),
        };
        let (file_index, file) = files
            .iter()
            .enumerate()
            .find(|(_, file)| file.name == access.file)
            .ok_or_else(|| PlanError::invalid(path, "The rule refers to an undeclared file"))?;
        if file.parser == "text/v1" && access.field.is_none() {
            return Ok((
                Kind::String,
                json!({"op": "field", "source": source, "file": file_index}),
            ));
        }
        if file.parser == "json/v1" {
            if let Some((index, field)) = file
                .fields
                .iter()
                .enumerate()
                .find(|(_, field)| Some(field.name.as_str()) == access.field.as_deref())
            {
                return Ok((
                    field.kind,
                    json!({"op": "field", "source": source, "file": file_index, "field": index}),
                ));
            }
        }
        Err(PlanError::invalid(
            path,
            "The rule must refer to a declared JSON field or the full text file",
        ))
    }

    fn literal(&mut self, literal: Literal, path: &str) -> Result<(Kind, Value), PlanError> {
        let value = match (literal.kind, literal.value) {
            (Kind::I64, Value::String(number)) => {
                let digits = number.strip_prefix('-').unwrap_or(&number);
                if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(PlanError::invalid(
                        &format!("{path}/value"),
                        "Expected an i64 decimal string",
                    ));
                }
                let value = number.parse::<i64>().map_err(|_| {
                    PlanError::invalid(&format!("{path}/value"), "Value exceeds i64 range")
                })?;
                Value::String(value.to_string())
            }
            (Kind::String, value @ Value::String(_)) | (Kind::Bool, value @ Value::Bool(_)) => {
                value
            }
            _ => {
                return Err(PlanError::invalid(
                    &format!("{path}/value"),
                    "The literal value does not match its declared type",
                ))
            }
        };
        let slot = self.parameters.len();
        self.parameters
            .push(json!({"type": literal.kind, "value": value}));
        Ok((
            literal.kind,
            json!({"op": "parameter", "slot": slot, "type": literal.kind}),
        ))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedPlan {
    structure: Value,
    parameters: Vec<Value>,
    structure_jcs: String,
    parameters_jcs: String,
    structure_hash: String,
    rules_hash: String,
}

pub fn validate_plan(bytes: &[u8]) -> Result<ValidatedPlan, PlanError> {
    if bytes.len() > MAX_PLAN_BYTES {
        return Err(PlanError::invalid("", "The plan exceeds 256 KiB"));
    }
    let input = strict_json::from_slice(bytes)
        .map_err(|error| PlanError::invalid("", error.to_string()))?;
    let mut plan: Plan = decode(input, "")?;
    if plan.version != 1 {
        return Err(PlanError::invalid("/version", "Expected version 1"));
    }
    if plan.deliverables.is_empty() {
        return Err(PlanError::invalid(
            "/deliverables",
            "Declare at least one delivery file",
        ));
    }
    validate_files(&plan.deliverables, "/deliverables")?;
    validate_files(&plan.references, "/references")?;
    let (evidence_files, evidence, evidence_parameters) =
        evidence::prepare(&plan.evidence, &plan.deliverables)?;
    if plan.rules.is_empty() || plan.rules.len() > MAX_RULE_NODES {
        return Err(PlanError::invalid("/rules", "Expected 1 to 256 rules"));
    }

    let input_rules = std::mem::take(&mut plan.rules);
    let mut lowerer = Lowerer {
        plan: &plan,
        evidence_files: &evidence_files,
        parameters: evidence_parameters,
        nodes: 0,
        scopes: Vec::new(),
    };
    let mut rules = Vec::with_capacity(input_rules.len());
    for (index, rule) in input_rules.into_iter().enumerate() {
        let path = format!("/rules/{index}");
        let (kind, rule) = lowerer.expression(rule, &path, 1)?;
        if kind != Kind::Bool {
            return Err(PlanError::invalid(
                &path,
                "A top-level rule must be Boolean",
            ));
        }
        rules.push(rule);
    }
    if lowerer.parameters.len() > MAX_RULE_NODES {
        return Err(PlanError::invalid(
            "/rules",
            "Rules and signers exceed 256 parameter slots",
        ));
    }
    let structure = json!({
        "version": 1,
        "deliverables": plan.deliverables,
        "references": plan.references,
        "evidence": evidence,
        "rules": rules
    });
    let parameters = lowerer.parameters;
    let structure_jcs = serde_json_canonicalizer::to_string(&structure)
        .map_err(|error| PlanError::invalid("", error.to_string()))?;
    let parameters_jcs = serde_json_canonicalizer::to_string(&parameters)
        .map_err(|error| PlanError::invalid("", error.to_string()))?;

    let structure_hash = structure_hash(structure_jcs.as_bytes());
    let rules_hash = rules_hash(&structure_hash, parameters_jcs.as_bytes());

    Ok(ValidatedPlan {
        structure,
        parameters,
        structure_jcs,
        parameters_jcs,
        structure_hash: format!("0x{}", hex::encode(structure_hash)),
        rules_hash: format!("0x{}", hex::encode(rules_hash)),
    })
}
