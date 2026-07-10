use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use lazy_static::lazy_static;
use napi_derive::napi;

lazy_static! {
    static ref JOBS: Mutex<HashMap<u32, Arc<AtomicBool>>> = Mutex::new(HashMap::new());
}

pub fn register_job(job_id: u32) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    JOBS.lock().unwrap().insert(job_id, flag.clone());
    flag
}

pub fn unregister_job(job_id: u32) {
    JOBS.lock().unwrap().remove(&job_id);
}

#[napi(js_name = "cancelJob")]
pub fn cancel_job(job_id: u32) {
    if let Some(flag) = JOBS.lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

pub fn num_workers(requested: Option<u32>) -> usize {
    match requested {
        Some(0) => 1,
        Some(n) => n as usize,
        None => num_cpus::get().max(1),
    }
}

/// Directory walk. Returns (total_size_bytes, file_count).
/// - total_size sums regular-file logical sizes (st_size).
/// - hardlinks deduplicated by (dev, ino) taken from the already-stat'd
///   metadata — NOT same_file::Handle, which would hold an open fd per
///   file for the lifetime of the walk and exhaust the process ulimit.
/// - symlinks are not followed (symlink_metadata) and not summed.
/// - honors `cancel`: returns early with partial totals when set.
///
/// Single-threaded on purpose: thread count cannot change the (commutative)
/// sum, so `_workers` is accepted for API parity but the walk stays
/// deterministic and free of concurrency hazards — byte-identical output.
pub fn walk_size(root: &Path, _workers: usize, cancel: &AtomicBool) -> std::io::Result<(f64, u32)> {
    if !root.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("'{}' does not exist or cannot be accessed", root.display()),
        ));
    }

    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    let mut total = 0f64;
    let mut count = 0u32;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue, // unreadable subdir: skip, keep walking
        };
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
                stack.push(path);
            } else if ft.is_file() {
                // hardlink dedup by (dev, ino) — no open fd
                if !seen.insert((meta.dev(), meta.ino())) {
                    continue; // already counted this inode
                }
                total += meta.len() as f64;
                count += 1;
            }
        }
    }

    Ok((total, count))
}
