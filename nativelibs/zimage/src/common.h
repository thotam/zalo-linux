#pragma once
#include <napi.h>
#include <string>
#include <vector>
namespace zimage {
enum StatusCode { OK = 0, ERR_INPUT = 1, ERR_VIPS = 2 };
inline std::string GetString(const Napi::Value& v) {
  return v.IsString() ? v.As<Napi::String>().Utf8Value() : std::string();
}
}  // namespace zimage
