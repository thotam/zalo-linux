#include <napi.h>
#include "common.h"

namespace zjxl {
void RegisterInfo(Napi::Env, Napi::Object);
void RegisterDecode(Napi::Env, Napi::Object);
void RegisterEncode(Napi::Env, Napi::Object);
void RegisterResize(Napi::Env, Napi::Object);
void RegisterMulti(Napi::Env, Napi::Object);

static Napi::Value ModuleReady(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}
}  // namespace zjxl

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("moduleReady", Napi::Function::New(env, zjxl::ModuleReady));
  zjxl::RegisterInfo(env, exports);
  zjxl::RegisterDecode(env, exports);
  zjxl::RegisterEncode(env, exports);
  zjxl::RegisterResize(env, exports);
  zjxl::RegisterMulti(env, exports);
  return exports;
}
NODE_API_MODULE(jxl, Init)
