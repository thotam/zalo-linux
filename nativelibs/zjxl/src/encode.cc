#include <napi.h>
#include <jxl/encode.h>
#include <jxl/resizable_parallel_runner.h>
#include <cstdint>
#include <vector>
#include "common.h"
#include "re_params.h"

// bitmapToJxl — the outgoing-image encode path. Outgoing JXLs must be
// byte-identical to the mac binary, so this replicates the RE'd
// encodeJxlOneshot @0x91e4 sequence EXACTLY (see RE-PARAMS.md "Encode path"):
//
//   JxlEncoderCreate
//   JxlEncoderSetParallelRunner (resizable runner; sized by SuggestThreads —
//     thread count does not affect output bytes)
//   JxlEncoderInitBasicInfo; override ONLY xsize/ysize (all other fields stay at
//     library defaults => bits_per_sample=8, num_color_channels=3,
//     num_extra_channels=0, alpha_bits=0, uses_original_profile=JXL_FALSE).
//   JxlEncoderSetBasicInfo
//   JxlColorEncodingSetToSRGB(&color, is_gray=JXL_FALSE); JxlEncoderSetColorEncoding
//   JxlEncoderFrameSettingsCreate
//   JxlEncoderSetFrameLossless(fs, JXL_FALSE)                 kEncodeLossless
//   JxlEncoderSetFrameDistance(fs, 2.28f)                     kEncodeDistance
//   JxlEncoderFrameSettingsSetOption(EFFORT=0, 1)             kEncodeEffort
//   JxlEncoderFrameSettingsSetOption(DECODING_SPEED=1, 4)     kEncodeDecodingSpeed
//   JxlPixelFormat{3, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0}   kEncode* pixel block
//   JxlEncoderAddImageFrame; JxlEncoderCloseInput
//   loop JxlEncoderProcessOutput until JXL_ENC_SUCCESS
//
// The mac never sets uses_original_profile / progressive / alpha and always
// encodes 3-channel RGB; do not deviate.
namespace zjxl {

// Raw interleaved pixels -> JXL codestream. Reusable helper (Task 7's resizeJxl
// re-encodes through the SAME contract). `channels` is the input channel count;
// 4ch (RGBA) input has its alpha dropped to RGB before encoding so the output is
// always 3-channel (the mac contract). Frees encoder + runner on all paths.
bool EncodeJxl(const std::vector<uint8_t>& px, uint32_t w, uint32_t h,
               uint32_t channels, std::vector<uint8_t>& out) {
  if (w == 0 || h == 0) return false;
  if (channels != 3 && channels != 4) return false;
  const size_t pixels = static_cast<size_t>(w) * h;
  if (px.size() < pixels * channels) return false;

  // The encoder always feeds 3-channel RGB (kEncodeNumChannels). If the caller
  // supplied RGBA, materialize an RGB copy dropping alpha; otherwise reference
  // the input directly.
  const std::vector<uint8_t>* rgb = &px;
  std::vector<uint8_t> rgb_tmp;
  if (channels == 4) {
    rgb_tmp.resize(pixels * 3);
    for (size_t i = 0; i < pixels; ++i) {
      rgb_tmp[i * 3 + 0] = px[i * 4 + 0];
      rgb_tmp[i * 3 + 1] = px[i * 4 + 1];
      rgb_tmp[i * 3 + 2] = px[i * 4 + 2];
    }
    rgb = &rgb_tmp;
  }

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (!enc) return false;
  void* runner = JxlResizableParallelRunnerCreate(nullptr);
  if (!runner) { JxlEncoderDestroy(enc); return false; }

  bool ok = false;
  do {
    JxlResizableParallelRunnerSetThreads(
        runner, JxlResizableParallelRunnerSuggestThreads(w, h));
    if (JxlEncoderSetParallelRunner(enc, JxlResizableParallelRunner, runner) !=
        JXL_ENC_SUCCESS)
      break;

    // Override ONLY xsize/ysize; every other field keeps the InitBasicInfo
    // default (8-bit, 3 color channels, 0 extra channels, no alpha,
    // uses_original_profile=JXL_FALSE) exactly as the mac does.
    JxlBasicInfo bi;
    JxlEncoderInitBasicInfo(&bi);
    bi.xsize = w;
    bi.ysize = h;
    if (JxlEncoderSetBasicInfo(enc, &bi) != JXL_ENC_SUCCESS) break;

    // SRGB, non-gray (mac @0x934c: is_gray=0).
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) break;

    JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, nullptr);
    if (!fs) break;
    if (JxlEncoderSetFrameLossless(
            fs, zjxl_re::kEncodeLossless ? JXL_TRUE : JXL_FALSE) !=
        JXL_ENC_SUCCESS)
      break;
    if (JxlEncoderSetFrameDistance(fs, zjxl_re::kEncodeDistance) !=
        JXL_ENC_SUCCESS)
      break;
    if (JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_EFFORT,
                                         zjxl_re::kEncodeEffort) !=
        JXL_ENC_SUCCESS)
      break;
    if (JxlEncoderFrameSettingsSetOption(
            fs, JXL_ENC_FRAME_SETTING_DECODING_SPEED,
            zjxl_re::kEncodeDecodingSpeed) != JXL_ENC_SUCCESS)
      break;

    // Input pixel format, constant block @0x16a38: 3-channel, JXL_TYPE_UINT8,
    // JXL_NATIVE_ENDIAN, align 0.
    JxlPixelFormat fmt{static_cast<uint32_t>(zjxl_re::kEncodeNumChannels),
                       static_cast<JxlDataType>(zjxl_re::kEncodePixelDataType),
                       static_cast<JxlEndianness>(zjxl_re::kEncodeEndianness),
                       static_cast<size_t>(zjxl_re::kEncodePixelAlign)};
    if (JxlEncoderAddImageFrame(fs, &fmt, rgb->data(), rgb->size()) !=
        JXL_ENC_SUCCESS)
      break;
    JxlEncoderCloseInput(enc);

    // Grow the output buffer until the encoder reports JXL_ENC_SUCCESS.
    out.clear();
    out.resize(64 * 1024);
    uint8_t* next = out.data();
    size_t avail = out.size();
    JxlEncoderStatus st = JXL_ENC_NEED_MORE_OUTPUT;
    while (st == JXL_ENC_NEED_MORE_OUTPUT) {
      st = JxlEncoderProcessOutput(enc, &next, &avail);
      if (st == JXL_ENC_NEED_MORE_OUTPUT) {
        size_t used = out.size() - avail;
        out.resize(out.size() * 2);
        next = out.data() + used;
        avail = out.size() - used;
      }
    }
    if (st != JXL_ENC_SUCCESS) break;
    out.resize(out.size() - avail);
    ok = true;
  } while (false);

  JxlResizableParallelRunnerDestroy(runner);
  JxlEncoderDestroy(enc);
  if (!ok) out.clear();
  return ok;
}

class EncodeWorker : public Napi::AsyncWorker {
 public:
  EncodeWorker(Napi::Function cb, std::vector<uint8_t> px, uint32_t w,
               uint32_t h, uint32_t ch)
      : Napi::AsyncWorker(cb),
        px_(std::move(px)),
        w_(w),
        h_(h),
        ch_(ch) {}

  void Execute() override {
    if (!EncodeJxl(px_, w_, h_, ch_, out_)) {
      status_ = ERR_ENCODE;
      SetError("bitmapToJxl: encode failed");
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Callback().Call({env.Null(),
                     Napi::Buffer<uint8_t>::Copy(env, out_.data(), out_.size()),
                     Napi::Number::New(env, OK)});
  }

  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Callback().Call({e.Value(), env.Null(), Napi::Number::New(env, status_)});
  }

 private:
  std::vector<uint8_t> px_, out_;
  uint32_t w_, h_, ch_;
  int status_ = ERR_ENCODE;
};

static Napi::Value BitmapToJxl(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();

  std::vector<uint8_t> px;
  try {
    px = GetBuffer(opts, "buffer");
  } catch (const Napi::Error& e) {
    cb.Call({e.Value(), env.Null(), Napi::Number::New(env, ERR_INPUT)});
    return env.Undefined();
  }
  uint32_t w = static_cast<uint32_t>(GetInt(opts, "width", 0));
  uint32_t h = static_cast<uint32_t>(GetInt(opts, "height", 0));
  if (w == 0 || h == 0) {
    cb.Call({Napi::String::New(env, "bitmapToJxl: bad dimensions"), env.Null(),
             Napi::Number::New(env, ERR_INPUT)});
    return env.Undefined();
  }
  // Derive channel count; the buffer must be exactly w*h*3 (RGB) or w*h*4 (RGBA).
  const size_t pixels = static_cast<size_t>(w) * h;
  uint32_t ch;
  if (px.size() == pixels * 3) {
    ch = 3;
  } else if (px.size() == pixels * 4) {
    ch = 4;  // RGBA: alpha dropped to RGB in EncodeJxl (mac output is 3ch)
  } else {
    cb.Call({Napi::String::New(
                 env, "bitmapToJxl: buffer length must be width*height*3 (RGB) "
                      "or width*height*4 (RGBA)"),
             env.Null(), Napi::Number::New(env, ERR_INPUT)});
    return env.Undefined();
  }
  (new EncodeWorker(cb, std::move(px), w, h, ch))->Queue();
  return env.Undefined();
}

void RegisterEncode(Napi::Env env, Napi::Object exports) {
  exports.Set("bitmapToJxl", Napi::Function::New(env, BitmapToJxl));
}

}  // namespace zjxl
