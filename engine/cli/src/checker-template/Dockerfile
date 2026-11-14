# syntax=docker/dockerfile:1
FROM risczero/risc0-guest-builder:r0.1.97.0@sha256:6f6c300e4af57ea3efe62b7f04a17629efe0f0caa6ad3699d6766bf19e0e62fb AS build
WORKDIR /src
COPY . .
ENV CC_riscv32im_risc0_zkvm_elf=/root/.risc0/cpp/bin/riscv32-unknown-elf-gcc
ENV CFLAGS_riscv32im_risc0_zkvm_elf="-march=rv32im -nostdlib"
RUN --mount=type=cache,id=ubc26-rust197-registry,target=/root/.cargo/registry,sharing=locked \
    --mount=type=cache,id=ubc26-rust197-checker,target=/src/target,sharing=locked \
    CARGO_ENCODED_RUSTFLAGS="$(printf '%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s' -C passes=lower-atomic -C link-arg=-Ttext=0x00200800 -C link-arg=--fatal-warnings -C panic=abort --cfg 'getrandom_backend="custom"')" \
    cargo +risc0 build --locked --release --target riscv32im-risc0-zkvm-elf --bin ubc26-checker \
    && cp target/riscv32im-risc0-zkvm-elf/release/ubc26-checker /checker
FROM scratch
COPY --from=build /checker /checker
