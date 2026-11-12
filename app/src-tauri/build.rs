use std::path::Path;

fn main() {
    // The desktop shell embeds `ui/dist` at compile time. Cargo does not watch
    // it on its own, so a UI rebuild could otherwise leave a stale bundle in
    // the binary. Track every file, not just the directory mtime.
    fn watch(path: &Path) {
        println!("cargo:rerun-if-changed={}", path.display());
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                watch(&entry.path());
            }
        }
    }
    watch(Path::new("../../ui/dist"));
    tauri_build::build()
}
