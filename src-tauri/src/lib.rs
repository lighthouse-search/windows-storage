use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use sysinfo::Disks;

#[derive(Serialize, Deserialize, Clone)]
pub struct FsEntry {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    item_count: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DriveInfo {
    name: String,
    mount_point: String,
    total_space: u64,
    available_space: u64,
    used_space: u64,
    file_system: String,
}

#[derive(Serialize, Deserialize)]
pub struct FolderSize {
    size: u64,
    item_count: u64,
}

/// Recursively calculates (total_bytes, item_count).
/// Silently skips entries we can't access. Does not follow symlinks.
fn calc_size(path: &Path) -> (u64, u64) {
    let Ok(read_dir) = fs::read_dir(path) else {
        return (0, 0);
    };
    let mut total_size = 0u64;
    let mut total_count = 0u64;
    for entry in read_dir.flatten() {
        let entry_path = entry.path();
        let Ok(meta) = entry_path.symlink_metadata() else {
            continue;
        };
        total_count += 1;
        if meta.is_dir() {
            let (s, c) = calc_size(&entry_path);
            total_size += s;
            total_count += c;
        } else if meta.is_file() {
            total_size += meta.len();
        }
    }
    (total_size, total_count)
}

/// Returns the number of direct children without recursing.
fn direct_child_count(path: &Path) -> u64 {
    fs::read_dir(path)
        .map(|rd| rd.count() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn get_drives() -> Vec<DriveInfo> {
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .map(|d| {
            let used = d.total_space().saturating_sub(d.available_space());
            DriveInfo {
                name: d.name().to_string_lossy().to_string(),
                mount_point: d.mount_point().to_string_lossy().to_string(),
                total_space: d.total_space(),
                available_space: d.available_space(),
                used_space: used,
                file_system: d.file_system().to_string_lossy().to_string(),
            }
        })
        .collect()
}

/// PHASE 1 — Fast, non-recursive scan. Returns entries almost instantly.
/// Files get their real size. Folders get size=0 and direct child count only.
/// The frontend then requests folder sizes individually via get_folder_size.
#[tauri::command]
fn scan_directory_fast(path: String) -> Result<Vec<FsEntry>, String> {
    let dir = Path::new(&path);
    let read_dir = fs::read_dir(dir).map_err(|e| format!("{e}"))?;

    let mut entries: Vec<FsEntry> = read_dir
        .flatten()
        .filter_map(|entry| {
            let entry_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(meta) = entry_path.symlink_metadata() else {
                return None;
            };
            let is_dir = meta.is_dir();
            let (size, item_count) = if is_dir {
                (0, direct_child_count(&entry_path))
            } else if meta.is_file() {
                (meta.len(), 0)
            } else {
                return None; // skip symlinks / junctions
            };
            Some(FsEntry {
                name,
                path: entry_path.to_string_lossy().to_string(),
                size,
                is_dir,
                item_count,
            })
        })
        .collect();

    // Stable initial order: folders first, then alphabetical
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// PHASE 2 — Recursive size for a single folder. Called concurrently per folder
/// from the frontend. Runs on a blocking thread so it never freezes the UI.
#[tauri::command]
async fn get_folder_size(path: String) -> Result<FolderSize, String> {
    tokio::task::spawn_blocking(move || {
        let (size, item_count) = calc_size(Path::new(&path));
        Ok(FolderSize { size, item_count })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_drives,
            scan_directory_fast,
            get_folder_size
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
