use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    name: String,
    profile: String,
    signer: String,
    parser: String,
    #[serde(default)]
    fields: Vec<Field>,
    #[serde(default)]
    collections: Vec<Collection>,
    #[serde(default)]
    bindings: Vec<Binding>,
    #[serde(default)]
    context_field: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    field: String,
    file: String,
}

type Prepared = (Vec<File>, Vec<Value>, Vec<Value>);

pub(super) fn prepare(input: &[Value], deliverables: &[File]) -> Result<Prepared, PlanError> {
    if input.len() > MAX_FILES {
        return Err(PlanError::invalid(
            "/evidence",
            "At most 16 evidence files are allowed",
        ));
    }
    let mut files = Vec::new();
    let mut policies = Vec::new();
    let mut parameters = Vec::new();
    for (slot, value) in input.iter().enumerate() {
        let path = format!("/evidence/{slot}");
        let profile = value
            .get("profile")
            .and_then(Value::as_str)
            .ok_or_else(|| PlanError::invalid(&path, "Expected an evidence profile"))?;
        let size = match profile {
            "ed25519/v1" | "jws/Ed25519/v1" | "jws/EdDSA/v1" => 32..=32,
            "eip712/v1" => 20..=20,
            "jws/ES256/v1" => 33..=65,
            "jws/RS256/v1" => 256..=1024,
            _ => {
                return Err(PlanError::unsupported(
                    &format!("{path}/profile"),
                    "evidence",
                    profile,
                ))
            }
        };
        let input: Input = decode(value.clone(), &path)?;
        let signer = input
            .signer
            .strip_prefix("0x")
            .and_then(|hex| hex::decode(hex).ok())
            .filter(|bytes| size.contains(&bytes.len()))
            .ok_or_else(|| {
                PlanError::invalid(
                    &format!("{path}/signer"),
                    "Expected a hex public key or EOA for the profile",
                )
            })?;
        if (!input.bindings.is_empty() || input.context_field.is_some())
            && input.parser != "json/v1"
        {
            return Err(PlanError::invalid(
                &path,
                "Evidence bindings require a JSON payload",
            ));
        }
        let mut bound = BTreeSet::new();
        for binding in &input.bindings {
            if !bound.insert(&binding.field)
                || !input
                    .fields
                    .iter()
                    .any(|field| field.name == binding.field && field.kind == Kind::String)
                || !deliverables.iter().any(|file| file.name == binding.file)
            {
                return Err(PlanError::invalid(
                    &path,
                    "An artifact binding requires a unique string field and declared delivery file",
                ));
            }
        }
        if let Some(field) = &input.context_field {
            if bound.contains(field)
                || !input
                    .fields
                    .iter()
                    .any(|schema| schema.name == *field && schema.kind == Kind::String)
            {
                return Err(PlanError::invalid(
                    &path,
                    "A context binding requires a separate declared string field",
                ));
            }
        }
        let file = File {
            name: input.name,
            parser: input.parser,
            fields: input.fields,
            collections: input.collections,
        };
        let mut policy = serde_json::to_value(&file).expect("file schema");
        policy["profile"] = json!(input.profile);
        policy["signerSlot"] = json!(slot);
        policy["bindings"] = json!(input.bindings);
        if let Some(field) = input.context_field {
            policy["contextField"] = json!(field);
        }
        files.push(file);
        policies.push(policy);
        parameters.push(json!({"type":"string","value":format!("0x{}",hex::encode(signer))}));
    }
    validate_files(&files, "/evidence")?;
    Ok((files, policies, parameters))
}
