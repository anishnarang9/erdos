use risc0_binfmt::ProgramBinary;
use std::{fs, path::Path};

#[test]
#[ignore = "Requires UBC26_REBUILD_PACKAGE and an independently rebuilt UBC26_REBUILD_USER_ELF"]
fn independent_guest_build_matches_the_package_program_byte_for_byte() {
    let package = std::env::var_os("UBC26_REBUILD_PACKAGE").expect("package directory");
    let rebuilt = std::env::var_os("UBC26_REBUILD_USER_ELF").expect("independent user ELF");
    let package = Path::new(&package);
    let original = fs::read(package.join("guest.elf")).unwrap();
    let original_binary = ProgramBinary::decode(&original).unwrap();
    let user = fs::read(rebuilt).unwrap();
    assert_eq!(user, original_binary.user_elf);
    let combined = ProgramBinary::new(&user, original_binary.kernel_elf).encode();
    assert_eq!(combined, original);
    let image = risc0_zkvm::compute_image_id(&combined).unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(package.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(format!("0x{image}"), manifest["imageId"].as_str().unwrap());
    println!("Independent clean build reproduced image 0x{image}");
}
