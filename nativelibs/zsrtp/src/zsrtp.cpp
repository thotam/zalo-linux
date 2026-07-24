#include <napi.h>
#include <srtp2/srtp.h>
#include <cstring>
#include <string>
#include <vector>

static bool g_inited = false;

class ZSrtp : public Napi::ObjectWrap<ZSrtp> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  ZSrtp(const Napi::CallbackInfo& info);
  ~ZSrtp();

 private:
  srtp_t out_ = nullptr;
  srtp_t in_ = nullptr;
  std::vector<uint8_t> key_;  // keep master key alive for the session's lifetime
  Napi::Value Protect(const Napi::CallbackInfo& info);
  Napi::Value Unprotect(const Napi::CallbackInfo& info);
};

Napi::Object ZSrtp::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "ZSrtp", {
    InstanceMethod("protect", &ZSrtp::Protect),
    InstanceMethod("unprotect", &ZSrtp::Unprotect),
  });
  exports.Set("ZSrtp", func);
  return exports;
}

ZSrtp::ZSrtp(const Napi::CallbackInfo& info) : Napi::ObjectWrap<ZSrtp>(info) {
  Napi::Env env = info.Env();
  if (!g_inited) {
    if (srtp_init() != srtp_err_status_ok) {
      Napi::Error::New(env, "srtp_init failed").ThrowAsJavaScriptException();
      return;
    }
    g_inited = true;
  }
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "expected { key: Buffer(30) }").ThrowAsJavaScriptException();
    return;
  }
  Napi::Object opts = info[0].As<Napi::Object>();
  if (!opts.Has("key") || !opts.Get("key").IsBuffer()) {
    Napi::TypeError::New(env, "key must be a Buffer").ThrowAsJavaScriptException();
    return;
  }
  Napi::Buffer<uint8_t> key = opts.Get("key").As<Napi::Buffer<uint8_t>>();
  if (key.Length() != 30) {
    Napi::RangeError::New(env, "key must be 30 bytes (16 master key + 14 salt)").ThrowAsJavaScriptException();
    return;
  }
  key_.assign(key.Data(), key.Data() + 30);

  srtp_policy_t pout;
  memset(&pout, 0, sizeof(pout));
  srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&pout.rtp);
  srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&pout.rtcp);
  pout.ssrc.type = ssrc_any_outbound;
  pout.key = key_.data();
  pout.next = nullptr;
  if (srtp_create(&out_, &pout) != srtp_err_status_ok) {
    Napi::Error::New(env, "srtp_create(outbound) failed").ThrowAsJavaScriptException();
    return;
  }

  srtp_policy_t pin;
  memset(&pin, 0, sizeof(pin));
  srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&pin.rtp);
  srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&pin.rtcp);
  pin.ssrc.type = ssrc_any_inbound;
  pin.key = key_.data();
  pin.next = nullptr;
  if (srtp_create(&in_, &pin) != srtp_err_status_ok) {
    Napi::Error::New(env, "srtp_create(inbound) failed").ThrowAsJavaScriptException();
    return;
  }
}

ZSrtp::~ZSrtp() {
  if (out_) srtp_dealloc(out_);
  if (in_) srtp_dealloc(in_);
}

Napi::Value ZSrtp::Protect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "protect(rtp: Buffer)").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Buffer<uint8_t> rtp = info[0].As<Napi::Buffer<uint8_t>>();
  int len = static_cast<int>(rtp.Length());
  std::vector<uint8_t> buf(len + SRTP_MAX_TRAILER_LEN + 4);
  memcpy(buf.data(), rtp.Data(), len);
  srtp_err_status_t st = srtp_protect(out_, buf.data(), &len);
  if (st != srtp_err_status_ok) {
    Napi::Error::New(env, "srtp_protect failed: " + std::to_string(st)).ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Buffer<uint8_t>::Copy(env, buf.data(), len);
}

Napi::Value ZSrtp::Unprotect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "unprotect(srtp: Buffer)").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Buffer<uint8_t> srtp = info[0].As<Napi::Buffer<uint8_t>>();
  int len = static_cast<int>(srtp.Length());
  std::vector<uint8_t> buf(len > 0 ? len : 1);
  memcpy(buf.data(), srtp.Data(), len);
  srtp_err_status_t st = srtp_unprotect(in_, buf.data(), &len);
  if (st != srtp_err_status_ok) {
    Napi::Error::New(env, "srtp_unprotect failed: " + std::to_string(st)).ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Buffer<uint8_t>::Copy(env, buf.data(), len);
}

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return ZSrtp::Init(env, exports);
}

NODE_API_MODULE(zsrtp, InitAll)
