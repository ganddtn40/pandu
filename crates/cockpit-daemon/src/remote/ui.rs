//! Dashboard files for the remote listener.
//!
//! `ui/dist` is a build artifact and stays out of git, so the daemon reads it
//! from disk at runtime. If the UI has not been built, a small placeholder is
//! served instead of failing to start.

use std::path::Path;

use axum::Router;
use axum::routing::get;
use tower_http::services::{ServeDir, ServeFile};

use crate::ui as placeholder;

pub fn router(ui_dir: &Path) -> Router {
    let index = ui_dir.join("index.html");
    if index.is_file() {
        let files = ServeDir::new(ui_dir).fallback(ServeFile::new(index));
        Router::new().fallback_service(files)
    } else {
        Router::new()
            .route("/", get(placeholder::index))
            .route("/index.html", get(placeholder::index))
            .fallback(get(placeholder::index))
    }
}
