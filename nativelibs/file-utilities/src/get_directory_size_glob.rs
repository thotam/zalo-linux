use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use globset::Glob;
use napi::{Env, Result, Task};
use napi_derive::napi;
use walkdir::WalkDir;

use crate::get_directory_size::{DirectorySizeOptions, DirectorySizeResult};
use crate::shared::async_job::{num_workers, register_job, unregister_job};

// Split a glob pattern into a literal base dir to walk + the matcher.
fn base_dir(pattern: &str) -> PathBuf {
    let mut base = PathBuf::new();
    for comp in Path::new(pattern).components() {
        let s = comp.as_os_str().to_string_lossy();
        if s.contains('*') || s.contains('?') || s.contains('[') {
            break;
        }
        base.push(comp.as_os_str());
    }
    if base.as_os_str().is_empty() {
        base.push(".");
    }
    base
}

fn compute(pattern: &str, _workers: usize, cancel: &AtomicBool) -> Result<DirectorySizeResult> {
    let start = Instant::now();
    let glob = Glob::new(pattern)
        .map_err(|e| napi::Error::from_reason(format!("Invalid glob pattern '{}': {}", pattern, e)))?
        .compile_matcher();

    let base = base_dir(pattern);
    let mut total = 0f64;
    let mut count = 0u32;
    let mut seen: HashSet<(u64, u64)> = HashSet::new();

    for entry in WalkDir::new(&base).into_iter().filter_map(|e| e.ok()) {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if !glob.is_match(entry.path()) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            // hardlink dedup by (dev, ino) — no open fd (see walk_size rationale)
            if !seen.insert((meta.dev(), meta.ino())) {
                continue;
            }
            total += meta.len() as f64;
            count += 1;
        }
    }

    Ok(DirectorySizeResult {
        total_size: total,
        file_count: count,
        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

#[napi]
pub fn get_directory_size_by_glob_sync(
    pattern: String,
    options: Option<DirectorySizeOptions>,
) -> Result<DirectorySizeResult> {
    let workers = num_workers(options.and_then(|o| o.workers));
    let cancel = AtomicBool::new(false);
    compute(&pattern, workers, &cancel)
}

pub struct GlobTask {
    pattern: String,
    workers: usize,
    cancel: Arc<AtomicBool>,
    job_id: u32,
}

impl Task for GlobTask {
    type Output = DirectorySizeResult;
    type JsValue = DirectorySizeResult;
    fn compute(&mut self) -> Result<Self::Output> {
        compute(&self.pattern, self.workers, &self.cancel)
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
pub fn get_directory_size_by_glob_async(
    pattern: String,
    options: Option<DirectorySizeOptions>,
    job_id: u32,
) -> napi::bindgen_prelude::AsyncTask<GlobTask> {
    let workers = num_workers(options.and_then(|o| o.workers));
    let cancel = register_job(job_id);
    napi::bindgen_prelude::AsyncTask::new(GlobTask {
        pattern,
        workers,
        cancel,
        job_id,
    })
}
