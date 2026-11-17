use risc0_build::{DockerOptionsBuilder, GuestOptionsBuilder, embed_methods_with_options};
use std::{collections::HashMap, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=RISC0_DOCKER_CONTAINER_TAG");
    assert!(
        std::env::var_os("RISC0_DOCKER_CONTAINER_TAG").is_none(),
        "unset RISC0_DOCKER_CONTAINER_TAG to use the pinned guest builder"
    );
    let docker = DockerOptionsBuilder::default()
        .root_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("guest"))
        .docker_container_tag(
            "r0.1.97.0@sha256:6f6c300e4af57ea3efe62b7f04a17629efe0f0caa6ad3699d6766bf19e0e62fb"
                .to_owned(),
        )
        .build()
        .expect("configure the digest-pinned guest builder");
    let options = GuestOptionsBuilder::default()
        .use_docker(docker)
        .build()
        .expect("configure the guest build");
    embed_methods_with_options(HashMap::from([("ubc26-smoke-guest", options)]));
}
