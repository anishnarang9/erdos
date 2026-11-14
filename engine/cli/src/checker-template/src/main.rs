#![no_main]
#![no_std]

extern crate alloc;

use alloc::{vec, vec::Vec};
use risc0_zkvm::guest::env;
use ubc26_protocol::{BundleKind, FundedContext, CONTEXT_BYTES, NONCE_BYTES};

risc0_zkvm::guest::entry!(main);

const STRUCTURE: &[u8] = include_bytes!("../structure.jcs");

fn read_input(limit: usize) -> Vec<u8> {
    let mut length = [0; 4];
    env::read_slice(&mut length);
    let length = u32::from_le_bytes(length) as usize;
    assert!(length <= limit, "checker input exceeds its limit");
    let mut bytes = vec![0; length];
    env::read_slice(&mut bytes);
    bytes
}

fn main() {
    let parameters = read_input(256 * 1024);
    let reference = read_input(BundleKind::Reference.max_bytes());
    let delivery = read_input(BundleKind::Delivery.max_bytes());
    let mut context = [0; CONTEXT_BYTES];
    let mut key = [0; 32];
    let mut nonce = [0; NONCE_BYTES];
    env::read_slice(&mut context);
    env::read_slice(&mut key);
    env::read_slice(&mut nonce);
    let context = FundedContext::decode(&context).expect("invalid funded context");
    let (journal, _) = ubc26_guest_runtime::check(
        STRUCTURE, &parameters, &reference, &delivery, &context, &key, &nonce,
    ).expect("invalid checker input");
    env::commit_slice(&journal.encode());
}
