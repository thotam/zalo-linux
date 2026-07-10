use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use napi::{Env, Result, Task};
use napi_derive::napi;

use crate::shared::async_job::{num_workers, register_job, unregister_job, walk_size};

#[napi(object)]
pub struct DirectorySizeOptions {
    pub workers: Option<u32>,
}

#[napi(object)]
pub struct DirectorySizeResult {
    pub total_size: f64,
    pub file_count: u32,
    pub duration_ms: f64,
}

fn compute(path: &str, workers: usize, cancel: &AtomicBool) -> Result<DirectorySizeResult> {
    let start = Instant::now();
    let (total, count) = walk_size(Path::new(path), workers, cancel)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(DirectorySizeResult {
        total_size: total,
        file_count: count,
        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

#[napi]
pub fn get_directory_size_sync(
    path: String,
    options: Option<DirectorySizeOptions>,
) -> Result<DirectorySizeResult> {
    let workers = num_workers(options.and_then(|o| o.workers));
    let cancel = AtomicBool::new(false);
    compute(&path, workers, &cancel)
}

pub struct DirSizeTask {
    path: String,
    workers: usize,
    cancel: Arc<AtomicBool>,
    job_id: u32,
}

#[napi]
impl Task for DirSizeTask {
    type Output = DirectorySizeResult;
    type JsValue = DirectorySizeResult;

    fn compute(&mut self) -> Result<Self::Output> {
        compute(&self.path, self.workers, &self.cancel)
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
pub fn get_directory_size_async(
    path: String,
    options: Option<DirectorySizeOptions>,
    job_id: u32,
) -> napi::bindgen_prelude::AsyncTask<DirSizeTask> {
    let workers = num_workers(options.and_then(|o| o.workers));
    let cancel = register_job(job_id);
    napi::bindgen_prelude::AsyncTask::new(DirSizeTask {
        path,
        workers,
        cancel,
        job_id,
    })
}
