//! The Android side of the Pandu companion.
//!
//! The Rust half only registers the Kotlin plugin. Every command is implemented
//! in `android/src/main/java/.../KeystorePlugin.kt`, so the device token never
//! crosses into the webview's storage.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

const PLUGIN_NAME: &str = "keystore";

/// Initialize the plugin. Android is the only supported target; the desktop
/// shell does not need a device token.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN_NAME)
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                let _handle = api.register_android_plugin(
                    concat!(env!("PANDU_BRAND_ANDROID_PACKAGE"), ".keystore"),
                    "KeystorePlugin",
                )?;
            }
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}
