use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use napi::{Env, Result, Task};
use napi_derive::napi;

use crate::shared::async_job::{register_job, unregister_job};

#[napi(object)]
pub struct DirectoryTreeOptions {
    pub max_depth: i32,
    pub workers: Option<u32>,
    pub include_root: Option<bool>,
}

#[napi(object)]
pub struct DirectoryTreeResult {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub depth: u32,
    pub size: f64,
    pub file_count: u32,
    pub children: Vec<DirectoryTreeResult>,
}

// Recursively build a node. `seen` dedups hardlinks across the whole tree.
// Returns the node; size/file_count are cumulative for the subtree regardless of depth.
fn build(
    dir: &Path,
    root: &Path,
    depth: u32,
    max_depth: u32,
    seen: &Mutex<HashSet<(u64, u64)>>,
    cancel: &AtomicBool,
) -> DirectoryTreeResult {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.to_string_lossy().to_string());
    let relative_path = dir
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut size = 0f64;
    let mut file_count = 0u32;
    let mut children = Vec::new();

    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let path = entry.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let ft = meta.file_type();
            if ft.is_dir() {
                let child = build(&path, root, depth + 1, max_depth, seen, cancel);
                size += child.size;
                file_count += child.file_count;
                if depth < max_depth {
                    children.push(child);
                }
            } else if ft.is_file() {
                // hardlink dedup by (dev, ino) — no open fd (see walk_size rationale)
                if !seen.lock().unwrap().insert((meta.dev(), meta.ino())) {
                    continue;
                }
                size += meta.len() as f64;
                file_count += 1;
            }
        }
    }

    DirectoryTreeResult {
        name,
        path: dir.to_string_lossy().to_string(),
        relative_path,
        depth,
        size,
        file_count,
        children,
    }
}

fn compute(path: &str, opts: &DirectoryTreeOptions, cancel: &AtomicBool) -> Result<DirectoryTreeResult> {
    if opts.max_depth < 0 {
        return Err(napi::Error::from_reason("max_depth must be >= 0".to_string()));
    }
    let root = Path::new(path);
    if !root.exists() {
        return Err(napi::Error::from_reason(format!(
            "Root path does not exist: {}",
            path
        )));
    }
    let seen = Mutex::new(HashSet::new());
    Ok(build(root, root, 0, opts.max_depth as u32, &seen, cancel))
}

#[napi]
pub fn get_directory_size_tree_sync(
    path: String,
    options: DirectoryTreeOptions,
) -> Result<DirectoryTreeResult> {
    let cancel = AtomicBool::new(false);
    compute(&path, &options, &cancel)
}

pub struct TreeTask {
    path: String,
    options: DirectoryTreeOptions,
    cancel: Arc<AtomicBool>,
    job_id: u32,
}

impl Task for TreeTask {
    type Output = DirectoryTreeResult;
    type JsValue = DirectoryTreeResult;
    fn compute(&mut self) -> Result<Self::Output> {
        compute(&self.path, &self.options, &self.cancel)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        unregister_job(self.job_id);
        Ok(output)
    }
    fn reject(&mut self, _env: Env, err: napi::Error) -> Result<Self::JsValue> {
        unregister_job(self.job_id);
        Err(err)
    }
}

#[napi]
pub fn get_directory_size_tree_async(
    path: String,
    options: DirectoryTreeOptions,
    job_id: u32,
) -> napi::bindgen_prelude::AsyncTask<TreeTask> {
    let cancel = register_job(job_id);
    napi::bindgen_prelude::AsyncTask::new(TreeTask {
        path,
        options,
        cancel,
        job_id,
    })
}
