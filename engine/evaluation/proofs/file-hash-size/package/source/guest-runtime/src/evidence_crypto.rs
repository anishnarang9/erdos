use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature as EdSignature, VerifyingKey as EdKey};
use k256::ecdsa::{RecoveryId, Signature as EthSignature, VerifyingKey as EthKey};
use p256::ecdsa::{signature::Verifier, Signature as P256Signature, VerifyingKey as P256Key};
use rsa::{pkcs8::DecodePublicKey, traits::PublicKeyParts, RsaPublicKey};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use ubc26_protocol::{sha256, strict_json, FundedContext};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvidenceError {
    Profile,
    Key,
    Signature,
    Envelope,
    Header,
    Payload,
}

/// Check the approved key encoding and the profile before funding.
pub fn validate_key(profile: &str, signer: &[u8]) -> Result<(), EvidenceError> {
    match profile {
        "ed25519/v1" | "jws/Ed25519/v1" | "jws/EdDSA/v1" => {
            let key = EdKey::from_bytes(signer.try_into().map_err(|_| EvidenceError::Key)?)
                .map_err(|_| EvidenceError::Key)?;
            if key.is_weak() {
                return Err(EvidenceError::Key);
            }
        }
        "eip712/v1" if signer.len() == 20 => (),
        "jws/ES256/v1" => {
            P256Key::from_sec1_bytes(signer).map_err(|_| EvidenceError::Key)?;
        }
        "jws/RS256/v1" => {
            let key = RsaPublicKey::from_public_key_der(signer).map_err(|_| EvidenceError::Key)?;
            if !(2048..=4096).contains(&key.n().bits()) {
                return Err(EvidenceError::Key);
            }
        }
        _ => return Err(EvidenceError::Profile),
    }
    Ok(())
}

/// Verify raw approved evidence and return the exact authenticated payload.
pub fn verify(
    profile: &str,
    signer: &[u8],
    context: &FundedContext,
    encoded: &[u8],
) -> Result<Vec<u8>, EvidenceError> {
    match profile {
        "ed25519/v1" | "eip712/v1" => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Signed {
                payload: String,
                signature: String,
            }
            let signed: Signed = serde_json::from_value(
                strict_json::from_slice(encoded).map_err(|_| EvidenceError::Envelope)?,
            )
            .map_err(|_| EvidenceError::Envelope)?;
            let payload = decode_hex(&signed.payload)?;
            let signature = decode_hex(&signed.signature)?;
            if profile == "ed25519/v1" {
                let value =
                    strict_json::from_slice(&payload).map_err(|_| EvidenceError::Payload)?;
                if serde_json_canonicalizer::to_vec(&value).map_err(|_| EvidenceError::Payload)?
                    != payload
                {
                    return Err(EvidenceError::Payload);
                }
                let mut message = b"UBC26/evidence/v1".to_vec();
                message.extend_from_slice(&payload);
                verify_ed(signer, &message, &signature)?;
            } else {
                verify_eip712(signer, context, &payload, &signature)?;
            }
            Ok(payload)
        }
        "jws/Ed25519/v1" | "jws/EdDSA/v1" | "jws/ES256/v1" | "jws/RS256/v1" => {
            verify_jws(profile, signer, encoded)
        }
        _ => Err(EvidenceError::Profile),
    }
}

fn decode_hex(input: &str) -> Result<Vec<u8>, EvidenceError> {
    hex::decode(input.strip_prefix("0x").ok_or(EvidenceError::Envelope)?)
        .map_err(|_| EvidenceError::Envelope)
}

fn verify_ed(signer: &[u8], message: &[u8], signature: &[u8]) -> Result<(), EvidenceError> {
    let key = EdKey::from_bytes(signer.try_into().map_err(|_| EvidenceError::Key)?)
        .map_err(|_| EvidenceError::Key)?;
    key.verify_strict(
        message,
        &EdSignature::from_slice(signature).map_err(|_| EvidenceError::Signature)?,
    )
    .map_err(|_| EvidenceError::Signature)
}

/// Build the EIP-712 digest from the exact funded context and payload bytes.
pub fn eip712_digest(context: &FundedContext, payload: &[u8]) -> [u8; 32] {
    fn hash(bytes: &[u8]) -> [u8; 32] {
        Keccak256::digest(bytes).into()
    }
    let mut domain = Vec::new();
    domain.extend_from_slice(&hash(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ));
    domain.extend_from_slice(&hash(b"UBC26 Evidence"));
    domain.extend_from_slice(&hash(b"1"));
    domain.extend_from_slice(&context.chain_id);
    domain.extend_from_slice(&[0; 12]);
    domain.extend_from_slice(&context.escrow);
    let mut message = Vec::new();
    message.extend_from_slice(&hash(b"Evidence(bytes32 contextHash,bytes32 payloadHash)"));
    message.extend_from_slice(&sha256(&context.encode()));
    message.extend_from_slice(&sha256(payload));
    let mut typed = b"\x19\x01".to_vec();
    typed.extend_from_slice(&hash(&domain));
    typed.extend_from_slice(&hash(&message));
    hash(&typed)
}

fn verify_eip712(
    signer: &[u8],
    context: &FundedContext,
    payload: &[u8],
    encoded: &[u8],
) -> Result<(), EvidenceError> {
    if signer.len() != 20 || encoded.len() != 65 {
        return Err(EvidenceError::Signature);
    }
    let signature =
        EthSignature::from_slice(&encoded[..64]).map_err(|_| EvidenceError::Signature)?;
    if signature.normalize_s().is_some() {
        return Err(EvidenceError::Signature);
    }
    let recovery = match encoded[64] {
        0 | 1 => encoded[64],
        27 | 28 => encoded[64] - 27,
        _ => return Err(EvidenceError::Signature),
    };
    let recovery = RecoveryId::try_from(recovery).map_err(|_| EvidenceError::Signature)?;
    let key = EthKey::recover_from_prehash(&eip712_digest(context, payload), &signature, recovery)
        .map_err(|_| EvidenceError::Signature)?;
    let point = key.to_encoded_point(false);
    let address = Keccak256::digest(&point.as_bytes()[1..]);
    if signer != &address[12..] {
        return Err(EvidenceError::Signature);
    }
    Ok(())
}

fn base64(input: &str) -> Result<Vec<u8>, EvidenceError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|_| EvidenceError::Envelope)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != input {
        return Err(EvidenceError::Envelope);
    }
    Ok(bytes)
}

fn verify_jws(profile: &str, signer: &[u8], encoded: &[u8]) -> Result<Vec<u8>, EvidenceError> {
    let text = std::str::from_utf8(encoded).map_err(|_| EvidenceError::Envelope)?;
    let parts: Vec<_> = text.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(EvidenceError::Envelope);
    }
    let header = base64(parts[0])?;
    let header = strict_json::from_slice(&header).map_err(|_| EvidenceError::Header)?;
    let header = header.as_object().ok_or(EvidenceError::Header)?;
    if header
        .keys()
        .any(|key| !matches!(key.as_str(), "alg" | "typ"))
    {
        return Err(EvidenceError::Header);
    }
    if header.get("typ").is_some_and(|value| !value.is_string()) {
        return Err(EvidenceError::Header);
    }
    let algorithm = profile
        .strip_prefix("jws/")
        .and_then(|value| value.strip_suffix("/v1"))
        .ok_or(EvidenceError::Profile)?;
    if header.get("alg").and_then(serde_json::Value::as_str) != Some(algorithm) {
        return Err(EvidenceError::Header);
    }
    let payload = base64(parts[1])?;
    let signature = base64(parts[2])?;
    let message = &encoded[..parts[0].len() + 1 + parts[1].len()];
    match algorithm {
        "Ed25519" | "EdDSA" => verify_ed(signer, message, &signature)?,
        "ES256" => {
            let key = P256Key::from_sec1_bytes(signer).map_err(|_| EvidenceError::Key)?;
            let signature =
                P256Signature::from_slice(&signature).map_err(|_| EvidenceError::Signature)?;
            key.verify(message, &signature)
                .map_err(|_| EvidenceError::Signature)?;
        }
        "RS256" => {
            let key = RsaPublicKey::from_public_key_der(signer).map_err(|_| EvidenceError::Key)?;
            if !(2048..=4096).contains(&key.n().bits()) {
                return Err(EvidenceError::Key);
            }
            key.verify(
                rsa::Pkcs1v15Sign::new::<Sha256>(),
                &Sha256::digest(message),
                &signature,
            )
            .map_err(|_| EvidenceError::Signature)?;
        }
        _ => return Err(EvidenceError::Profile),
    }
    Ok(payload)
}
