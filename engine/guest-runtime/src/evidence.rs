use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Policy {
    name: String,
    profile: String,
    signer_slot: usize,
    parser: Parser,
    fields: Vec<Field>,
    #[serde(default)]
    collections: Vec<Collection>,
    bindings: Vec<Binding>,
    context_field: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    field: String,
    file: String,
}

pub(super) fn validate(policies: &[Policy], parameters: &[Scalar]) -> Result<(), CheckError> {
    if policies.len() > 16 {
        return Err(CheckError::Structure);
    }
    for (index, policy) in policies.iter().enumerate() {
        if policy.signer_slot != index {
            return Err(CheckError::Parameters);
        }
        let Some(Scalar::String(signer)) = parameters.get(index) else {
            return Err(CheckError::Parameters);
        };
        let signer = signer
            .strip_prefix("0x")
            .and_then(|hex| hex::decode(hex).ok())
            .ok_or(CheckError::Parameters)?;
        crate::evidence_crypto::validate_key(&policy.profile, &signer)
            .map_err(|_| CheckError::Evidence)?;
    }
    Ok(())
}

pub(super) fn parse(
    policies: &[Policy],
    parameters: &[Scalar],
    context: &FundedContext,
    evidence: &[u8],
    delivery: &[u8],
) -> Result<Vec<ParsedFile>, CheckError> {
    validate(policies, parameters)?;
    let files = decode_bundle(BundleKind::Evidence, evidence)?;
    let delivery = decode_bundle(BundleKind::Delivery, delivery)?;
    if policies.len() != files.len() || policies.len() > 16 {
        return Err(CheckError::Evidence);
    }
    let mut names = BTreeSet::new();
    let mut result = Vec::new();
    for (index, policy) in policies.iter().enumerate() {
        check_filename(&policy.name)?;
        if !names.insert(&policy.name) || policy.signer_slot != index {
            return Err(CheckError::Structure);
        }
        let Some(Scalar::String(signer)) = parameters.get(policy.signer_slot) else {
            return Err(CheckError::Parameters);
        };
        let signer = signer
            .strip_prefix("0x")
            .and_then(|hex| hex::decode(hex).ok())
            .ok_or(CheckError::Parameters)?;
        let file = files
            .iter()
            .find(|file| file.name == policy.name)
            .ok_or(CheckError::Evidence)?;
        let payload =
            crate::evidence_crypto::verify(&policy.profile, &signer, context, file.contents)
                .map_err(|_| CheckError::Evidence)?;
        if !policy.bindings.is_empty() || policy.context_field.is_some() {
            if !matches!(policy.parser, Parser::Json) {
                return Err(CheckError::Structure);
            }
            let object = strict_json::from_slice(&payload).map_err(|_| CheckError::Evidence)?;
            let object = object.as_object().ok_or(CheckError::Evidence)?;
            let mut fields = BTreeSet::new();
            for binding in &policy.bindings {
                if !fields.insert(&binding.field) {
                    return Err(CheckError::Structure);
                }
                let file = delivery
                    .iter()
                    .find(|file| file.name == binding.file)
                    .ok_or(CheckError::Evidence)?;
                if object.get(&binding.field).and_then(Value::as_str)
                    != Some(format!("0x{}", hex::encode(sha256(file.contents))).as_str())
                {
                    return Err(CheckError::Evidence);
                }
            }
            if let Some(field) = &policy.context_field {
                if fields.contains(field) {
                    return Err(CheckError::Structure);
                }
                if object.get(field).and_then(Value::as_str)
                    != Some(format!("0x{}", hex::encode(sha256(&context.encode()))).as_str())
                {
                    return Err(CheckError::Evidence);
                }
            }
        }
        // Parse only after the signature and the approved bindings pass.
        result.push(parsed_file(parse_payload(policy, &payload)?, &payload));
    }
    Ok(result)
}

fn parse_payload(policy: &Policy, payload: &[u8]) -> Result<ParsedValue, CheckError> {
    match policy.parser {
        Parser::Json => {
            let value = strict_json::from_slice(payload).map_err(|_| CheckError::FileContents)?;
            check_json_limits(&value, 1)?;
            let Value::Object(mut object) = value else {
                return Err(CheckError::FileContents);
            };
            if policy.fields.len() + policy.collections.len() > MAX_ITEMS {
                return Err(CheckError::Structure);
            }
            let mut names = BTreeSet::new();
            let fields = policy
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
            for collection in &policy.collections {
                if collection.name.is_empty()
                    || !names.insert(&collection.name)
                    || collection.fields.is_empty()
                    || collection.fields.len() > MAX_ITEMS
                {
                    return Err(CheckError::Structure);
                }
                let mut fields = BTreeSet::new();
                if collection
                    .fields
                    .iter()
                    .any(|field| field.name.is_empty() || !fields.insert(&field.name))
                {
                    return Err(CheckError::Structure);
                }
            }
            let collections = records::parse_collections(&policy.collections, &mut object)?;
            Ok(ParsedValue::Json(fields, collections))
        }
        Parser::Text if policy.fields.is_empty() && policy.collections.is_empty() => {
            Ok(ParsedValue::Text(Scalar::String(
                std::str::from_utf8(payload)
                    .map_err(|_| CheckError::FileContents)?
                    .into(),
            )))
        }
        Parser::Opaque if policy.fields.is_empty() && policy.collections.is_empty() => {
            Ok(ParsedValue::Opaque)
        }
        _ => Err(CheckError::Structure),
    }
}
