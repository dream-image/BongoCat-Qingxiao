use std::{
    fs::{canonicalize, create_dir_all, symlink_metadata},
    path::{Component, Path, PathBuf},
};
use tauri::command;

#[command]
pub async fn copy_dir(from_path: String, to_path: String) -> Result<(), String> {
    // 大模型复制是阻塞 I/O；放入 blocking 池，避免占住 Tauri 异步命令执行线程拖慢窗口交互。
    tauri::async_runtime::spawn_blocking(move || {
        copy_model_directory_tree(Path::new(&from_path), Path::new(&to_path))
    })
    .await
    .map_err(|error| format!("Failed to import model: {error}"))?
}

#[cfg(unix)]
fn copy_model_directory_tree(source_input: &Path, target: &Path) -> Result<(), String> {
    use rustix::fs::{AtFlags, Mode, mkdirat, openat, unlinkat};

    // 顶层先拒绝 symlink，再把 canonical 路径逐层打开成 dirfd；后续复制不再信任可变的路径字符串。
    let source_metadata = symlink_metadata(source_input).map_err(|error| error.to_string())?;

    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err("Model import source must be a real directory".to_string());
    }

    let source_root = canonicalize(source_input)
        .map_err(|error| format!("Failed to resolve model import source: {error}"))?;
    let source_root_fd = open_canonical_directory(&source_root)?;
    let (target_parent, target_name) = prepare_import_target(source_root.as_path(), target)?;
    let target_parent_fd = open_canonical_directory(&target_parent)?;

    // mkdirat 绑定到已打开的父目录；即使路径名随后被换链，也不会把导入写到另一个目录树。
    mkdirat(
        &target_parent_fd,
        target_name.as_os_str(),
        Mode::from(0o700),
    )
    .map_err(|error| {
        format!(
            "Model import destination must not already exist ({}): {error}",
            target.display()
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

    if let Err(error) = copy_directory_at(&source_root_fd, &target_root_fd, &source_root) {
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
                target.display()
            )),
        };
    }

    Ok(())
}

#[cfg(unix)]
fn prepare_import_target(source_root: &Path, target: &Path) -> Result<(PathBuf, PathBuf), String> {
    // 只返回 canonical 父目录与单个末级名称，确保调用者能用 mkdirat 原子创建目标而非重新解析整条路径。
    let parent = target
        .parent()
        .ok_or_else(|| "Model import destination must have a parent directory".to_string())?;
    let target_name = target
        .file_name()
        .filter(|name| !name.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Model import destination must have a directory name".to_string())?;

    create_dir_all(parent).map_err(|error| error.to_string())?;

    let resolved_parent = canonicalize(parent)
        .map_err(|error| format!("Failed to resolve model import destination: {error}"))?;
    let resolved_target = resolved_parent.join(&target_name);

    // 必须在 mkdirat 前拒绝目标落进源树；否则导入 custom-models 本身会递归读到新建 UUID。
    if resolved_target.starts_with(source_root) {
        return Err("Model import destination cannot be inside its source directory".to_string());
    }

    Ok((resolved_parent, target_name))
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
) -> Result<(), String> {
    use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, fstat, mkdirat, openat, statat};
    use std::{fs::File, io};

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

                if FileType::from_raw_mode(
                    fstat(&source_fd)
                        .map_err(|error| error.to_string())?
                        .st_mode,
                ) != FileType::RegularFile
                {
                    return Err("Model import source changed while copying".to_string());
                }

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

                io::copy(&mut source_file, &mut target_file)
                    .map_err(|error| format!("Failed to copy model file: {error}"))?;
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
fn copy_model_directory_tree(source_input: &Path, target: &Path) -> Result<(), String> {
    use std::fs::{create_dir, remove_dir_all};

    // Windows 的 symlink、junction、mount point 都属于 reparse point；只拒绝 symlink 会留下同类越界入口。
    let source_metadata = symlink_metadata(source_input).map_err(|error| error.to_string())?;

    if is_windows_reparse_point(&source_metadata) || !source_metadata.is_dir() {
        return Err("Model import source must be a real directory".to_string());
    }

    let source_root = canonicalize(source_input)
        .map_err(|error| format!("Failed to resolve model import source: {error}"))?;
    let parent = target
        .parent()
        .ok_or_else(|| "Model import destination must have a parent directory".to_string())?;
    let target_name = target
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Model import destination must have a directory name".to_string())?;

    create_dir_all(parent).map_err(|error| error.to_string())?;
    let resolved_parent = canonicalize(parent)
        .map_err(|error| format!("Failed to resolve model import destination: {error}"))?;
    let resolved_target = resolved_parent.join(target_name);

    // 创建目标前拒绝其落入源树，否则导入 custom-models 本身会把新 UUID 再当源目录递归复制。
    if windows_path_starts_with(&resolved_target, &source_root) {
        return Err("Model import destination cannot be inside its source directory".to_string());
    }

    create_dir(&resolved_target).map_err(|error| {
        format!(
            "Model import destination must not already exist ({}): {error}",
            target.display()
        )
    })?;

    if let Err(error) = copy_model_directory_windows(&source_root, &source_root, &resolved_target) {
        // 目标目录使用 create-new 语义，本次创建失败时整树都属于未完成导入，可以安全回滚且不覆盖旧模型。
        return match remove_dir_all(&resolved_target) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; failed to remove incomplete import {}: {cleanup_error}",
                target.display()
            )),
        };
    }

    Ok(())
}

#[cfg(windows)]
fn copy_model_directory_windows(
    source_root: &Path,
    source_directory: &Path,
    target_directory: &Path,
) -> Result<(), String> {
    use std::fs::{OpenOptions, create_dir, read_dir};
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    // OPEN_REPARSE_POINT 让句柄指向条目本身；再查最终句柄路径，避免父 junction 在检查后被换链。
    let directory_handle = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(source_directory)
        .map_err(|error| format!("Failed to safely open model directory: {error}"))?;

    assert_windows_handle_in_root(&directory_handle, source_root)?;

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
            create_dir(&target).map_err(|error| error.to_string())?;
            copy_model_directory_windows(source_root, &source, &target)?;
        } else if metadata.is_file() {
            copy_regular_file_windows(source_root, &source, &target)?;
        } else {
            return Err(format!(
                "Model import contains an unsupported filesystem entry: {}",
                source.display()
            ));
        }
    }

    // 标准库 read_dir 不暴露其搜索句柄，所以遍历前后都复核我们持有的目录句柄；
    // 每个实际复制的文件也按句柄最终路径复核，父 junction 换链无法把外部文件写入目标。
    assert_windows_handle_in_root(&directory_handle, source_root)
}

#[cfg(windows)]
fn copy_regular_file_windows(
    source_root: &Path,
    source: &Path,
    target: &Path,
) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io;
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    // 先打开句柄、再从句柄读取 metadata 和最终路径；不能先 canonicalize 字符串再按同一字符串二次打开。
    let mut source_file = OpenOptions::new()
        .read(true)
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

    let mut target_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;

    io::copy(&mut source_file, &mut target_file)
        .map_err(|error| format!("Failed to copy {}: {error}", source.display()))?;

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
            "Model import handle resolves outside its source: {}",
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

#[cfg(not(any(unix, windows)))]
fn copy_model_directory_tree(_source_input: &Path, _target: &Path) -> Result<(), String> {
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
