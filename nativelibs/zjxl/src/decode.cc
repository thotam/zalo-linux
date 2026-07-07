#include <napi.h>
#include <jxl/decode.h>
#include <jxl/resizable_parallel_runner.h>
#include <turbojpeg.h>
#include <cmath>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>
#include "common.h"
#include "re_params.h"

// jxlToJpeg / jxlToJpegFromLocalPath — the load-bearing display path.
//
// Reproduces the mac binary's two RE'd helpers (see RE-PARAMS.md
// "Decode -> JPEG path — jxlToJpeg -> encodeJpegOneShotTurbo"):
//   * decode:  JxlDecoderSetImageOutBuffer with 3-channel JXL_TYPE_UINT8 (RGB8).
//   * encode:  turbojpeg tj3 one-shot — tj3Init(TJINIT_COMPRESS),
//              tj3Set(QUALITY), tj3Set(SUBSAMP=TJSAMP_420), tj3Set(PROGRESSIVE=1),
//              tj3Compress8(..., TJPF_RGB, ...).
// Output is intended to be bit-identical to the mac binary given the pinned
// libjxl 0.9.3 + libjpeg-turbo 3.x.
namespace zjxl {

// Decode a JXL codestream to interleaved RGB8. Returns false on any failure.
// Frees the decoder and the parallel runner on every path.
bool DecodeToRgb(const std::vector<uint8_t>& in, std::vector<uint8_t>& rgb,
                 uint32_t& w, uint32_t& h) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (!dec) return false;
  void* runner = JxlResizableParallelRunnerCreate(nullptr);
  if (!runner) { JxlDecoderDestroy(dec); return false; }

  bool ok = false;
  do {
    if (JxlDecoderSetParallelRunner(dec, JxlResizableParallelRunner, runner) !=
        JXL_DEC_SUCCESS) break;
    if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) !=
        JXL_DEC_SUCCESS) break;
    if (JxlDecoderSetInput(dec, in.data(), in.size()) != JXL_DEC_SUCCESS) break;
    JxlDecoderCloseInput(dec);

    // 3-channel RGB UINT8, native endian, no row padding — matches the mac
    // decode contract (RE-PARAMS.md: num_channels=3, JXL_TYPE_UINT8 @0x16a38).
    JxlPixelFormat fmt{static_cast<uint32_t>(zjxl_re::kDecodeNumChannels),
                       JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN,
                       static_cast<size_t>(zjxl_re::kEncodePixelAlign)};

    for (;;) {
      JxlDecoderStatus st = JxlDecoderProcessInput(dec);
      if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT) break;
      if (st == JXL_DEC_BASIC_INFO) {
        JxlBasicInfo bi;
        if (JxlDecoderGetBasicInfo(dec, &bi) != JXL_DEC_SUCCESS) break;
        w = bi.xsize;
        h = bi.ysize;
        JxlResizableParallelRunnerSetThreads(
            runner, JxlResizableParallelRunnerSuggestThreads(w, h));
      } else if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
        size_t need = 0;
        if (JxlDecoderImageOutBufferSize(dec, &fmt, &need) != JXL_DEC_SUCCESS) break;
        rgb.resize(need);
        if (JxlDecoderSetImageOutBuffer(dec, &fmt, rgb.data(), rgb.size()) !=
            JXL_DEC_SUCCESS) break;
      } else if (st == JXL_DEC_FULL_IMAGE || st == JXL_DEC_SUCCESS) {
        ok = true;
        break;
      }
    }
  } while (false);

  JxlResizableParallelRunnerDestroy(runner);
  JxlDecoderDestroy(dec);
  return ok && !rgb.empty();
}

// RGB8 -> progressive 4:2:0 JPEG via the turbojpeg tj3 one-shot API, matching
// encodeJpegOneShotTurbo @0x81fa. `quality` is the already-scaled 1..100 int.
// Frees the tj handle and the output buffer on every path.
bool RgbToJpeg(const std::vector<uint8_t>& rgb, uint32_t w, uint32_t h,
               int quality, std::vector<uint8_t>& jpeg) {
  tjhandle h_tj = tj3Init(TJINIT_COMPRESS);
  if (!h_tj) return false;

  bool ok = false;
  do {
    // tj3Set(h, TJPARAM_QUALITY=3, quality)      @0x8252
    if (tj3Set(h_tj, TJPARAM_QUALITY, quality) != 0) break;
    // tj3Set(h, TJPARAM_SUBSAMP=4, TJSAMP_420=2) @0x8260
    if (tj3Set(h_tj, TJPARAM_SUBSAMP, zjxl_re::kJpegSubsamp) != 0) break;
    // tj3Set(h, TJPARAM_PROGRESSIVE=10, 1)       @0x826e
    if (tj3Set(h_tj, TJPARAM_PROGRESSIVE, zjxl_re::kJpegProgressive) != 0) break;

    unsigned char* out = nullptr;
    size_t outSize = 0;
    // tj3Compress8(h, src, w, pitch=0, h, TJPF_RGB=0, &out, &outSize) @0x82a9
    int rc = tj3Compress8(h_tj, rgb.data(), static_cast<int>(w), /*pitch=*/0,
                          static_cast<int>(h), TJPF_RGB, &out, &outSize);
    if (rc == 0 && out != nullptr) {
      jpeg.assign(out, out + outSize);
      ok = true;
    }
    if (out) tj3Free(out);
  } while (false);

  tj3Destroy(h_tj);
  return ok;
}

// Convert the JS "quality" option (0..1 float) to a turbojpeg 1..100 int.
// RE-PARAMS.md "Quality is caller-supplied; kJpegQualityScale = 100.0f":
// jxlToJpeg reads "quality" as a float and does mulss by 100.0 then cvttss2si.
// If "quality" is absent/NaN we fall back to kDefaultJpegQuality (already a
// 0..100 value — the one assumed param; mac callers always pass quality).
static int ResolveQuality(const Napi::Object& opts) {
  Napi::Value v = opts.Get("quality");
  int q;
  if (v.IsNumber()) {
    double quality01 = v.As<Napi::Number>().DoubleValue();
    if (std::isnan(quality01)) {
      q = zjxl_re::kDefaultJpegQuality;
    } else {
      q = static_cast<int>(std::lround(quality01 * zjxl_re::kJpegQualityScale));
    }
  } else {
    q = zjxl_re::kDefaultJpegQuality;
  }
  if (q < 1) q = 1;
  if (q > 100) q = 100;
  return q;
}

class DecodeWorker : public Napi::AsyncWorker {
 public:
  DecodeWorker(Napi::Function cb, std::vector<uint8_t> in, int quality)
      : Napi::AsyncWorker(cb), in_(std::move(in)), quality_(quality) {}

  void Execute() override {
    uint32_t w = 0, h = 0;
    std::vector<uint8_t> rgb;
    if (!DecodeToRgb(in_, rgb, w, h)) {
      status_ = ERR_DECODE;
      SetError("jxlToJpeg: decode failed");
      return;
    }
    if (!RgbToJpeg(rgb, w, h, quality_, jpeg_)) {
      status_ = ERR_ENCODE;
      SetError("jxlToJpeg: jpeg encode failed");
      return;
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Callback().Call({env.Null(),
                     Napi::Buffer<uint8_t>::Copy(env, jpeg_.data(), jpeg_.size()),
                     Napi::Number::New(env, OK)});
  }

  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Callback().Call(
        {e.Value(), env.Null(), Napi::Number::New(env, status_)});
  }

 private:
  std::vector<uint8_t> in_, jpeg_;
  int quality_;
  int status_ = ERR_DECODE;
};

static Napi::Value JxlToJpeg(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();
  std::vector<uint8_t> in;
  try {
    in = GetBuffer(opts, "buffer");
  } catch (const Napi::Error& e) {
    cb.Call({e.Value(), env.Null(), Napi::Number::New(env, ERR_INPUT)});
    return env.Undefined();
  }
  (new DecodeWorker(cb, std::move(in), ResolveQuality(opts)))->Queue();
  return env.Undefined();
}

static Napi::Value JxlToJpegFromLocalPath(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();

  Napi::Value pv = opts.Get("path");
  if (!pv.IsString()) {
    cb.Call({Napi::String::New(env, "jxlToJpegFromLocalPath: path must be a string"),
             env.Null(), Napi::Number::New(env, ERR_INPUT)});
    return env.Undefined();
  }
  std::string p = pv.As<Napi::String>();
  std::ifstream f(p, std::ios::binary);
  if (!f) {
    cb.Call({Napi::String::New(env, "jxlToJpegFromLocalPath: open failed"),
             env.Null(), Napi::Number::New(env, ERR_INPUT)});
    return env.Undefined();
  }
  std::vector<uint8_t> in((std::istreambuf_iterator<char>(f)),
                          std::istreambuf_iterator<char>());
  if (in.empty()) {
    cb.Call({Napi::String::New(env, "jxlToJpegFromLocalPath: empty file"),
             env.Null(), Napi::Number::New(env, ERR_INPUT)});
    return env.Undefined();
  }
  (new DecodeWorker(cb, std::move(in), ResolveQuality(opts)))->Queue();
  return env.Undefined();
}

void RegisterDecode(Napi::Env env, Napi::Object exports) {
  exports.Set("jxlToJpeg", Napi::Function::New(env, JxlToJpeg));
  exports.Set("jxlToJpegFromLocalPath",
              Napi::Function::New(env, JxlToJpegFromLocalPath));
}

}  // namespace zjxl
