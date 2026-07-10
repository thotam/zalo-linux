use napi_derive::napi;

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}
