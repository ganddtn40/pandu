//! Pandu's Tauri shell.
//!
//! The desktop build embeds the daemon and the bundled UI in one executable.
//! The Android build is a companion: it never starts a daemon and talks only to
//! a paired host over HTTPS.

mod shell;

#[cfg(desktop)]
mod desktop;

#[cfg(desktop)]
mod tray;

/// Start the Tauri application.
pub fn run() {
    init_logging();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    {
        builder = builder
            // The single-instance plugin's `deep-link` feature forwards a
            // `pandu://` argument from the second process to this one before
            // calling this closure, so opening a link while Pandu runs only
            // raises the window. The daemon stays single-writer.
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                desktop::show_main_window(app);
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ));
    }

    #[cfg(mobile)]
    {
        builder = builder
            .plugin(tauri_plugin_barcode_scanner::init())
            .plugin(tauri_plugin_biometric::init())
            .plugin(tauri_plugin_notification::init());
    }

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(pandu_plugin_keystore::init());
    }

    #[cfg(desktop)]
    {
        builder = builder.invoke_handler(tauri::generate_handler![
            desktop::desktop_info,
            desktop::confirm_open_external,
            desktop::take_deep_link,
            desktop::set_autostart,
        ]);
    }

    let app = builder
        .setup(|app| {
            #[cfg(desktop)]
            desktop::setup(app)?;
            #[cfg(not(desktop))]
            let _ = app;
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            panic!(
                "could not build the {} shell: {error}",
                pandu_core::brand::PRODUCT_NAME
            )
        });

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            #[cfg(desktop)]
            desktop::shutdown(app);
            #[cfg(not(desktop))]
            let _ = app;
        }
    });
}

fn init_logging() {
    use tracing_subscriber::EnvFilter;

    let filter = std::env::var(pandu_core::brand::env_name("LOG"))
        .ok()
        .and_then(|value| EnvFilter::try_new(value).ok())
        .unwrap_or_else(|| EnvFilter::new("pandu=info,pandu_app=info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}
