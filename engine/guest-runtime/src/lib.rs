mod records;

use std::collections::BTreeSet;

use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use ubc26_protocol::{
    check_filename, decode_bundle, encrypt_delivery, key_commitment, reference_hash, rules_hash,
    sha256, strict_json, structure_hash, BundleKind, FundedContext, Journal, Key, Verdict,
    WireError,
};

const MAX_PLAN_BYTES: usize = 256 * 1024;
const MAX_ITEMS: usize = 256;
const MAX_DEPTH: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub enum CheckError {
    RulesHash,
    ReferenceHash,
    Structure,
    Parameters,
    FileSet,
    FileContents,
    Rule,
    Overflow,
    Wire(WireError),
}

impl std::fmt::Display for CheckError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::RulesHash => "Rules hash differs from the funded context",
            Self::ReferenceHash => "Reference hash differs from the funded context",
            Self::Structure => "Invalid rule structure",
            Self::Parameters => "Invalid rule parameters",
            Self::FileSet => "Bundle files differ from the declared files",
            Self::FileContents => "File contents do not match the declared schema",
            Self::Rule => "Invalid rule expression",
            Self::Overflow => "Rule arithmetic exceeds the i64 range",
            Self::Wire(error) => return error.fmt(formatter),
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for CheckError {}

impl From<WireError> for CheckError {
    fn from(error: WireError) -> Self {
        Self::Wire(error)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Structure {
    version: u8,
    deliverables: Vec<File>,
    references: Vec<File>,
    evidence: Vec<Value>,
    rules: Vec<Expression>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    name: String,
    parser: Parser,
    fields: Vec<Field>,
    #[serde(default)]
    collections: Vec<Collection>,
}

#[derive(Deserialize)]
enum Parser {
    #[serde(rename = "json/v1")]
    Json,
    #[serde(rename = "text/v1")]
    Text,
    #[serde(rename = "opaque/v1")]
    Opaque,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Field {
    name: String,
    #[serde(rename = "type")]
    kind: Kind,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Collection {
    name: String,
    fields: Vec<Field>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Bool,
    I64,
    String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Scalar {
    Bool(bool),
    I64(i64),
    String(String),
}

impl Scalar {
    fn from_json(kind: Kind, value: Value) -> Option<Self> {
        match (kind, value) {
            (Kind::Bool, Value::Bool(value)) => Some(Self::Bool(value)),
            (Kind::I64, Value::String(decimal)) => {
                let value = decimal.parse::<i64>().ok()?;
                (decimal == value.to_string()).then_some(Self::I64(value))
            }
            (Kind::String, Value::String(value)) => Some(Self::String(value)),
            _ => None,
        }
    }

    fn kind(&self) -> Kind {
        match self {
            Self::Bool(_) => Kind::Bool,
            Self::I64(_) => Kind::I64,
            Self::String(_) => Kind::String,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Parameter {
    #[serde(rename = "type")]
    kind: Kind,
    value: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Source {
    Deliverable,
    Reference,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
enum Expression {
    Field {
        source: Source,
        file: usize,
        // A text file has no field index. Explicit null is not an index.
        #[serde(default, deserialize_with = "field_index")]
        field: Option<usize>,
    },
    #[serde(rename = "record_field")]
    RecordField {
        field: usize,
        level: usize,
    },
    Count {
        collection: records::Access,
        #[serde(rename = "where", default)]
        predicate: Option<Box<Expression>>,
    },
    Sum {
        collection: records::Access,
        value: Box<Expression>,
    },
    All {
        collection: records::Access,
        #[serde(rename = "where")]
        predicate: Box<Expression>,
    },
    Any {
        collection: records::Access,
        #[serde(rename = "where")]
        predicate: Box<Expression>,
    },
    Unique {
        collection: records::Access,
        field: usize,
    },
    Lookup {
        collection: records::Access,
        #[serde(rename = "keyField")]
        key_field: usize,
        key: Box<Expression>,
        #[serde(rename = "valueField")]
        value_field: usize,
    },
    Parameter {
        slot: usize,
        #[serde(rename = "type")]
        kind: Kind,
    },
    Not {
        value: Box<Expression>,
    },
    Add(Binary),
    Sub(Binary),
    Mul(Binary),
    Lt(Binary),
    Lte(Binary),
    Gt(Binary),
    Gte(Binary),
    Eq(Binary),
    Ne(Binary),
    And(Binary),
    Or(Binary),
}

fn field_index<'de, D: serde::Deserializer<'de>>(input: D) -> Result<Option<usize>, D::Error> {
    usize::deserialize(input).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binary {
    left: Box<Expression>,
    right: Box<Expression>,
}

enum ParsedFile {
    Json(Vec<Scalar>, Vec<Vec<Vec<Scalar>>>),
    Text(Scalar),
    Opaque,
}

/// Checks the committed rules against both bundles and encrypts the exact delivery bytes.
pub fn check(
    structure_jcs: &[u8],
    parameters_jcs: &[u8],
    reference: &[u8],
    delivery: &[u8],
    context: &FundedContext,
    key: &Key,
    nonce: &[u8; 12],
) -> Result<(Journal, Vec<u8>), CheckError> {
    let structure = decode_structure(structure_jcs)?;
    let parameters: Vec<Parameter> =
        canonical_decode(parameters_jcs).ok_or(CheckError::Parameters)?;
    if rules_hash(&structure_hash(structure_jcs), parameters_jcs) != context.rules_hash {
        return Err(CheckError::RulesHash);
    }
    if reference_hash(reference) != context.reference_hash {
        return Err(CheckError::ReferenceHash);
    }
    if parameters.len() > MAX_ITEMS {
        return Err(CheckError::Parameters);
    }
    let parameters = parameters
        .into_iter()
        .map(|parameter| Scalar::from_json(parameter.kind, parameter.value))
        .collect::<Option<Vec<_>>>()
        .ok_or(CheckError::Parameters)?;
    records::inspect_rules(&structure.rules, &parameters)?;
    let deliverables = parse_files(&structure.deliverables, BundleKind::Delivery, delivery)?;
    let references = parse_files(&structure.references, BundleKind::Reference, reference)?;
    let mut evaluator = Evaluator {
        deliverables: &deliverables,
        references: &references,
        parameters: &parameters,
        scopes: Vec::new(),
        nodes: 0,
    };
    let mut passed = true;
    for rule in &structure.rules {
        let result = evaluator.evaluate(rule, 1)?;
        let Scalar::Bool(result) = result.as_scalar() else {
            return Err(CheckError::Rule);
        };
        passed &= *result;
    }

    let envelope = encrypt_delivery(context, key, nonce, delivery)?;
    let journal = Journal {
        context: *context,
        verdict: if passed { Verdict::Pass } else { Verdict::Fail },
        envelope_hash: sha256(&envelope),
        key_commitment: key_commitment(context, key),
    };
    Ok((journal, envelope))
}

/// Checks that the reference bundle matches the declared files and schemas.
pub fn validate_reference(structure_jcs: &[u8], reference: &[u8]) -> Result<(), CheckError> {
    let structure = decode_structure(structure_jcs)?;
    parse_files(&structure.references, BundleKind::Reference, reference)?;
    Ok(())
}

fn decode_structure(bytes: &[u8]) -> Result<Structure, CheckError> {
    let structure: Structure = canonical_decode(bytes).ok_or(CheckError::Structure)?;
    if structure.version != 1
        || structure.deliverables.is_empty()
        || !structure.evidence.is_empty()
        || !(1..=MAX_ITEMS).contains(&structure.rules.len())
    {
        return Err(CheckError::Structure);
    }
    Ok(structure)
}

fn canonical_decode<T: DeserializeOwned>(bytes: &[u8]) -> Option<T> {
    if bytes.len() > MAX_PLAN_BYTES {
        return None;
    }
    let value = strict_json::from_slice(bytes).ok()?;
    if serde_json_canonicalizer::to_vec(&value).ok()? != bytes {
        return None;
    }
    serde_json::from_value(value).ok()
}

fn parse_files(
    schema: &[File],
    kind: BundleKind,
    bundle: &[u8],
) -> Result<Vec<ParsedFile>, CheckError> {
    let records = decode_bundle(kind, bundle)?;
    if schema.len() != records.len() {
        return Err(CheckError::FileSet);
    }
    let mut names = BTreeSet::new();
    schema
        .iter()
        .map(|file| {
            check_filename(&file.name)?;
            if !names.insert(&file.name) {
                return Err(CheckError::Structure);
            }
            let index = records
                .binary_search_by_key(&file.name.as_str(), |record| record.name)
                .map_err(|_| CheckError::FileSet)?;
            parse_file(file, records[index].contents)
        })
        .collect()
}

fn parse_file(file: &File, contents: &[u8]) -> Result<ParsedFile, CheckError> {
    match file.parser {
        Parser::Json => {
            records::validate_schema(file)?;
            if file.fields.len() > MAX_ITEMS {
                return Err(CheckError::Structure);
            }
            let value = strict_json::from_slice(contents).map_err(|_| CheckError::FileContents)?;
            check_json_limits(&value, 1)?;
            let Value::Object(mut object) = value else {
                return Err(CheckError::FileContents);
            };
            let mut names = BTreeSet::new();
            let fields = file
                .fields
                .iter()
                .map(|field| {
                    if field.name.is_empty() || !names.insert(&field.name) {
                        return Err(CheckError::Structure);
                    }
                    object
                        .remove(&field.name)
                        .and_then(|value| Scalar::from_json(field.kind, value))
                        .ok_or(CheckError::FileContents)
                })
                .collect::<Result<_, _>>()?;
            let collections = records::parse_collections(&file.collections, &mut object)?;
            Ok(ParsedFile::Json(fields, collections))
        }
        Parser::Text | Parser::Opaque
            if !file.fields.is_empty() || !file.collections.is_empty() =>
        {
            Err(CheckError::Structure)
        }
        Parser::Text => {
            let text = std::str::from_utf8(contents).map_err(|_| CheckError::FileContents)?;
            Ok(ParsedFile::Text(Scalar::String(text.to_owned())))
        }
        Parser::Opaque => Ok(ParsedFile::Opaque),
    }
}

fn check_json_limits(value: &Value, depth: usize) -> Result<(), CheckError> {
    if depth > MAX_DEPTH {
        return Err(CheckError::FileContents);
    }
    match value {
        Value::Object(object) => object
            .values()
            .try_for_each(|value| check_json_limits(value, depth + 1)),
        Value::Array(items) if items.len() <= MAX_ITEMS => items
            .iter()
            .try_for_each(|value| check_json_limits(value, depth + 1)),
        Value::Array(_) => Err(CheckError::FileContents),
        _ => Ok(()),
    }
}

struct Evaluator<'a> {
    deliverables: &'a [ParsedFile],
    references: &'a [ParsedFile],
    parameters: &'a [Scalar],
    scopes: Vec<&'a [Scalar]>,
    nodes: usize,
}

enum Evaluated<'a> {
    Borrowed(&'a Scalar),
    Owned(Scalar),
}

impl Evaluated<'_> {
    fn as_scalar(&self) -> &Scalar {
        match self {
            Self::Borrowed(value) => value,
            Self::Owned(value) => value,
        }
    }
}

impl<'a> Evaluator<'a> {
    fn evaluate(
        &mut self,
        expression: &Expression,
        depth: usize,
    ) -> Result<Evaluated<'a>, CheckError> {
        self.nodes += 1;
        if self.nodes > 1_000_000 || depth > MAX_DEPTH {
            return Err(CheckError::Rule);
        }
        use Expression::*;
        let value = match expression {
            Field {
                source,
                file,
                field,
            } => {
                let files = match source {
                    Source::Deliverable => self.deliverables,
                    Source::Reference => self.references,
                };
                let value = match (files.get(*file), field) {
                    (Some(ParsedFile::Json(fields, _)), Some(index)) => fields.get(*index),
                    (Some(ParsedFile::Text(text)), None) => Some(text),
                    _ => None,
                };
                return value.map(Evaluated::Borrowed).ok_or(CheckError::Rule);
            }
            Parameter { slot, kind } => {
                let value = self.parameters.get(*slot).ok_or(CheckError::Parameters)?;
                if value.kind() != *kind {
                    return Err(CheckError::Parameters);
                }
                return Ok(Evaluated::Borrowed(value));
            }
            RecordField { .. }
            | Count { .. }
            | Sum { .. }
            | All { .. }
            | Any { .. }
            | Unique { .. }
            | Lookup { .. } => {
                return self.evaluate_records(expression, depth);
            }
            Not { value } => {
                let value = self.evaluate(value, depth + 1)?;
                let Scalar::Bool(value) = value.as_scalar() else {
                    return Err(CheckError::Rule);
                };
                Scalar::Bool(!value)
            }
            Add(binary) | Sub(binary) | Mul(binary) | Lt(binary) | Lte(binary) | Gt(binary)
            | Gte(binary) | Eq(binary) | Ne(binary) | And(binary) | Or(binary) => {
                // Evaluate both operands so a Boolean result cannot hide malformed inputs.
                let left = self.evaluate(&binary.left, depth + 1)?;
                let right = self.evaluate(&binary.right, depth + 1)?;
                apply_binary(expression, left.as_scalar(), right.as_scalar())?
            }
        };
        Ok(Evaluated::Owned(value))
    }
}

fn apply_binary(
    expression: &Expression,
    left: &Scalar,
    right: &Scalar,
) -> Result<Scalar, CheckError> {
    use Expression::*;
    let result = match (expression, left, right) {
        (Eq(_), left, right) if left.kind() == right.kind() => Scalar::Bool(left == right),
        (Ne(_), left, right) if left.kind() == right.kind() => Scalar::Bool(left != right),
        (And(_), Scalar::Bool(left), Scalar::Bool(right)) => Scalar::Bool(*left && *right),
        (Or(_), Scalar::Bool(left), Scalar::Bool(right)) => Scalar::Bool(*left || *right),
        (Lt(_), Scalar::I64(left), Scalar::I64(right)) => Scalar::Bool(left < right),
        (Lte(_), Scalar::I64(left), Scalar::I64(right)) => Scalar::Bool(left <= right),
        (Gt(_), Scalar::I64(left), Scalar::I64(right)) => Scalar::Bool(left > right),
        (Gte(_), Scalar::I64(left), Scalar::I64(right)) => Scalar::Bool(left >= right),
        (Add(_), Scalar::I64(left), Scalar::I64(right)) => {
            Scalar::I64(left.checked_add(*right).ok_or(CheckError::Overflow)?)
        }
        (Sub(_), Scalar::I64(left), Scalar::I64(right)) => {
            Scalar::I64(left.checked_sub(*right).ok_or(CheckError::Overflow)?)
        }
        (Mul(_), Scalar::I64(left), Scalar::I64(right)) => {
            Scalar::I64(left.checked_mul(*right).ok_or(CheckError::Overflow)?)
        }
        _ => return Err(CheckError::Rule),
    };
    Ok(result)
}
