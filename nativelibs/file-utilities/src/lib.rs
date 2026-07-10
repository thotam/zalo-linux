use napi_derive::napi;

mod shared;
mod get_directory_size;
mod detect_hardlinks;

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}
