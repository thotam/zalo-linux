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

// Shared codec helpers (defined in decode.cc). Non-static so Task 7/8 batch
// decoders can reuse them. Signatures use only std/POD types so common.h needs
// no libjxl/turbojpeg includes.
// Decode a JXL codestream to interleaved RGB8 plus its ICC profile (may be
// empty); frees decoder on all paths.
bool DecodeToRgb(const std::vector<uint8_t>& in, std::vector<uint8_t>& rgb,
                 uint32_t& w, uint32_t& h, std::vector<uint8_t>& icc);
// RGB8 -> BASELINE 4:2:0 JPEG via turbojpeg tj3 (fast integer DCT); `quality`
// is 1..100. `icc` is embedded (APP2) when non-empty, else omitted.
bool RgbToJpeg(const std::vector<uint8_t>& rgb, uint32_t w, uint32_t h,
               int quality, const std::vector<uint8_t>& icc,
               std::vector<uint8_t>& jpeg);
}  // namespace zjxl
