#include <napi.h>
#include <jxl/decode.h>
#include "common.h"

namespace zjxl {

static Napi::Value GetJxlInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();
  std::vector<uint8_t> in;
  try { in = GetBuffer(opts, "buffer"); }
  catch (const Napi::Error& e) { cb.Call({e.Value(), env.Null(), Napi::Number::New(env, ERR_INPUT)}); return env.Undefined(); }

  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (!dec) {
    cb.Call({Napi::String::New(env, "getJxlInfo: decoder alloc failed"), env.Null(), Napi::Number::New(env, ERR_DECODE)});
    return env.Undefined();
  }
  JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO);
  JxlDecoderSetInput(dec, in.data(), in.size());
  JxlDecoderCloseInput(dec);

  JxlBasicInfo bi;
  bool got = false;
  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_ERROR) break;
    if (st == JXL_DEC_BASIC_INFO) { if (JxlDecoderGetBasicInfo(dec, &bi) == JXL_DEC_SUCCESS) got = true; break; }
    if (st == JXL_DEC_SUCCESS || st == JXL_DEC_NEED_MORE_INPUT) break;
  }
  JxlDecoderDestroy(dec);

  if (!got) { cb.Call({Napi::String::New(env, "getJxlInfo: parse failed"), env.Null(), Napi::Number::New(env, ERR_DECODE)}); return env.Undefined(); }
  // Key set matches the mac binary's GetJxlInfoAsyncWorker::OnOK (width/height/orientation
  // only -- no hasAlpha/bitsPerSample). See RE-PARAMS.md "getJxlInfo output keys".
  Napi::Object out = Napi::Object::New(env);
  out.Set("width", Napi::Number::New(env, bi.xsize));
  out.Set("height", Napi::Number::New(env, bi.ysize));
  out.Set("orientation", Napi::Number::New(env, static_cast<uint32_t>(bi.orientation)));
  cb.Call({env.Null(), out, Napi::Number::New(env, OK)});
  return env.Undefined();
}

void RegisterInfo(Napi::Env env, Napi::Object exports) {
  exports.Set("getJxlInfo", Napi::Function::New(env, GetJxlInfo));
}
}  // namespace zjxl
