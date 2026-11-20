use super::*;

/// Validate rule types and selectors without depending on the number of input records.
pub(super) fn validate(structure: &Structure, parameters: &[Scalar]) -> Result<(), CheckError> {
    if structure.deliverables.is_empty()
        || structure.deliverables.len() > 16
        || structure.references.len() > 16
        || structure.evidence.len() > 16
        || parameters.len() > MAX_ITEMS
        || !(1..=MAX_ITEMS).contains(&structure.rules.len())
    {
        return Err(CheckError::Structure);
    }
    for files in [&structure.deliverables, &structure.references] {
        let mut names = BTreeSet::new();
        for file in files {
            check_filename(&file.name)?;
            if !names.insert(&file.name) {
                return Err(CheckError::Structure);
            }
            validate_schema(&file.parser, &file.fields, &file.collections)?;
        }
    }
    let mut names = BTreeSet::new();
    for policy in &structure.evidence {
        check_filename(&policy.name)?;
        if !names.insert(&policy.name) {
            return Err(CheckError::Structure);
        }
        validate_schema(&policy.parser, &policy.fields, &policy.collections)?;
    }
    let mut checker = Checker {
        structure,
        parameters,
        scopes: Vec::new(),
        nodes: 0,
        next_slot: structure.evidence.len(),
    };
    for expression in &structure.rules {
        if checker.expression(expression, 1)? != Kind::Bool {
            return Err(CheckError::Rule);
        }
    }
    if checker.next_slot != parameters.len() {
        return Err(CheckError::Parameters);
    }
    Ok(())
}

fn validate_schema(
    parser: &Parser,
    fields: &[Field],
    collections: &[Collection],
) -> Result<(), CheckError> {
    if fields.len() + collections.len() > MAX_ITEMS
        || (!matches!(parser, Parser::Json) && (!fields.is_empty() || !collections.is_empty()))
    {
        return Err(CheckError::Structure);
    }
    let mut names = BTreeSet::new();
    for field in fields {
        if field.name.is_empty() || !names.insert(&field.name) {
            return Err(CheckError::Structure);
        }
    }
    for collection in collections {
        if collection.name.is_empty()
            || !names.insert(&collection.name)
            || collection.fields.is_empty()
            || collection.fields.len() > MAX_ITEMS
        {
            return Err(CheckError::Structure);
        }
        let mut record_names = BTreeSet::new();
        if collection
            .fields
            .iter()
            .any(|field| field.name.is_empty() || !record_names.insert(&field.name))
        {
            return Err(CheckError::Structure);
        }
    }
    Ok(())
}

struct Checker<'a> {
    structure: &'a Structure,
    parameters: &'a [Scalar],
    scopes: Vec<&'a [Field]>,
    nodes: usize,
    next_slot: usize,
}

impl<'a> Checker<'a> {
    fn schema(
        &self,
        source: &Source,
        index: usize,
    ) -> Result<(&'a Parser, &'a [Field], &'a [Collection]), CheckError> {
        if matches!(source, Source::Evidence) {
            let policy = self.structure.evidence.get(index).ok_or(CheckError::Rule)?;
            return Ok((&policy.parser, &policy.fields, &policy.collections));
        }
        let files = match source {
            Source::Deliverable => &self.structure.deliverables,
            Source::Reference => &self.structure.references,
            Source::Evidence => unreachable!(),
        };
        let file = files.get(index).ok_or(CheckError::Rule)?;
        Ok((&file.parser, &file.fields, &file.collections))
    }

    fn collection(&self, access: &records::Access) -> Result<&'a [Field], CheckError> {
        let (parser, _, collections) = self.schema(&access.source, access.file)?;
        if !matches!(parser, Parser::Json) {
            return Err(CheckError::Rule);
        }
        Ok(&collections
            .get(access.field)
            .ok_or(CheckError::Rule)?
            .fields)
    }

    fn scoped(
        &mut self,
        fields: &'a [Field],
        body: &Expression,
        depth: usize,
        expected: Kind,
    ) -> Result<(), CheckError> {
        self.scopes.push(fields);
        let result = self.expression(body, depth + 1);
        self.scopes.pop();
        if result? != expected {
            return Err(CheckError::Rule);
        }
        Ok(())
    }

    fn expression(&mut self, expression: &Expression, depth: usize) -> Result<Kind, CheckError> {
        self.nodes += 1;
        if self.nodes > MAX_ITEMS || depth > MAX_DEPTH {
            return Err(CheckError::Rule);
        }
        use Expression::*;
        let kind = match expression {
            Field {
                source,
                file,
                field,
            } => {
                let (parser, fields, _) = self.schema(source, *file)?;
                match (parser, field) {
                    (Parser::Text, None) => Kind::String,
                    (Parser::Json, Some(index)) => fields.get(*index).ok_or(CheckError::Rule)?.kind,
                    _ => return Err(CheckError::Rule),
                }
            }
            FileHash { source, file } | FileSize { source, file } => {
                self.schema(source, *file)?;
                if matches!(expression, FileHash { .. }) {
                    Kind::String
                } else {
                    Kind::I64
                }
            }
            Parameter { slot, kind } => {
                if *slot != self.next_slot
                    || self
                        .parameters
                        .get(*slot)
                        .is_none_or(|value| value.kind() != *kind)
                {
                    return Err(CheckError::Parameters);
                }
                self.next_slot += 1;
                *kind
            }
            RecordField { field, level } => {
                self.scopes
                    .iter()
                    .rev()
                    .nth(*level)
                    .and_then(|fields| fields.get(*field))
                    .ok_or(CheckError::Rule)?
                    .kind
            }
            Unique { collection, field } => {
                self.collection(collection)?
                    .get(*field)
                    .ok_or(CheckError::Rule)?;
                Kind::Bool
            }
            Lookup {
                collection,
                key_field,
                key,
                value_field,
            } => {
                let fields = self.collection(collection)?;
                let key_kind = fields.get(*key_field).ok_or(CheckError::Rule)?.kind;
                let value_kind = fields.get(*value_field).ok_or(CheckError::Rule)?.kind;
                if self.expression(key, depth + 1)? != key_kind {
                    return Err(CheckError::Rule);
                }
                value_kind
            }
            Count {
                collection,
                predicate,
            } => {
                let fields = self.collection(collection)?;
                if let Some(predicate) = predicate {
                    self.scoped(fields, predicate, depth, Kind::Bool)?;
                }
                Kind::I64
            }
            Sum { collection, value } => {
                let fields = self.collection(collection)?;
                self.scoped(fields, value, depth, Kind::I64)?;
                Kind::I64
            }
            All {
                collection,
                predicate,
            }
            | Any {
                collection,
                predicate,
            } => {
                let fields = self.collection(collection)?;
                self.scoped(fields, predicate, depth, Kind::Bool)?;
                Kind::Bool
            }
            Not { value } => {
                if self.expression(value, depth + 1)? != Kind::Bool {
                    return Err(CheckError::Rule);
                }
                Kind::Bool
            }
            If {
                condition,
                then_branch,
                else_branch,
            } => {
                if self.expression(condition, depth + 1)? != Kind::Bool {
                    return Err(CheckError::Rule);
                }
                let then_kind = self.expression(then_branch, depth + 1)?;
                if self.expression(else_branch, depth + 1)? != then_kind {
                    return Err(CheckError::Rule);
                }
                then_kind
            }
            Add(binary) | Sub(binary) | Mul(binary) | Lt(binary) | Lte(binary) | Gt(binary)
            | Gte(binary) | Eq(binary) | Ne(binary) | And(binary) | Or(binary) => {
                let left = self.expression(&binary.left, depth + 1)?;
                let right = self.expression(&binary.right, depth + 1)?;
                let expected = match expression {
                    Eq(_) | Ne(_) => left,
                    And(_) | Or(_) => Kind::Bool,
                    _ => Kind::I64,
                };
                if left != expected || right != expected {
                    return Err(CheckError::Rule);
                }
                if matches!(expression, Add(_) | Sub(_) | Mul(_)) {
                    Kind::I64
                } else {
                    Kind::Bool
                }
            }
        };
        Ok(kind)
    }
}
