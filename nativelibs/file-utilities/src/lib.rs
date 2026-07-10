use napi_derive::napi;

mod shared;
mod get_directory_size;

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}
