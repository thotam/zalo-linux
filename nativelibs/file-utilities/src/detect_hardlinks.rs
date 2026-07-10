use std::os::unix::fs::MetadataExt;
use std::path::Path;

use napi::{Env, Result, Task};
use napi_derive::napi;

#[napi(object)]
pub struct HardlinkResult {
    pub is_hardlink: bool,
    pub link_count: u32,
}

fn detect(path: &str) -> Result<HardlinkResult> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(napi::Error::from_reason(format!(
            "Root path does not exist: {}",
            path
        )));
    }
    let meta = std::fs::symlink_metadata(p)
        .map_err(|e| napi::Error::from_reason(format!("Failed to read file metadata for {}: {}", path, e)))?;
    if !meta.file_type().is_file() {
        return Err(napi::Error::from_reason(format!("Path is not a file: {}", path)));
    }
    let nlink = meta.nlink() as u32;
    Ok(HardlinkResult {
        is_hardlink: nlink > 1,
        link_count: nlink,
    })
}

#[napi]
pub fn detect_hardlinks_sync(path: String) -> Result<HardlinkResult> {
    detect(&path)
}

pub struct HardlinkTask {
    path: String,
}

impl Task for HardlinkTask {
    type Output = HardlinkResult;
    type JsValue = HardlinkResult;
    fn compute(&mut self) -> Result<Self::Output> {
        detect(&self.path)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn detect_hardlinks_async(path: String) -> napi::bindgen_prelude::AsyncTask<HardlinkTask> {
    napi::bindgen_prelude::AsyncTask::new(HardlinkTask { path })
}
