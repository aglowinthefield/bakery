#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use std::{path::PathBuf, sync::RwLock};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::{DownloadEvent, NewWindowResponse},
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct Connection {
    serial: tokio::sync::Mutex<()>,
    origin: RwLock<Option<url::Url>>,
}

fn remote_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("remote")
}

fn local_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "connection" {
        return Err("Only the local connection window can manage the server address.".into());
    }
    Ok(())
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("server-url"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn saved_server(window: WebviewWindow, app: tauri::AppHandle) -> Result<String, String> {
    local_only(&window)?;
    server::load(&settings_path(&app)?)
}

fn show_connection(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("connection") {
        if let Err(error) = window.show().and_then(|_| window.set_focus()) {
            eprintln!("Cannot show connection settings: {error}");
        }
    }
}

fn open_in_browser(app: &tauri::AppHandle, url: &url::Url) {
    if server::browser_url(url) {
        if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("Cannot open link in the browser: {error}");
            show_connection(app);
        }
    }
}

#[tauri::command]
async fn connect(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, Connection>,
    address: String,
    allow_http: bool,
) -> Result<(), String> {
    local_only(&window)?;
    let _connecting = state
        .serial
        .try_lock()
        .map_err(|_| "A connection is already in progress.".to_string())?;
    let url = server::server_url(&address, allow_http)?;
    server::probe(&url).await?;
    server::save(&settings_path(&app)?, &url)?;
    let previous = state
        .origin
        .write()
        .map_err(|error| error.to_string())?
        .replace(url.clone());
    let result = if let Some(remote) = remote_window(&app) {
        remote
            .navigate(url)
            .map(|_| remote)
            .map_err(|error| error.to_string())
    } else {
        create_remote(&app, url)
    };
    let remote = match result {
        Ok(remote) => remote,
        Err(error) => {
            *state.origin.write().map_err(|error| error.to_string())? = previous;
            return Err(error);
        }
    };
    remote
        .show()
        .and_then(|_| remote.set_focus())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn create_remote(app: &tauri::AppHandle, url: url::Url) -> Result<WebviewWindow, String> {
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let download_app = app.clone();
    let remote = WebviewWindowBuilder::new(app, "remote", WebviewUrl::External(url))
        .title("Bakery")
        // Keep HTML5 card dragging and file drops available in WebView2.
        .disable_drag_drop_handler()
        // GTK download handlers belong to their WebContext, not their window.
        // Keep one remote window and isolate its context from the launcher.
        .data_directory(
            app.path()
                .app_data_dir()
                .map_err(|error| error.to_string())?
                .join("remote"),
        )
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 480.0)
        .on_navigation(move |target| {
            let allowed = navigation_app
                .state::<Connection>()
                .origin
                .read()
                .ok()
                .and_then(|origin| {
                    origin
                        .as_ref()
                        .map(|origin| server::same_origin(origin, target))
                })
                .unwrap_or(false);
            if allowed {
                true
            } else {
                open_in_browser(&navigation_app, target);
                false
            }
        })
        .on_new_window(move |target, _| {
            open_in_browser(&popup_app, &target);
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                open_in_browser(&download_app, &url);
            }
            false
        })
        .build()
        .map_err(|error| format!("Cannot open the Bakery window: {error}"))?;
    let close_app = app.clone();
    remote.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = remote_window(&close_app) {
                if let Err(error) = window.hide() {
                    eprintln!("Cannot hide Bakery: {error}");
                }
            }
            show_connection(&close_app);
        }
    });
    Ok(remote)
}

fn main() {
    tauri::Builder::default()
        .manage(Connection::default())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![saved_server, connect])
        .setup(|app| {
            let connection =
                WebviewWindowBuilder::new(app, "connection", WebviewUrl::App("index.html".into()))
                    .title("Connect to Bakery")
                    .inner_size(620.0, 620.0)
                    .min_inner_size(420.0, 560.0)
                    // The privileged window must never become a remote browser.
                    .on_navigation(server::connection_page)
                    .on_new_window(|_, _| NewWindowResponse::Deny)
                    .build()?;
            let handle = app.handle().clone();
            connection.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if remote_window(&handle)
                        .and_then(|window| window.is_visible().ok())
                        .unwrap_or(false)
                    {
                        api.prevent_close();
                        if let Some(window) = handle.get_webview_window("connection") {
                            if let Err(error) = window.hide() {
                                eprintln!("Cannot hide connection settings: {error}");
                            }
                        }
                    } else {
                        handle.exit(0);
                    }
                }
            });
            let settings = MenuItem::with_id(
                app,
                "connection",
                "Connection settings…",
                true,
                Some("CmdOrCtrl+,"),
            )?;
            let reload =
                MenuItem::with_id(app, "reload", "Reload Bakery", true, Some("CmdOrCtrl+R"))?;
            let browser =
                MenuItem::with_id(app, "browser", "Open Bakery in browser", true, None::<&str>)?;
            let bakery = Submenu::with_items(
                app,
                "Bakery",
                true,
                &[
                    &settings,
                    &reload,
                    &browser,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let edit = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&bakery, &edit])?)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "connection" => show_connection(app),
                "reload" => {
                    if let Some(window) = remote_window(app) {
                        if let Err(error) = window.reload() {
                            eprintln!("Cannot reload Bakery: {error}");
                            show_connection(app);
                        }
                    }
                }
                "browser" => {
                    if let Some(window) = remote_window(app) {
                        if let Ok(url) = window.url() {
                            open_in_browser(app, &url);
                        }
                    }
                }
                _ => {}
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Bakery desktop failed to start");
}
