use std::{
    fs::{canonicalize, create_dir_all, symlink_metadata},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager, command};

// 当前内置模型最大约 13 MiB、75 个文件、4 层目录；这些上限留有充足余量，同时阻止恶意导入耗尽磁盘。
const MAX_MODEL_IMPORT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MODEL_IMPORT_ENTRIES: u64 = 10_000;
const MAX_MODEL_IMPORT_DEPTH: usize = 32;
const CUSTOM_MODELS_DIRECTORY: &str = "custom-models";

#[derive(Default)]
struct ImportBudget {
    total_bytes: u64,
    entry_count: u64,
}

impl ImportBudget {
    fn reserve_entry(&mut self, regular_file_bytes: Option<u64>) -> Result<(), String> {
        let entry_count = self
            .entry_count
            .checked_add(1)
            .ok_or_else(|| "Model import entry count overflowed".to_string())?;
        let total_bytes = self
            .total_bytes
            .checked_add(regular_file_bytes.unwrap_or(0))
            .ok_or_else(|| "Model import size overflowed".to_string())?;

        if entry_count > MAX_MODEL_IMPORT_ENTRIES {
            return Err(format!(
                "Model import exceeds the {MAX_MODEL_IMPORT_ENTRIES} entry limit"
            ));
        }
        if total_bytes > MAX_MODEL_IMPORT_BYTES {
            return Err(format!(
                "Model import exceeds the {} MiB size limit",
                MAX_MODEL_IMPORT_BYTES / 1024 / 1024
            ));
        }

        self.entry_count = entry_count;
        self.total_bytes = total_bytes;

        Ok(())
    }
}

fn validate_model_id(model_id: &str) -> Result<(), String> {
    if model_id.is_empty()
        || model_id.len() > 64
        || !model_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(
            "Model id must contain 1-64 ASCII letters, digits, hyphens, or underscores".to_string(),
        );
    }

    Ok(())
}

fn copy_file_with_expected_size(
    source: &mut impl Read,
    target: &mut impl Write,
    expected_size: u64,
) -> Result<(), String> {
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    while copied < expected_size {
        let remaining = expected_size - copied;
        let read_limit = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| "Model import size is unsupported on this platform".to_string())?;
        let read = source
            .read(&mut buffer[..read_limit])
            .map_err(|error| format!("Failed to read model file: {error}"))?;

        if read == 0 {
            return Err("Model import source file shrank while copying".to_string());
        }

        target
            .write_all(&buffer[..read])
            .map_err(|error| format!("Failed to write model file: {error}"))?;
        copied = copied
            .checked_add(read as u64)
            .ok_or_else(|| "Model import size overflowed".to_string())?;
    }

    // 只多读一个字节即可发现增长；超预算内容永远不会写入目标文件。
    if source
        .read(&mut buffer[..1])
        .map_err(|error| format!("Failed to verify model file size: {error}"))?
        != 0
    {
        return Err("Model import source file grew while copying".to_string());
    }

    Ok(())
}

#[command]
pub async fn import_model_directory(
    app_handle: AppHandle,
    from_path: String,
    model_id: String,
) -> Result<String, String> {
    validate_model_id(&model_id)?;

    // 目标根目录只能来自当前应用的 PathResolver，前端无法再把复制命令指向任意位置。
    let app_data_root = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    // 大模型复制是阻塞 I/O；放入 blocking 池，避免占住 Tauri 异步命令执行线程拖慢窗口交互。
    let actual_destination = tauri::async_runtime::spawn_blocking(move || {
        copy_model_directory_tree(Path::new(&from_path), &app_data_root, Path::new(&model_id))
    })
    .await
    .map_err(|error| format!("Failed to import model: {error}"))??;

    actual_destination
        .into_os_string()
        .into_string()
        .map_err(|_| "Model import destination must be valid UTF-8".to_string())
}

#[cfg(unix)]
fn copy_model_directory_tree(
    source_input: &Path,
    app_data_root: &Path,
    target_name: &Path,
) -> Result<PathBuf, String> {
    use rustix::fs::{AtFlags, Mode, mkdirat, openat, unlinkat};

    // 顶层先拒绝 symlink，再把 canonical 路径逐层打开成 dirfd；后续复制不再信任可变的路径字符串。
    let source_metadata = symlink_metadata(source_input).map_err(|error| error.to_string())?;

    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err("Model import source must be a real directory".to_string());
    }

    let source_root = canonicalize(source_input)
        .map_err(|error| format!("Failed to resolve model import source: {error}"))?;
    let source_root_fd = open_canonical_directory(&source_root)?;
    create_dir_all(app_data_root).map_err(|error| error.to_string())?;
    let resolved_app_data = canonicalize(app_data_root)
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let app_data_fd = open_canonical_directory(&resolved_app_data)?;
    let target_parent_fd = open_or_create_custom_models_directory(&app_data_fd)?;
    let target_parent = resolved_app_data.join(CUSTOM_MODELS_DIRECTORY);
    let actual_target = target_parent.join(target_name);

    // custom-models 必须是 canonical app_data 句柄下的真实子目录，预存 symlink 无法被 openat + NOFOLLOW 接受。
    if actual_target.starts_with(&source_root) {
        return Err("Model import destination cannot be inside its source directory".to_string());
    }

    let mut budget = ImportBudget::default();
    budget.reserve_entry(None)?;

    // mkdirat 绑定到已打开的父目录；即使路径名随后被换链，也不会把导入写到另一个目录树。
    mkdirat(
        &target_parent_fd,
        target_name.as_os_str(),
        Mode::from(0o700),
    )
    .map_err(|error| {
        format!(
            "Model import destination must not already exist ({}): {error}",
            actual_target.display()
        )
    })?;

    let target_root_fd = match openat(
        &target_parent_fd,
        target_name.as_os_str(),
        directory_open_flags(),
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(error) => {
            let _ = unlinkat(
                &target_parent_fd,
                target_name.as_os_str(),
                AtFlags::REMOVEDIR,
            );

            return Err(format!("Failed to safely open import destination: {error}"));
        }
    };

    if let Err(error) = copy_directory_at(
        &source_root_fd,
        &target_root_fd,
        &source_root,
        &mut budget,
        0,
    ) {
        // 清理同样沿已打开的目录 fd 操作，避免失败回滚时跟随被替换的父路径。
        let cleanup_result = remove_directory_contents_at(&target_root_fd).and_then(|()| {
            unlinkat(
                &target_parent_fd,
                target_name.as_os_str(),
                AtFlags::REMOVEDIR,
            )
            .map_err(|cleanup_error| cleanup_error.to_string())
        });

        return match cleanup_result {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; failed to remove incomplete import {}: {cleanup_error}",
                actual_target.display()
            )),
        };
    }

    Ok(actual_target)
}

#[cfg(unix)]
fn open_or_create_custom_models_directory(
    app_data_fd: &std::os::fd::OwnedFd,
) -> Result<std::os::fd::OwnedFd, String> {
    use rustix::fs::{Mode, mkdirat, openat};

    let directory_name = Path::new(CUSTOM_MODELS_DIRECTORY);

    if let Ok(directory) = openat(
        app_data_fd,
        directory_name,
        directory_open_flags(),
        Mode::empty(),
    ) {
        return Ok(directory);
    }

    let create_error = mkdirat(app_data_fd, directory_name, Mode::from(0o700)).err();

    openat(
        app_data_fd,
        directory_name,
        directory_open_flags(),
        Mode::empty(),
    )
    .map_err(|open_error| match create_error {
        Some(create_error) => format!(
            "Failed to create or safely open custom model directory: {create_error}; {open_error}"
        ),
        None => format!("Failed to safely open custom model directory: {open_error}"),
    })
}

#[cfg(unix)]
fn directory_open_flags() -> rustix::fs::OFlags {
    use rustix::fs::OFlags;

    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
}

#[cfg(unix)]
fn open_canonical_directory(path: &Path) -> Result<std::os::fd::OwnedFd, String> {
    use rustix::fs::{CWD, Mode, openat};

    if !path.is_absolute() {
        return Err(format!(
            "Expected an absolute directory path: {}",
            path.display()
        ));
    }

    let mut directory = openat(CWD, Path::new("/"), directory_open_flags(), Mode::empty())
        .map_err(|error| format!("Failed to open filesystem root: {error}"))?;

    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                // canonicalize 给出无链接的绝对组件，再逐层 openat + NOFOLLOW，关闭祖先换链窗口。
                directory = openat(&directory, name, directory_open_flags(), Mode::empty())
                    .map_err(|error| {
                        format!(
                            "Failed to safely open directory {}: {error}",
                            path.display()
                        )
                    })?;
            }
            _ => {
                return Err(format!(
                    "Canonical directory contains an invalid component: {}",
                    path.display()
                ));
            }
        }
    }

    Ok(directory)
}

#[cfg(unix)]
fn copy_directory_at(
    source_directory: &std::os::fd::OwnedFd,
    target_directory: &std::os::fd::OwnedFd,
    display_path: &Path,
    budget: &mut ImportBudget,
    depth: usize,
) -> Result<(), String> {
    use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, fstat, mkdirat, openat, statat};
    use std::fs::File;

    let mut entries = Dir::read_from(source_directory)
        .map_err(|error| format!("Failed to read {}: {error}", display_path.display()))?;

    while let Some(entry) = entries.read() {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();

        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }

        let source_stat = statat(source_directory, name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|error| format!("Failed to inspect model import entry: {error}"))?;
        let entry_type = FileType::from_raw_mode(source_stat.st_mode);

        match entry_type {
            FileType::Directory => {
                budget.reserve_entry(None)?;
                let child_depth = depth
                    .checked_add(1)
                    .ok_or_else(|| "Model import directory depth overflowed".to_string())?;

                if child_depth > MAX_MODEL_IMPORT_DEPTH {
                    return Err(format!(
                        "Model import exceeds the {MAX_MODEL_IMPORT_DEPTH} directory depth limit"
                    ));
                }

                // 分类之后仍只用同一个父 fd 打开，并以 NOFOLLOW 原子拒绝竞态替换成的链接。
                let source_child = openat(
                    source_directory,
                    name,
                    directory_open_flags(),
                    Mode::empty(),
                )
                .map_err(|error| format!("Failed to safely open model directory: {error}"))?;

                if FileType::from_raw_mode(
                    fstat(&source_child)
                        .map_err(|error| error.to_string())?
                        .st_mode,
                ) != FileType::Directory
                {
                    return Err("Model import source changed while copying".to_string());
                }

                mkdirat(target_directory, name, Mode::from(0o700))
                    .map_err(|error| format!("Failed to create model directory: {error}"))?;
                let target_child = openat(
                    target_directory,
                    name,
                    directory_open_flags(),
                    Mode::empty(),
                )
                .map_err(|error| format!("Failed to open new model directory: {error}"))?;

                copy_directory_at(
                    &source_child,
                    &target_child,
                    &display_path.join(name.to_string_lossy().as_ref()),
                    budget,
                    child_depth,
                )?;
            }
            FileType::RegularFile => {
                // NONBLOCK 防止 statat 后条目被换成 FIFO/设备时 open 阻塞；随后 fstat 再确认确为普通文件。
                let source_fd = openat(
                    source_directory,
                    name,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                    Mode::empty(),
                )
                .map_err(|error| format!("Failed to safely open model file: {error}"))?;

                let source_stat = fstat(&source_fd).map_err(|error| error.to_string())?;

                if FileType::from_raw_mode(source_stat.st_mode) != FileType::RegularFile {
                    return Err("Model import source changed while copying".to_string());
                }

                let expected_size = u64::try_from(source_stat.st_size)
                    .map_err(|_| "Model import file size cannot be negative".to_string())?;

                // 预算依据已持有且 NOFOLLOW 打开的文件描述符计算，路径替换和复制期间增长都不能绕过上限。
                budget.reserve_entry(Some(expected_size))?;

                let target_fd = openat(
                    target_directory,
                    name,
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC,
                    Mode::from(0o600),
                )
                .map_err(|error| format!("Failed to create model file: {error}"))?;
                let mut source_file = File::from(source_fd);
                let mut target_file = File::from(target_fd);

                copy_file_with_expected_size(&mut source_file, &mut target_file, expected_size)?;

                let final_size = u64::try_from(
                    fstat(&source_file)
                        .map_err(|error| error.to_string())?
                        .st_size,
                )
                .map_err(|_| "Model import file size cannot be negative".to_string())?;

                if final_size != expected_size {
                    return Err("Model import source file changed while copying".to_string());
                }
            }
            FileType::Symlink => {
                return Err("Model import cannot contain symbolic links".to_string());
            }
            _ => {
                return Err("Model import contains an unsupported filesystem entry".to_string());
            }
        }
    }

    Ok(())
}

#[cfg(unix)]
fn remove_directory_contents_at(directory: &std::os::fd::OwnedFd) -> Result<(), String> {
    use rustix::fs::{AtFlags, Dir, FileType, Mode, openat, statat, unlinkat};

    let mut entries = Dir::read_from(directory).map_err(|error| error.to_string())?;

    while let Some(entry) = entries.read() {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();

        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }

        let stat = statat(directory, name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|error| error.to_string())?;

        if FileType::from_raw_mode(stat.st_mode) == FileType::Directory {
            let child = openat(directory, name, directory_open_flags(), Mode::empty())
                .map_err(|error| error.to_string())?;

            remove_directory_contents_at(&child)?;
            unlinkat(directory, name, AtFlags::REMOVEDIR).map_err(|error| error.to_string())?;
        } else {
            // 回滚只 unlink 条目本身，不打开或跟随链接及其他特殊节点。
            unlinkat(directory, name, AtFlags::empty()).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[cfg(windows)]
fn copy_model_directory_tree(
    source_input: &Path,
    app_data_root: &Path,
    target_name: &Path,
) -> Result<PathBuf, String> {
    use std::fs::create_dir;

    // Windows 的 symlink、junction、mount point 都属于 reparse point；只拒绝 symlink 会留下同类越界入口。
    let source_metadata = symlink_metadata(source_input).map_err(|error| error.to_string())?;

    if is_windows_reparse_point(&source_metadata) || !source_metadata.is_dir() {
        return Err("Model import source must be a real directory".to_string());
    }

    let source_root = canonicalize(source_input)
        .map_err(|error| format!("Failed to resolve model import source: {error}"))?;
    create_dir_all(app_data_root).map_err(|error| error.to_string())?;
    let resolved_app_data = canonicalize(app_data_root)
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let app_data_handle = open_windows_locked_directory(&resolved_app_data, false)?;
    let app_data_metadata = app_data_handle
        .metadata()
        .map_err(|error| error.to_string())?;

    if is_windows_reparse_point(&app_data_metadata) || !app_data_metadata.is_dir() {
        return Err("App data root must be a real directory".to_string());
    }

    assert_windows_handle_is_path(&app_data_handle, &resolved_app_data)?;

    let resolved_parent = resolved_app_data.join(CUSTOM_MODELS_DIRECTORY);

    match create_dir(&resolved_parent) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "Failed to create custom model directory {}: {error}",
                resolved_parent.display()
            ));
        }
    }

    let custom_root_handle = open_windows_locked_directory(&resolved_parent, false)?;
    let custom_root_metadata = custom_root_handle
        .metadata()
        .map_err(|error| error.to_string())?;

    if is_windows_reparse_point(&custom_root_metadata) || !custom_root_metadata.is_dir() {
        return Err("Custom model root must be a real directory".to_string());
    }

    // 不 canonicalize custom-models；它必须以真实句柄精确落在 canonical app_data 的直接子路径。
    assert_windows_handle_is_path(&custom_root_handle, &resolved_parent)?;

    let resolved_target = resolved_parent.join(target_name);

    // 创建目标前拒绝其落入源树，否则导入 custom-models 本身会把新 UUID 再当源目录递归复制。
    if windows_path_starts_with(&resolved_target, &source_root) {
        return Err("Model import destination cannot be inside its source directory".to_string());
    }

    let mut budget = ImportBudget::default();
    budget.reserve_entry(None)?;

    create_dir(&resolved_target).map_err(|error| {
        format!(
            "Model import destination must not already exist ({}): {error}",
            resolved_target.display()
        )
    })?;

    let target_root_handle = match open_windows_locked_directory(&resolved_target, true) {
        Ok(handle) => handle,
        Err(error) => {
            return Err(format!(
                "Failed to safely open new model destination: {error}; incomplete directory may remain at {}",
                resolved_target.display()
            ));
        }
    };
    let target_metadata = target_root_handle
        .metadata()
        .map_err(|error| {
            format!(
                "Failed to verify new model destination: {error}; incomplete directory may remain at {}",
                resolved_target.display()
            )
        })?;

    if is_windows_reparse_point(&target_metadata) || !target_metadata.is_dir() {
        return Err(format!(
            "Model import destination changed after creation; incomplete directory may remain at {}",
            resolved_target.display()
        ));
    }

    assert_windows_handle_is_path(&target_root_handle, &resolved_target).map_err(|error| {
        format!(
            "{error}; incomplete directory may remain at {}",
            resolved_target.display()
        )
    })?;
    let actual_target = resolved_target;

    if let Err(error) = copy_model_directory_windows(
        &source_root,
        &source_root,
        &actual_target,
        &actual_target,
        &target_root_handle,
        &mut budget,
        0,
    ) {
        // 每个待删对象都以禁止换名的句柄复核归属后再标记删除；路径被替换时宁可残留，也不会越界清理。
        return match remove_owned_directory_windows(
            &target_root_handle,
            &resolved_parent,
            &actual_target,
        ) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; failed to remove incomplete import {}: {cleanup_error}",
                actual_target.display()
            )),
        };
    }

    Ok(actual_target)
}

#[cfg(windows)]
fn copy_model_directory_windows(
    source_root: &Path,
    source_directory: &Path,
    target_root: &Path,
    target_directory: &Path,
    target_directory_handle: &std::fs::File,
    budget: &mut ImportBudget,
    depth: usize,
) -> Result<(), String> {
    use std::fs::{create_dir, read_dir};

    // OPEN_REPARSE_POINT 让句柄指向条目本身；再查最终句柄路径，避免父 junction 在检查后被换链。
    let directory_handle = open_windows_source_directory(source_directory)?;
    let source_metadata = directory_handle
        .metadata()
        .map_err(|error| error.to_string())?;

    if is_windows_reparse_point(&source_metadata) || !source_metadata.is_dir() {
        return Err("Model import source changed while copying".to_string());
    }
    assert_windows_handle_in_root(&directory_handle, source_root)?;
    assert_windows_handle_in_root(target_directory_handle, target_root)?;

    for entry in read_dir(source_directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source = entry.path();
        let target = target_directory.join(entry.file_name());
        let metadata = symlink_metadata(&source).map_err(|error| error.to_string())?;

        if is_windows_reparse_point(&metadata) {
            return Err(format!(
                "Model import cannot contain reparse points: {}",
                source.display()
            ));
        }

        if metadata.is_dir() {
            budget.reserve_entry(None)?;
            let child_depth = depth
                .checked_add(1)
                .ok_or_else(|| "Model import directory depth overflowed".to_string())?;

            if child_depth > MAX_MODEL_IMPORT_DEPTH {
                return Err(format!(
                    "Model import exceeds the {MAX_MODEL_IMPORT_DEPTH} directory depth limit"
                ));
            }

            create_dir(&target).map_err(|error| error.to_string())?;
            let target_child_handle = open_windows_locked_directory(&target, true)?;
            let target_metadata = target_child_handle
                .metadata()
                .map_err(|error| error.to_string())?;

            if is_windows_reparse_point(&target_metadata) || !target_metadata.is_dir() {
                return Err("Model import destination changed while copying".to_string());
            }

            assert_windows_handle_in_root(&target_child_handle, target_root)?;
            copy_model_directory_windows(
                source_root,
                &source,
                target_root,
                &target,
                &target_child_handle,
                budget,
                child_depth,
            )?;
        } else if metadata.is_file() {
            copy_regular_file_windows(source_root, target_root, &source, &target, budget)?;
        } else {
            return Err(format!(
                "Model import contains an unsupported filesystem entry: {}",
                source.display()
            ));
        }
    }

    // 标准库 read_dir 不暴露其搜索句柄，所以遍历前后都复核我们持有的目录句柄；
    // 每个实际复制的文件也按句柄最终路径复核，父 junction 换链无法把外部文件写入目标。
    assert_windows_handle_in_root(&directory_handle, source_root)?;
    assert_windows_handle_in_root(target_directory_handle, target_root)
}

#[cfg(windows)]
fn copy_regular_file_windows(
    source_root: &Path,
    target_root: &Path,
    source: &Path,
    target: &Path,
    budget: &mut ImportBudget,
) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    // 先打开句柄、再从句柄读取 metadata 和最终路径；不能先 canonicalize 字符串再按同一字符串二次打开。
    let mut source_file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(source)
        .map_err(|error| format!("Failed to safely open {}: {error}", source.display()))?;
    let metadata = source_file.metadata().map_err(|error| error.to_string())?;

    if is_windows_reparse_point(&metadata) || !metadata.is_file() {
        return Err(format!(
            "Model import source changed while copying: {}",
            source.display()
        ));
    }

    assert_windows_handle_in_root(&source_file, source_root)?;
    let expected_size = metadata.len();

    // 文件数和字节数都取自已打开句柄；复制器严格只写 expected_size，增长或缩小都会失败并触发整树回滚。
    budget.reserve_entry(Some(expected_size))?;

    let mut target_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(target)
        .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
    let target_metadata = target_file.metadata().map_err(|error| error.to_string())?;

    if is_windows_reparse_point(&target_metadata) || !target_metadata.is_file() {
        return Err("Model import destination changed while copying".to_string());
    }

    assert_windows_handle_in_root(&target_file, target_root)?;
    copy_file_with_expected_size(&mut source_file, &mut target_file, expected_size)?;

    if source_file
        .metadata()
        .map_err(|error| error.to_string())?
        .len()
        != expected_size
    {
        return Err("Model import source file changed while copying".to_string());
    }

    assert_windows_handle_in_root(&source_file, source_root)?;
    assert_windows_handle_in_root(&target_file, target_root)?;

    Ok(())
}

#[cfg(windows)]
fn open_windows_source_directory(path: &Path) -> Result<std::fs::File, String> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    OpenOptions::new()
        .read(true)
        // 不共享 DELETE，可在句柄检查和遍历期间阻止目录被换名或替换。
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("Failed to safely open model directory: {error}"))
}

#[cfg(windows)]
fn open_windows_locked_directory(
    path: &Path,
    request_delete_access: bool,
) -> Result<std::fs::File, String> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_LIST_DIRECTORY: u32 = 0x0000_0001;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    let delete_access = if request_delete_access {
        DELETE_ACCESS
    } else {
        0
    };

    OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | delete_access)
        // 句柄存活期间禁止换名，保证后续 containment 检查与写入/回滚针对同一个对象。
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("Failed to safely open {}: {error}", path.display()))
}

#[cfg(windows)]
fn open_windows_entry_for_delete(path: &Path) -> Result<std::fs::File, String> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_LIST_DIRECTORY_OR_READ_DATA: u32 = 0x0000_0001;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY_OR_READ_DATA | FILE_READ_ATTRIBUTES | DELETE_ACCESS)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("Failed to open incomplete import entry: {error}"))
}

#[cfg(windows)]
fn remove_owned_directory_windows(
    directory_handle: &std::fs::File,
    custom_models_root: &Path,
    owned_target_root: &Path,
) -> Result<(), String> {
    use std::fs::read_dir;

    assert_windows_handle_in_root(directory_handle, custom_models_root)?;
    assert_windows_handle_in_root(directory_handle, owned_target_root)?;
    let directory_path = windows_final_path(directory_handle)?;

    {
        let entries = read_dir(&directory_path).map_err(|error| error.to_string())?;

        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let child_handle = open_windows_entry_for_delete(&entry.path())?;
            let metadata = child_handle.metadata().map_err(|error| error.to_string())?;

            assert_windows_handle_in_root(&child_handle, custom_models_root)?;
            assert_windows_handle_in_root(&child_handle, owned_target_root)?;

            if metadata.is_dir() && !is_windows_reparse_point(&metadata) {
                remove_owned_directory_windows(
                    &child_handle,
                    custom_models_root,
                    owned_target_root,
                )?;
            } else {
                delete_windows_handle(&child_handle, custom_models_root, owned_target_root)?;
            }
        }
    }

    delete_windows_handle(directory_handle, custom_models_root, owned_target_root)
}

#[cfg(windows)]
fn delete_windows_handle(
    file: &std::fs::File,
    custom_models_root: &Path,
    owned_target_root: &Path,
) -> Result<(), String> {
    use std::os::raw::c_void;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileDispositionInfo {
        delete_file: u8,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(
            file: *mut c_void,
            file_information_class: i32,
            file_information: *const c_void,
            buffer_size: u32,
        ) -> i32;
    }

    const FILE_DISPOSITION_INFO_CLASS: i32 = 4;
    let disposition = FileDispositionInfo { delete_file: 1 };

    // 删除前再次检查最终句柄路径；实际删除也作用于该句柄，不会重新解析可能已被替换的字符串路径。
    assert_windows_handle_in_root(file, custom_models_root)?;
    assert_windows_handle_in_root(file, owned_target_root)?;

    // SAFETY: file 句柄有效且以 DELETE 权限打开；结构布局对应 FILE_DISPOSITION_INFO。
    let succeeded = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FILE_DISPOSITION_INFO_CLASS,
            (&raw const disposition).cast(),
            std::mem::size_of::<FileDispositionInfo>() as u32,
        )
    };

    if succeeded == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    Ok(())
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(windows)]
fn assert_windows_handle_in_root(file: &std::fs::File, source_root: &Path) -> Result<(), String> {
    let final_path = windows_final_path(file)?;

    if !windows_path_starts_with(&final_path, source_root) {
        return Err(format!(
            "Model import handle resolves outside its permitted root: {}",
            final_path.display()
        ));
    }

    Ok(())
}

#[cfg(windows)]
fn assert_windows_handle_is_path(file: &std::fs::File, expected: &Path) -> Result<(), String> {
    let final_path = windows_final_path(file)?;

    if !windows_paths_equal(&final_path, expected) {
        return Err(format!(
            "Model import handle resolved to an unexpected directory: {}",
            final_path.display()
        ));
    }

    Ok(())
}

#[cfg(windows)]
fn windows_final_path(file: &std::fs::File) -> Result<PathBuf, String> {
    use std::ffi::OsString;
    use std::os::raw::c_void;
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            file: *mut c_void,
            path: *mut u16,
            path_length: u32,
            flags: u32,
        ) -> u32;
    }

    let mut buffer = vec![0_u16; 512];

    loop {
        // 这里只读取已打开句柄的内核最终路径，不再按可被换链的字符串路径重新解析。
        // SAFETY: `file` 在调用期间保持打开；`buffer` 可写，传入长度与其容量完全一致。
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };

        if length == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if (length as usize) < buffer.len() {
            buffer.truncate(length as usize);

            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }

        buffer.resize(length as usize + 1, 0);
    }
}

#[cfg(windows)]
fn windows_path_starts_with(candidate: &Path, root: &Path) -> bool {
    // Windows containment 必须按路径组件并忽略大小写比较；字符串前缀会误把 `model-evil` 当作 `model` 子项。
    let candidate = candidate
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
        .collect::<Vec<_>>();
    let root = root
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
        .collect::<Vec<_>>();

    candidate.starts_with(&root)
}

#[cfg(windows)]
fn windows_paths_equal(left: &Path, right: &Path) -> bool {
    windows_path_starts_with(left, right) && windows_path_starts_with(right, left)
}

#[cfg(not(any(unix, windows)))]
fn copy_model_directory_tree(
    _source_input: &Path,
    _app_data_root: &Path,
    _target_name: &Path,
) -> Result<PathBuf, String> {
    Err("Secure model import is unsupported on this platform".to_string())
}

#[command]
pub async fn resolve_model_resource_path(
    model_path: String,
    resource_path: String,
) -> Result<String, String> {
    // canonicalize 会访问磁盘，放到 blocking 池避免第三方模型包含大量资源时阻塞异步命令线程。
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonicalize(&model_path)
            .map_err(|error| format!("Failed to resolve model directory: {error}"))?;

        if !root.is_dir() {
            return Err("Model path must be a directory".to_string());
        }

        let normalized = normalize_model_resource_path(&resource_path)?;
        let candidate = canonicalize(root.join(normalized))
            .map_err(|error| format!("Failed to resolve model resource: {error}"))?;

        // canonicalize 后再比较组件，既允许指向模型内部的链接，也拒绝任意层级的链接越界。
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
    // 模型 JSON 只允许相对资源名；协议、盘符、空段和父级跳转都必须在触盘前被拒绝。
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

    // 仅兼容历史配置开头的单个 ./；其余空段、. 和 .. 继续拒绝，避免宽松规范化掩盖越界意图。
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err("Model resource path must contain only relative path segments".to_string());
    }

    Ok(segments.iter().collect())
}

fn has_uri_scheme(path: &str) -> bool {
    // 按 URI scheme 语法判断而非只搜 :，同时会把 Windows 的 C: 视为绝对来源并拒绝。
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
