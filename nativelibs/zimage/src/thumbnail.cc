// thumbnail(buffer, width, height, format[, quality], callback) -> callback(err, Buffer)
//
// Reproduces the RE'd macOS zimage.node ThumbnailAsyncWorker::Execute pipeline
// EXACTLY (see nativelibs/zimage/RE-PARAMS.md and src/re_params.h, the single
// sources of truth for every option value used below):
//
//   vips_thumbnail_buffer(buf, len, &out, width, "height", height, "size", 3, NULL);
//   if (format == "jpeg") {
//     if (vips_image_hasalpha(out))    // GATED - see RE-PARAMS.md correction
//       vips_flatten(out, &flat, "background", [255,255,255], NULL);  // 3-elem
//     vips_jpegsave_buffer(flat_or_out, &obuf, &olen, "strip", 1, NULL);
//   } else {   // mac's literal else-branch: anything not =="jpeg" -> png
//     vips_pngsave_buffer(out, &obuf, &olen, NULL);             // zero options
//   }
//
// NOTE: an earlier pass at RE-PARAMS.md read the flatten as unconditional with
// a 1-element background; re-disassembling ThumbnailAsyncWorker::Execute in
// full during this task (r2 on the real darwin_x64/zimage.node) found a
// `vips_image_hasalpha()` gate at @0x1512 and a 3-element [255,255,255]
// background (n=3 passed to vips_array_double_new @0x153b/0x153e). Applying
// flatten unconditionally is provably wrong: vips_flatten always drops the
// LAST band regardless of whether it is really alpha, which would corrupt
// every alpha-less JPEG (verified with the pinned `vips flatten` CLI: 3-band
// sRGB in -> 2-band out). See RE-PARAMS.md's "CORRECTION" note for the trace.
//
// The JS `quality` argument is intentionally IGNORED (the mac ThumbnailAsyncWorker
// ctor never receives it), so it is never forwarded to any saver.
#include <napi.h>
#include <vips/vips.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include "common.h"
#include "re_params.h"

namespace zimage {

namespace {

struct VipsImageDeleter {
  void operator()(VipsImage* im) const {
    if (im) g_object_unref(im);
  }
};
using VipsImagePtr = std::unique_ptr<VipsImage, VipsImageDeleter>;

// Fetches and clears the libvips error buffer, then throws.
[[noreturn]] void ThrowVipsError(const std::string& op) {
  std::string msg = "zimage thumbnail: " + op + ": " + vips_error_buffer();
  vips_error_clear();
  throw std::runtime_error(msg);
}

// Runs the RE'd thumbnail + save pipeline. Returns the encoded output bytes.
std::vector<uint8_t> DoThumbnail(const uint8_t* in, size_t inLen, int width,
                                  int height, const std::string& format) {
  VipsImage* rawThumb = nullptr;
  if (vips_thumbnail_buffer(const_cast<uint8_t*>(in), inLen, &rawThumb, width,
                             "height", height, "size", zimage_re::kThumbSize,
                             NULL)) {
    ThrowVipsError("vips_thumbnail_buffer");
  }
  VipsImagePtr thumb(rawThumb);

  void* outBuf = nullptr;
  size_t outLen = 0;

  if (format == "jpeg") {
    // Flatten-onto-white is GATED on vips_image_hasalpha(), per the
    // corrected RE-PARAMS.md finding (@0x1512..0x1519 in
    // ThumbnailAsyncWorker::Execute). Background is a 3-element
    // [255,255,255] array (n=3 @0x153b), not a 1-element scalar.
    VipsImagePtr flat;  // kept alive only if flatten actually runs
    VipsImage* toSave = thumb.get();

    if (vips_image_hasalpha(thumb.get())) {
      const double bgVals[3] = {zimage_re::kJpegFlattenBg,
                                 zimage_re::kJpegFlattenBg,
                                 zimage_re::kJpegFlattenBg};
      VipsArrayDouble* bg = vips_array_double_new(bgVals, 3);
      VipsImage* rawFlat = nullptr;
      int rc = vips_flatten(thumb.get(), &rawFlat, "background", bg, NULL);
      vips_area_unref(reinterpret_cast<VipsArea*>(bg));
      if (rc) ThrowVipsError("vips_flatten");
      flat.reset(rawFlat);
      toSave = flat.get();
    }

    if (vips_jpegsave_buffer(toSave, &outBuf, &outLen, "strip",
                              zimage_re::kJpegStrip ? TRUE : FALSE, NULL)) {
      ThrowVipsError("vips_jpegsave_buffer");
    }
  } else {
    // Mac's literal else-branch: any format string other than exactly
    // "jpeg" falls through to pngsave with ZERO options.
    if (vips_pngsave_buffer(thumb.get(), &outBuf, &outLen, NULL)) {
      ThrowVipsError("vips_pngsave_buffer");
    }
  }

  std::vector<uint8_t> out(static_cast<uint8_t*>(outBuf),
                            static_cast<uint8_t*>(outBuf) + outLen);
  g_free(outBuf);
  return out;
}

class ThumbnailWorker : public Napi::AsyncWorker {
 public:
  ThumbnailWorker(Napi::Function cb, std::vector<uint8_t> in, int w, int h,
                  std::string fmt)
      : Napi::AsyncWorker(cb),
        in_(std::move(in)),
        w_(w),
        h_(h),
        fmt_(std::move(fmt)) {}

  void Execute() override {
    try {
      out_ = DoThumbnail(in_.data(), in_.size(), w_, h_, fmt_);
    } catch (const std::exception& e) {
      SetError(e.what());
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Callback().Call(
        {env.Null(), Napi::Buffer<uint8_t>::Copy(env, out_.data(), out_.size())});
  }

  void OnError(const Napi::Error& e) override {
    Callback().Call({e.Value(), Env().Null()});
  }

 private:
  std::vector<uint8_t> in_;
  std::vector<uint8_t> out_;
  int w_;
  int h_;
  std::string fmt_;
};

}  // namespace

// Two calling conventions are accepted:
//
// 1. Object form — what the real Zalo loader actually calls at the native
//    boundary. `app/native/nativelibs/zimage/index.js`'s `Image.thumbnail`
//    is positional at the JS-wrapper level, but it packs its args into a
//    single object before calling the addon:
//      zimage.thumbnail({buffer,width,height,format,quality}, callback)
//    For a Linux zimage.node to be a drop-in replacement, this is the shape
//    that must actually work.
//
// 2. Positional form — (buffer, width, height, format[, quality], callback),
//    matching the mac ThumbnailAsyncWorker C++ ctor's parameter list
//    (Buffer&, int, int, string, Function&) recovered in RE-PARAMS.md, and
//    used by this task's direct-binding test.
//
// Either way `quality` (if present) is read but never forwarded to a saver.
static Napi::Value Thumbnail(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  Napi::Buffer<uint8_t> inBuf;
  int width = 0;
  int height = 0;
  std::string format;
  Napi::Function cb;

  if (info.Length() >= 2 && info[0].IsObject() && !info[0].IsBuffer()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (!opts.Has("buffer") || !opts.Get("buffer").IsBuffer() ||
        !info[1].IsFunction()) {
      Napi::TypeError::New(
          env, "thumbnail: expected ({buffer,width,height,format}, callback)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    inBuf = opts.Get("buffer").As<Napi::Buffer<uint8_t>>();
    width = opts.Get("width").As<Napi::Number>().Int32Value();
    height = opts.Get("height").As<Napi::Number>().Int32Value();
    format = GetString(opts.Get("format"));
    cb = info[1].As<Napi::Function>();
  } else {
    if (info.Length() < 5 || !info[0].IsBuffer()) {
      Napi::TypeError::New(
          env,
          "thumbnail: expected (buffer, width, height, format, ..., callback)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Value last = info[info.Length() - 1];
    if (!last.IsFunction()) {
      Napi::TypeError::New(env, "thumbnail: callback required")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    inBuf = info[0].As<Napi::Buffer<uint8_t>>();
    width = info[1].As<Napi::Number>().Int32Value();
    height = info[2].As<Napi::Number>().Int32Value();
    format = GetString(info[3]);
    cb = last.As<Napi::Function>();
  }

  std::vector<uint8_t> in(inBuf.Data(), inBuf.Data() + inBuf.Length());
  (new ThumbnailWorker(cb, std::move(in), width, height, format))->Queue();
  return env.Undefined();
}

void RegisterThumbnail(Napi::Env env, Napi::Object exports) {
  exports.Set("thumbnail", Napi::Function::New(env, Thumbnail));
}

}  // namespace zimage
