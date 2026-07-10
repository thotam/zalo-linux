use napi_derive::napi;

mod shared;
mod get_directory_size;
mod detect_hardlinks;
mod detect_filesystem;

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}
