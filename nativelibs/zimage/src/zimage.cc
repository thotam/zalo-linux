#include <napi.h>
#include <vips/vips8>
#include "common.h"

namespace zimage {
void RegisterThumbnail(Napi::Env, Napi::Object);
void RegisterThumbnailFs(Napi::Env, Napi::Object);
static Napi::Value ModuleReady(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}
}  // namespace zimage

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  if (VIPS_INIT("zimage")) {
    Napi::Error::New(env, "vips_init failed").ThrowAsJavaScriptException();
    return exports;
  }
  exports.Set("moduleReady", Napi::Function::New(env, zimage::ModuleReady));
  zimage::RegisterThumbnail(env, exports);
  zimage::RegisterThumbnailFs(env, exports);
  return exports;
}
NODE_API_MODULE(zimage, Init)
