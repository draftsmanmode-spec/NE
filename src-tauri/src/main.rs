// Windows release builds: no console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use tauri_plugin_dialog::DialogExt;

/// Show the native Save dialog and write the generated PDF to whatever path the
/// user picks. The bytes arrive base64-encoded because a multi-megabyte
/// `Vec<u8>` serialised as a JSON array of numbers is enormously slower.
///
/// Returns the chosen path, or `None` when the user cancels.
#[tauri::command]
fn save_pdf(
    app: tauri::AppHandle,
    default_name: String,
    data_b64: String,
) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("could not decode PDF payload: {e}"))?;

    // This command runs on a worker thread, so blocking here does not stall the
    // UI thread.
    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("PDF document", &["pdf"])
        .blocking_save_file();

    let Some(path) = picked else { return Ok(None) };

    let path = path
        .into_path()
        .map_err(|e| format!("unusable save location: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_pdf])
        .run(tauri::generate_context!())
        .expect("error while running Sheet Nesting Estimator");
}
