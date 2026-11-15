use super::*;

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Access {
    pub source: Source,
    pub file: usize,
    pub field: usize,
}

pub(super) fn validate_schema(file: &File) -> Result<(), CheckError> {
    if file.fields.len() + file.collections.len() > MAX_ITEMS {
        return Err(CheckError::Structure);
    }
    let mut names: BTreeSet<_> = file.fields.iter().map(|field| &field.name).collect();
    for collection in &file.collections {
        if collection.name.is_empty()
            || !names.insert(&collection.name)
            || collection.fields.is_empty()
            || collection.fields.len() > MAX_ITEMS
        {
            return Err(CheckError::Structure);
        }
        let mut names = BTreeSet::new();
        if collection
            .fields
            .iter()
            .any(|field| field.name.is_empty() || !names.insert(&field.name))
        {
            return Err(CheckError::Structure);
        }
    }
    Ok(())
}

pub(super) fn parse_collections(
    schema: &[Collection],
    object: &mut serde_json::Map<String, Value>,
) -> Result<Vec<Vec<Vec<Scalar>>>, CheckError> {
    schema
        .iter()
        .map(|collection| {
            let Some(Value::Array(rows)) = object.remove(&collection.name) else {
                return Err(CheckError::FileContents);
            };
            if rows.len() > MAX_ITEMS {
                return Err(CheckError::FileContents);
            }
            rows.into_iter()
                .map(|row| {
                    let Value::Object(mut row) = row else {
                        return Err(CheckError::FileContents);
                    };
                    collection
                        .fields
                        .iter()
                        .map(|field| {
                            row.remove(&field.name)
                                .and_then(|value| Scalar::from_json(field.kind, value))
                                .ok_or(CheckError::FileContents)
                        })
                        .collect()
                })
                .collect()
        })
        .collect()
}

impl<'a> Evaluator<'a> {
    fn collection(&self, access: &Access) -> Result<&'a [Vec<Scalar>], CheckError> {
        let files = match access.source {
            Source::Deliverable => self.deliverables,
            Source::Reference => self.references,
            Source::Evidence => self.evidence,
        };
        match files.get(access.file).map(|file| &file.value) {
            Some(ParsedValue::Json(_, collections)) => collections
                .get(access.field)
                .map(Vec::as_slice)
                .ok_or(CheckError::Rule),
            _ => Err(CheckError::Rule),
        }
    }

    pub(super) fn evaluate_records(
        &mut self,
        expr: &Expression,
        depth: usize,
    ) -> Result<Evaluated<'a>, CheckError> {
        use Expression::*;
        let scalar = match expr {
            RecordField { field, level } => {
                let value = self
                    .scopes
                    .iter()
                    .rev()
                    .nth(*level)
                    .and_then(|row| row.get(*field))
                    .ok_or(CheckError::Rule)?;
                return Ok(Evaluated::Borrowed(value));
            }
            Unique { collection, field } => {
                let mut keys = BTreeSet::new();
                let mut unique = true;
                for row in self.collection(collection)? {
                    unique &= keys.insert(row.get(*field).ok_or(CheckError::Rule)?);
                }
                Scalar::Bool(unique)
            }
            Lookup {
                collection,
                key_field,
                key,
                value_field,
            } => {
                let key = self.evaluate(key, depth + 1)?;
                let rows = self.collection(collection)?;
                let mut keys = BTreeSet::new();
                let mut found = None;
                for row in rows {
                    let row_key = row.get(*key_field).ok_or(CheckError::Rule)?;
                    if !keys.insert(row_key) {
                        return Err(CheckError::Rule);
                    }
                    if row_key == key.as_scalar() {
                        found = row.get(*value_field);
                    }
                }
                return found.map(Evaluated::Borrowed).ok_or(CheckError::Rule);
            }
            Count {
                collection,
                predicate,
            } => {
                let mut count = 0;
                for row in self.collection(collection)? {
                    let include = match predicate {
                        None => true,
                        Some(predicate) => self.predicate(predicate, row, depth)?,
                    };
                    count += i64::from(include);
                }
                Scalar::I64(count)
            }
            Sum { collection, value } => {
                let mut sum = 0i64;
                for row in self.collection(collection)? {
                    self.scopes.push(row);
                    let result = self.evaluate(value, depth + 1);
                    self.scopes.pop();
                    let result = result?;
                    let Scalar::I64(value) = result.as_scalar() else {
                        return Err(CheckError::Rule);
                    };
                    sum = sum.checked_add(*value).ok_or(CheckError::Overflow)?;
                }
                Scalar::I64(sum)
            }
            All {
                collection,
                predicate,
            }
            | Any {
                collection,
                predicate,
            } => {
                let all = matches!(expr, All { .. });
                let mut result = all;
                for row in self.collection(collection)? {
                    let value = self.predicate(predicate, row, depth)?;
                    result = if all { result & value } else { result | value };
                }
                Scalar::Bool(result)
            }
            _ => return Err(CheckError::Rule),
        };
        Ok(Evaluated::Owned(scalar))
    }

    fn predicate(
        &mut self,
        expr: &Expression,
        row: &'a [Scalar],
        depth: usize,
    ) -> Result<bool, CheckError> {
        self.scopes.push(row);
        let result = self.evaluate(expr, depth + 1);
        self.scopes.pop();
        match result?.as_scalar() {
            Scalar::Bool(value) => Ok(*value),
            _ => Err(CheckError::Rule),
        }
    }
}
