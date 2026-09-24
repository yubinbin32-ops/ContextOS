use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    let package_json_path = manifest_dir.join("../../../package.json");
    println!("cargo:rerun-if-changed={}", package_json_path.display());

    let package_json: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&package_json_path).expect("failed to read root package.json"),
    )
    .expect("failed to parse root package.json");
    let version = package_json
        .get("version")
        .and_then(serde_json::Value::as_str)
        .expect("root package.json is missing a string version");
    println!("cargo:rustc-env=CONTEXTOS_VERSION={version}");

    tauri_build::build()
}
