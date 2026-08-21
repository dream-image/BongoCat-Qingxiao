use std::{
    fs::{self, canonicalize},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, command};

const MAX_IMPORT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_IMPORT_ENTRIES: usize = 10_000;
const MAX_IMPORT_DEPTH: usize = 32;

#[derive(Default)]
struct ImportUsage {
    bytes: u64,
    entries: usize,
}

#[command]
pub async fn import_model_directory(
    app: AppHandle,
    from_path: String,
    model_id: String,
) -> Result<String, String> {
    validate_model_id(&model_id)?;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(from_path);
        let source_metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("Failed to inspect model directory: {error}"))?;

        if is_link_or_reparse_point(&source_metadata) || !source_metadata.is_dir() {
            return Err("Model import source must be a real directory".to_string());
        }

        let source = canonicalize(source)
            .map_err(|error| format!("Failed to resolve model directory: {error}"))?;
        let import_root = app_data_dir.join("custom-models");
        fs::create_dir_all(&import_root)
            .map_err(|error| format!("Failed to create model import directory: {error}"))?;

        let target = import_root.join(model_id);

        if target.exists() {
            return Err("Model import destination already exists".to_string());
        }
        if target.starts_with(&source) {
            return Err(
                "Model import destination cannot be inside its source directory".to_string(),
            );
        }

        fs::create_dir(&target)
            .map_err(|error| format!("Failed to create model import destination: {error}"))?;

        let result = copy_model_directory(&source, &target, 0, &mut ImportUsage::default());

        if let Err(error) = result {
            let _ = fs::remove_dir_all(&target);
            return Err(error);
        }

        target
            .into_os_string()
            .into_string()
            .map_err(|_| "Model import path must be valid UTF-8".to_string())
    })
    .await
    .map_err(|error| format!("Failed to import model: {error}"))?
}

fn validate_model_id(model_id: &str) -> Result<(), String> {
    if model_id.is_empty()
        || model_id.len() > 64
        || !model_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Model id contains invalid characters".to_string());
    }

    Ok(())
}

fn copy_model_directory(
    source: &Path,
    target: &Path,
    depth: usize,
    usage: &mut ImportUsage,
) -> Result<(), String> {
    if depth > MAX_IMPORT_DEPTH {
        return Err(format!(
            "Model import exceeds maximum depth of {MAX_IMPORT_DEPTH}"
        ));
    }

    let entries = fs::read_dir(source)
        .map_err(|error| format!("Failed to read {}: {error}", source.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("Failed to inspect {}: {error}", source_path.display()))?;

        usage.entries += 1;

        if usage.entries > MAX_IMPORT_ENTRIES {
            return Err(format!(
                "Model import exceeds maximum entry count of {MAX_IMPORT_ENTRIES}"
            ));
        }
        if is_link_or_reparse_point(&metadata) {
            return Err(format!(
                "Model import cannot contain links: {}",
                source_path.display()
            ));
        }

        if metadata.is_dir() {
            fs::create_dir(&target_path)
                .map_err(|error| format!("Failed to create {}: {error}", target_path.display()))?;
            copy_model_directory(&source_path, &target_path, depth + 1, usage)?;
        } else if metadata.is_file() {
            usage.bytes = usage
                .bytes
                .checked_add(metadata.len())
                .ok_or_else(|| "Model import size overflow".to_string())?;

            if usage.bytes > MAX_IMPORT_BYTES {
                return Err("Model import exceeds maximum size of 512 MiB".to_string());
            }

            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("Failed to copy {}: {error}", source_path.display()))?;
        } else {
            return Err(format!(
                "Model import contains an unsupported entry: {}",
                source_path.display()
            ));
        }
    }

    Ok(())
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[command]
pub async fn resolve_model_resource_path(
    model_path: String,
    resource_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonicalize(&model_path)
            .map_err(|error| format!("Failed to resolve model directory: {error}"))?;

        if !root.is_dir() {
            return Err("Model path must be a directory".to_string());
        }

        let normalized = normalize_model_resource_path(&resource_path)?;
        let candidate = canonicalize(root.join(normalized))
            .map_err(|error| format!("Failed to resolve model resource: {error}"))?;

        if !candidate.starts_with(&root) {
            return Err("Model resource resolves outside the model directory".to_string());
        }
        if !candidate.is_file() {
            return Err("Model resource must be a file".to_string());
        }

        candidate
            .into_os_string()
            .into_string()
            .map_err(|_| "Model resource path must be valid UTF-8".to_string())
    })
    .await
    .map_err(|error| format!("Failed to validate model resource: {error}"))?
}

fn normalize_model_resource_path(resource_path: &str) -> Result<PathBuf, String> {
    let without_legacy_prefix = resource_path
        .strip_prefix("./")
        .or_else(|| resource_path.strip_prefix(".\\"))
        .unwrap_or(resource_path);

    if without_legacy_prefix.is_empty()
        || without_legacy_prefix.starts_with(['/', '\\'])
        || has_uri_scheme(without_legacy_prefix)
    {
        return Err("Model resource path must be relative and cannot use a protocol".to_string());
    }

    let segments = without_legacy_prefix.split(['/', '\\']).collect::<Vec<_>>();

    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err("Model resource path must contain only relative path segments".to_string());
    }

    Ok(segments.iter().collect())
}

fn has_uri_scheme(path: &str) -> bool {
    let Some(colon_index) = path.find(':') else {
        return false;
    };
    let scheme = &path[..colon_index];
    let mut characters = scheme.chars();

    matches!(characters.next(), Some(first) if first.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
}
