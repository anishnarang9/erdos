use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Access {
    source: Source,
    file: String,
    field: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordField {
    field: String,
    #[serde(default)]
    level: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Aggregate {
    collection: Access,
    #[serde(rename = "where", default)]
    predicate: Option<Value>,
    #[serde(default)]
    value: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Unique {
    collection: Access,
    field: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lookup {
    collection: Access,
    key_field: String,
    key: Value,
    value_field: String,
}

pub(super) fn validate_collections(file: &File, path: &str) -> Result<(), PlanError> {
    let mut names: BTreeSet<_> = file.fields.iter().map(|field| &field.name).collect();
    if file.fields.len() + file.collections.len() > MAX_FIELDS {
        return Err(PlanError::invalid(
            path,
            "At most 256 fields and collections are allowed",
        ));
    }
    for (index, collection) in file.collections.iter().enumerate() {
        let path = format!("{path}/collections/{index}");
        if collection.name.is_empty()
            || !names.insert(&collection.name)
            || collection.fields.is_empty()
            || collection.fields.len() > MAX_FIELDS
        {
            return Err(PlanError::invalid(
                &path,
                "Expected a unique collection name and 1 to 256 fields",
            ));
        }
        let mut fields = BTreeSet::new();
        for field in &collection.fields {
            if field.name.is_empty() || !fields.insert(&field.name) {
                return Err(PlanError::invalid(
                    &path,
                    "Expected unique nonempty record field names",
                ));
            }
        }
    }
    Ok(())
}

impl<'a> Lowerer<'a> {
    fn collection(&self, access: Access, path: &str) -> Result<(&'a Collection, Value), PlanError> {
        let (source, files): (&str, &[File]) = match access.source {
            Source::Deliverable => ("deliverable", &self.plan.deliverables),
            Source::Reference => ("reference", &self.plan.references),
            Source::Evidence => ("evidence", self.evidence_files),
        };
        let (file_index, file) = files
            .iter()
            .enumerate()
            .find(|(_, file)| file.name == access.file)
            .ok_or_else(|| PlanError::invalid(path, "Undeclared collection file"))?;
        let (index, collection) = file
            .collections
            .iter()
            .enumerate()
            .find(|(_, field)| field.name == access.field)
            .ok_or_else(|| PlanError::invalid(path, "Undeclared record collection"))?;
        Ok((
            collection,
            json!({"source":source,"file":file_index,"field":index}),
        ))
    }

    pub(super) fn record_expression(
        &mut self,
        op: &str,
        operands: Value,
        path: &str,
        depth: usize,
    ) -> Result<(Kind, Value), PlanError> {
        match op {
            "record_field" => {
                let input: RecordField = decode(operands, path)?;
                let fields = self.scopes.iter().rev().nth(input.level).ok_or_else(|| {
                    PlanError::invalid(path, "Record field is outside its collection scope")
                })?;
                let (index, field) = named_field(fields, &input.field, path)?;
                Ok((
                    field.kind,
                    json!({"op":op,"field":index,"level":input.level}),
                ))
            }
            "unique" => {
                let input: Unique = decode(operands, path)?;
                let (schema, collection) = self.collection(input.collection, path)?;
                let (field, _) = named_field(&schema.fields, &input.field, path)?;
                Ok((
                    Kind::Bool,
                    json!({"op":op,"collection":collection,"field":field}),
                ))
            }
            "lookup" => {
                let input: Lookup = decode(operands, path)?;
                let (schema, collection) = self.collection(input.collection, path)?;
                let (key_field, key_schema) = named_field(&schema.fields, &input.key_field, path)?;
                let (value_field, value_schema) =
                    named_field(&schema.fields, &input.value_field, path)?;
                let (kind, key) = self.expression(input.key, &format!("{path}/key"), depth + 1)?;
                if kind != key_schema.kind {
                    return Err(PlanError::invalid(path, "Lookup key types differ"));
                }
                Ok((
                    value_schema.kind,
                    json!({"op":op,"collection":collection,"keyField":key_field,"key":key,"valueField":value_field}),
                ))
            }
            _ => {
                let input: Aggregate = decode(operands, path)?;
                let body = match (op, input.value, input.predicate) {
                    ("count", None, None) => None,
                    ("count" | "all" | "any", None, Some(value)) => {
                        Some(("where", value, Kind::Bool))
                    }
                    ("sum", Some(value), None) => Some(("value", value, Kind::I64)),
                    _ => {
                        return Err(PlanError::invalid(
                            path,
                            "Invalid collection operation operands",
                        ))
                    }
                };
                let (schema, collection) = self.collection(input.collection, path)?;
                let mut expression = json!({"op":op,"collection":collection});
                if let Some((name, value, kind)) = body {
                    self.scopes.push(&schema.fields);
                    let operand_path = format!("{path}/{name}");
                    let (actual, value) = self.expression(value, &operand_path, depth + 1)?;
                    self.scopes.pop();
                    if actual != kind {
                        return Err(PlanError::invalid(
                            &operand_path,
                            format!(
                                "{op} requires a {} {name} expression; got {}",
                                kind.name(),
                                actual.name()
                            ),
                        ));
                    }
                    expression[name] = value;
                }
                let kind = if matches!(op, "count" | "sum") {
                    Kind::I64
                } else {
                    Kind::Bool
                };
                Ok((kind, expression))
            }
        }
    }
}

fn named_field<'a>(
    fields: &'a [Field],
    name: &str,
    path: &str,
) -> Result<(usize, &'a Field), PlanError> {
    fields
        .iter()
        .enumerate()
        .find(|(_, field)| field.name == name)
        .ok_or_else(|| PlanError::invalid(path, "Undeclared record field"))
}
