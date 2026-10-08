//! Versioned publication for observed file mutations. Staged bytes are never visible at the target.

use crate::{errors::Failure, exec::Control, fs, sys};
use serde_json::{Value, json};
use std::fs::{self as stdfs, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

type Outcome<T> = Result<T, Failure>;

enum Intent {
    Create,
    Replace { path: String, version: String },
}

pub struct Stage {
    original: String,
    target: String,
    directory: PathBuf,
    temporary: PathBuf,
    intent: Intent,
    published: AtomicBool,
}

pub fn check_abort(control: &Control, path: &str) -> Outcome<()> {
    if control.aborted.load(Ordering::SeqCst) {
        Err(Failure::new("aborted", "The operation was aborted").path(path))
    } else {
        Ok(())
    }
}

pub fn version(file: &File, path: &str) -> Outcome<String> {
    let metadata = file
        .metadata()
        .map_err(|e| Failure::io(&e, "fstat", path))?;
    if !metadata.is_file() {
        return Err(Failure::new("NOT_REGULAR", "Not a regular file").path(path));
    }
    sys::file_version(file, &metadata).map_err(|e| Failure::io(&e, "fstat", path))
}

pub fn revision(path: &str) -> Outcome<Value> {
    let canonical = sys::realpath(path).map_err(|e| Failure::io(&e, "realpath", path))?;
    let (file, _) = fs::open_reader(&canonical, true)?;
    Ok(json!({ "path": canonical, "version": version(&file, path)? }))
}

/// A missing leaf retains its real parent, so directory aliases share a target identity.
fn target_path(path: &Path) -> io::Result<String> {
    match sys::realpath(&path.to_string_lossy()) {
        Ok(target) => Ok(target),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let Some(parent) = path.parent().filter(|parent| *parent != path) else {
                return Err(error);
            };
            let Some(name) = path.file_name() else {
                return Err(error);
            };
            Ok(Path::new(&target_path(parent)?)
                .join(name)
                .to_string_lossy()
                .into_owned())
        }
        Err(error) => Err(error),
    }
}

impl Stage {
    pub fn open(
        path: &str,
        intent: &Value,
        bytes: &[u8],
        control: &Control,
    ) -> Outcome<(File, Self)> {
        check_abort(control, path)?;
        let intent = match intent["kind"].as_str() {
            Some("createIfAbsent") => Intent::Create,
            Some("replaceIfVersion") => Intent::Replace {
                path: intent["revision"]["path"]
                    .as_str()
                    .ok_or_else(|| {
                        Failure::new("EINVAL", "Missing canonical file path").path(path)
                    })?
                    .to_string(),
                version: intent["revision"]["version"]
                    .as_str()
                    .ok_or_else(|| Failure::new("EINVAL", "Missing file version").path(path))?
                    .to_string(),
            },
            _ => return Err(Failure::new("EINVAL", "Invalid write intent").path(path)),
        };
        let target = target_path(Path::new(path)).map_err(|e| Failure::io(&e, "realpath", path))?;
        let current = check(path, &target, &intent)?;
        if current.is_some() {
            OpenOptions::new().write(true).open(&target)
                .map_err(|e| Failure::io(&e, "open for replacement", path))?;
        }
        let parent = Path::new(&target)
            .parent()
            .ok_or_else(|| Failure::new("EINVAL", "Missing parent").path(path))?;
        fs::mkdir_recursive(parent).map_err(|e| Failure::io(&e, "mkdir", path))?;
        check_abort(control, path)?;
        let directory = PathBuf::from(
            sys::mkdtemp(&parent.join(".amazme-write-").to_string_lossy())
                .map_err(|e| Failure::io(&e, "mkdtemp", path))?,
        );
        let stage = Stage {
            original: path.to_string(),
            target,
            temporary: directory.join("content"),
            directory,
            intent,
            published: AtomicBool::new(false),
        };
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&stage.temporary)
            .map_err(|e| Failure::io(&e, "open", path))?;
        file.write_all(bytes)
            .map_err(|e| Failure::io(&e, "write", path))?;
        if let Some(current) = current {
            file.set_permissions(current.permissions())
                .map_err(|e| Failure::io(&e, "chmod", path))?;
        }
        check_abort(control, path)?;
        Ok((file, stage))
    }

    pub fn writable(&self, control: &Control) -> Outcome<()> {
        check_abort(control, &self.original)?;
        if self.published.load(Ordering::SeqCst) {
            return Err(Failure::new("EBADF", "Write is already published").path(&self.original));
        }
        Ok(())
    }

    /// The caller serializes this short check-and-publish section with other checked writers in the daemon.
    pub fn publish(&self, file: &File, control: &Control) -> Outcome<Value> {
        self.writable(control)?;
        file.sync_all()
            .map_err(|e| Failure::io(&e, "fsync", &self.original))?;
        check(&self.original, &self.target, &self.intent)?;
        check_abort(control, &self.original)?;
        let operation = match &self.intent {
            Intent::Create => {
                stdfs::hard_link(&self.temporary, &self.target).map_err(|e| {
                    if e.kind() == io::ErrorKind::AlreadyExists {
                        Failure::new(
                            "not_observed",
                            "Another writer created the file; read it before replacing it",
                        )
                        .path(&self.original)
                    } else {
                        Failure::io(&e, "link", &self.original)
                    }
                })?;
                "create"
            }
            Intent::Replace { .. } => {
                sys::checked_replace(&self.temporary.to_string_lossy(), &self.target)
                    .map_err(|e| Failure::io(&e, "rename", &self.original))?;
                "replace"
            }
        };
        self.published.store(true, Ordering::SeqCst);
        // Unlinking the staging hard link changes ctime; sample the published handle afterwards.
        self.cleanup();
        let mut result = json!({ "path": self.target, "operation": operation });
        if let Ok(version) = version(file, &self.original) {
            result["version"] = json!(version);
        }
        Ok(result)
    }

    pub fn cleanup(&self) {
        // A committed write must not be reported as failed solely because cleanup failed.
        let _ = stdfs::remove_dir_all(&self.directory);
    }
}

impl Drop for Stage {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn check(path: &str, target: &str, intent: &Intent) -> Outcome<Option<Metadata>> {
    let current_target =
        target_path(Path::new(path)).map_err(|e| Failure::io(&e, "realpath", path))?;
    if current_target != target {
        return Err(Failure::new("stale_version", "File target changed; read it again").path(path));
    }
    let current = match stdfs::symlink_metadata(target) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(Failure::io(&error, "lstat", path)),
    };
    match intent {
        Intent::Create if current.is_some() => Err(Failure::new(
            "not_observed",
            "Read the existing file before replacing it",
        )
        .path(path)),
        Intent::Create => Ok(None),
        Intent::Replace {
            path: expected_path,
            version: expected,
        } => {
            if expected_path != target {
                return Err(
                    Failure::new("stale_version", "File target changed; read it again").path(path),
                );
            }
            if !current.as_ref().is_some_and(Metadata::is_file) {
                return Err(Failure::new(
                    "stale_version",
                    "File changed since it was read; read it again",
                )
                .path(path));
            }
            let (file, _) = fs::open_reader(target, true)?;
            if version(&file, path)? != *expected {
                return Err(Failure::new(
                    "stale_version",
                    "File changed since it was read; read it again",
                )
                .path(path));
            }
            Ok(current)
        }
    }
}
