const COMMANDS: &[&str] = &[
    "load",
    "save",
    "clear",
    "host",
    "configure",
    "schedule_watch",
    "notifications_init",
];

fn main() {
    // The Android package is a compile-time constant so `register_android_plugin`
    // can never drift from the Gradle namespace.
    let manifest =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let brand_path = manifest.join("..").join("..").join("..").join("brand.json");
    println!("cargo:rerun-if-changed={}", brand_path.display());
    let text = std::fs::read_to_string(&brand_path)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", brand_path.display()));
    let brand: serde_json::Value =
        serde_json::from_str(&text).expect("brand.json must be valid JSON");
    let package = brand
        .get("androidPackage")
        .and_then(|value| value.as_str())
        .expect("brand.json must define androidPackage");
    println!("cargo:rustc-env=PANDU_BRAND_ANDROID_PACKAGE={package}");

    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
