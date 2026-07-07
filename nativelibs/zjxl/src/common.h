#pragma once
#include <napi.h>
#include <cstdint>
#include <vector>
#include <string>

namespace zjxl {
// Read a Buffer property from an options object; throws a JS TypeError if missing.
inline std::vector<uint8_t> GetBuffer(const Napi::Object& opts, const char* key) {
  Napi::Value v = opts.Get(key);
  if (!v.IsBuffer()) throw Napi::TypeError::New(opts.Env(), std::string(key) + " must be a Buffer");
  auto buf = v.As<Napi::Buffer<uint8_t>>();
  return std::vector<uint8_t>(buf.Data(), buf.Data() + buf.Length());
}
inline int GetInt(const Napi::Object& opts, const char* key, int dflt) {
  Napi::Value v = opts.Get(key);
  return v.IsNumber() ? v.As<Napi::Number>().Int32Value() : dflt;
}
// Status codes returned to JS as the callback's 3rd arg.
enum StatusCode { OK = 0, ERR_INPUT = 1, ERR_DECODE = 2, ERR_ENCODE = 3, ERR_RESIZE = 4 };
}  // namespace zjxl
