use std::ffi::CString;
use std::path::Path;

use napi::{Env, Result, Task};
use napi_derive::napi;

#[napi(object)]
pub struct FilesystemInfo {
    pub filesystem_type: String,
    pub volume_name: String,
    pub max_filename_length: u32,
    pub supports_case_sensitive_names: bool,
    pub supports_unicode_filenames: bool,
    pub supports_compression: bool,
    pub supports_encryption: bool,
}

// Linux statfs f_type magics -> canonical fs name.
fn fs_name(f_type: i64) -> &'static str {
    match f_type as u64 {
        0xEF53 => "ext4",
        0x9123683E => "btrfs",
        0x58465342 => "xfs",
        0x2FC12FC1 => "zfs",
        0x01021994 => "tmpfs",
        0x794C7630 => "overlayfs",
        0x4D44 => "vfat",
        0x5346544E => "ntfs",
        0xF2F52010 => "f2fs",
        0x6969 => "nfs",
        0xFF534D42 => "cifs",
        0x65735546 => "fuse",
        _ => "unknown",
    }
}

fn caps(fs: &str) -> (bool, bool, bool, bool) {
    // (case_sensitive, unicode, compression, encryption)
    match fs {
        "ext4" => (true, true, false, true),
        "btrfs" => (true, true, true, false),
        "xfs" => (true, true, false, false),
        "zfs" => (true, true, true, true),
        "f2fs" => (true, true, true, true),
        "tmpfs" | "overlayfs" | "fuse" => (true, true, false, false),
        "vfat" => (false, true, false, false),
        "ntfs" => (false, true, true, true),
        _ => (true, true, false, false),
    }
}

fn detect(path: &str) -> Result<FilesystemInfo> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(napi::Error::from_reason(format!("Path does not exist: {}", path)));
    }
    let cpath = CString::new(path)
        .map_err(|_| napi::Error::from_reason(format!("Invalid path string: {}", path)))?;
    let mut sfs: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statfs(cpath.as_ptr(), &mut sfs) };
    if rc != 0 {
        return Err(napi::Error::from_reason(format!(
            "Failed to get filesystem information for '{}'",
            path
        )));
    }
    let fs = fs_name(sfs.f_type as i64);
    let (cs, uni, comp, enc) = caps(fs);
    Ok(FilesystemInfo {
        filesystem_type: fs.to_string(),
        volume_name: String::new(), // best-effort; not exposed by statfs
        max_filename_length: sfs.f_namelen as u32,
        supports_case_sensitive_names: cs,
        supports_unicode_filenames: uni,
        supports_compression: comp,
        supports_encryption: enc,
    })
}

#[napi]
pub fn detect_filesystem_sync(path: String) -> Result<FilesystemInfo> {
    detect(&path)
}

pub struct FsTask {
    path: String,
}

impl Task for FsTask {
    type Output = FilesystemInfo;
    type JsValue = FilesystemInfo;
    fn compute(&mut self) -> Result<Self::Output> {
        detect(&self.path)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn detect_filesystem_async(path: String) -> napi::bindgen_prelude::AsyncTask<FsTask> {
    napi::bindgen_prelude::AsyncTask::new(FsTask { path })
}
