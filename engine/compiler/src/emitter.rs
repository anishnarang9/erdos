use super::*;

/// Emit Rust constructors from the validated, normalized operation tree.
pub fn emit_rules(structure: &Value) -> Result<String, PlanError> {
    let rules = structure
        .get("rules")
        .and_then(Value::as_array)
        .ok_or_else(|| PlanError::invalid("/rules", "Expected normalized rules"))?;
    let mut nodes = 0;
    let expressions = rules
        .iter()
        .map(|rule| emit(rule, 1, &mut nodes))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(format!(
        "use ubc26_guest_runtime::generated::{{Expression as E, Binary as B, Source as S, Kind as K, CollectionAccess as A}};\npub fn generated_rules() -> alloc::vec::Vec<E> {{ alloc::vec![{}] }}\n",
        expressions.join(",")
    ))
}

fn index(input: &Value) -> Result<String, PlanError> {
    input
        .as_u64()
        .filter(|value| *value <= u32::MAX as u64)
        .map(|value| value.to_string())
        .ok_or_else(|| PlanError::invalid("", "Expected a normalized index"))
}

fn source(input: &Value) -> Result<&'static str, PlanError> {
    match input.as_str() {
        Some("deliverable") => Ok("S::Deliverable"),
        Some("reference") => Ok("S::Reference"),
        Some("evidence") => Ok("S::Evidence"),
        _ => Err(PlanError::invalid("", "Expected a normalized source")),
    }
}

fn access(input: &Value) -> Result<String, PlanError> {
    Ok(format!(
        "A{{source:{},file:{},field:{}}}",
        source(&input["source"])?,
        index(&input["file"])?,
        index(&input["field"])?
    ))
}

fn emit(input: &Value, depth: usize, nodes: &mut usize) -> Result<String, PlanError> {
    *nodes += 1;
    if depth > MAX_RULE_DEPTH || *nodes > MAX_RULE_NODES {
        return Err(PlanError::invalid(
            "",
            "Generated rules exceed compiler limits",
        ));
    }
    let op = input["op"]
        .as_str()
        .ok_or_else(|| PlanError::invalid("", "Expected a normalized operation"))?;
    let value = match op {
        "field" => format!(
            "E::Field{{source:{},file:{},field:{}}}",
            source(&input["source"])?,
            index(&input["file"])?,
            match input.get("field") {
                None => "None".into(),
                Some(value) => format!("Some({})", index(value)?),
            }
        ),
        "file_hash" | "file_size" => format!(
            "E::{}{{source:{},file:{}}}",
            if op == "file_hash" {
                "FileHash"
            } else {
                "FileSize"
            },
            source(&input["source"])?,
            index(&input["file"])?
        ),
        "record_field" => format!(
            "E::RecordField{{field:{},level:{}}}",
            index(&input["field"])?,
            index(&input["level"])?
        ),
        "parameter" => {
            let kind = match input["type"].as_str() {
                Some("bool") => "K::Bool",
                Some("i64") => "K::I64",
                Some("string") => "K::String",
                _ => return Err(PlanError::invalid("", "Expected a normalized type")),
            };
            format!(
                "E::Parameter{{slot:{},kind:{kind}}}",
                index(&input["slot"])?
            )
        }
        "not" => format!(
            "E::Not{{value:alloc::boxed::Box::new({})}}",
            emit(&input["value"], depth + 1, nodes)?
        ),
        "if" => format!(
            "E::If{{condition:alloc::boxed::Box::new({}),then_branch:alloc::boxed::Box::new({}),else_branch:alloc::boxed::Box::new({})}}",
            emit(&input["condition"], depth + 1, nodes)?,
            emit(&input["then"], depth + 1, nodes)?,
            emit(&input["else"], depth + 1, nodes)?
        ),
        "count" => format!(
            "E::Count{{collection:{},predicate:{}}}",
            access(&input["collection"])?,
            match input.get("where") {
                None => "None".into(),
                Some(value) => format!(
                    "Some(alloc::boxed::Box::new({}))",
                    emit(value, depth + 1, nodes)?
                ),
            }
        ),
        "sum" => format!(
            "E::Sum{{collection:{},value:alloc::boxed::Box::new({})}}",
            access(&input["collection"])?,
            emit(&input["value"], depth + 1, nodes)?
        ),
        "all" | "any" => format!(
            "E::{}{{collection:{},predicate:alloc::boxed::Box::new({})}}",
            if op == "all" { "All" } else { "Any" },
            access(&input["collection"])?,
            emit(&input["where"], depth + 1, nodes)?
        ),
        "unique" => format!(
            "E::Unique{{collection:{},field:{}}}",
            access(&input["collection"])?,
            index(&input["field"])?
        ),
        "lookup" => format!(
            "E::Lookup{{collection:{},key_field:{},key:alloc::boxed::Box::new({}),value_field:{}}}",
            access(&input["collection"])?,
            index(&input["keyField"])?,
            emit(&input["key"], depth + 1, nodes)?,
            index(&input["valueField"])?
        ),
        _ => {
            let variant = match op {
                "add" => "Add",
                "sub" => "Sub",
                "mul" => "Mul",
                "lt" => "Lt",
                "lte" => "Lte",
                "gt" => "Gt",
                "gte" => "Gte",
                "eq" => "Eq",
                "ne" => "Ne",
                "and" => "And",
                "or" => "Or",
                _ => return Err(PlanError::unsupported("", "operation", op)),
            };
            format!("E::{variant}(B{{left:alloc::boxed::Box::new({}),right:alloc::boxed::Box::new({})}})",emit(&input["left"],depth+1,nodes)?,emit(&input["right"],depth+1,nodes)?)
        }
    };
    Ok(value)
}
