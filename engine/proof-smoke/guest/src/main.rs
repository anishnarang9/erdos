#![no_main]
#![no_std]

risc0_zkvm::guest::entry!(main);

fn main() {
    risc0_zkvm::guest::env::commit_slice(b"UBC26/proof-smoke/v1");
}
