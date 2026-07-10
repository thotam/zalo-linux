use napi_derive::napi;

mod shared;

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}
