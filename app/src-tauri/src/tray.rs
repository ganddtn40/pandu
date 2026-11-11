//! Tray icon and menu. Closing the window hides it; the tray is the only place
//! that quits the recorder.

use tauri::AppHandle;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_autostart::ManagerExt as _;

use pandu_core::brand;

use crate::desktop::show_main_window;

pub fn create(app: &tauri::App) -> tauri::Result<CheckMenuItem<tauri::Wry>> {
    let open = MenuItem::with_id(
        app,
        "show",
        format!("Open {}", brand::PRODUCT_NAME),
        true,
        None::<&str>,
    )?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        format!("Start {} with Windows", brand::PRODUCT_NAME),
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        format!("Quit {}", brand::PRODUCT_NAME),
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &autostart, &separator, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("the app icon is missing".into()))?;
    let autostart_for_menu = autostart.clone();

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip(brand::PRODUCT_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "autostart" => toggle_autostart(app, &autostart_for_menu),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(autostart)
}

fn toggle_autostart(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);
    let next = if enabled {
        manager.disable()
    } else {
        manager.enable()
    };
    match next {
        Ok(()) => {
            let _ = item.set_checked(manager.is_enabled().unwrap_or(!enabled));
        }
        Err(error) => {
            tracing::warn!(%error, "could not change the autostart setting");
            let _ = item.set_checked(enabled);
        }
    }
}
