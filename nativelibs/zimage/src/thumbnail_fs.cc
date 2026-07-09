// thumbnailFs(inputPath, outputPath, width, height[, quality], callback) -> callback(err)
//
// Reproduces the RE'd macOS zimage.node ThumbnailFsAsyncWorker::Execute pipeline
// EXACTLY (see nativelibs/zimage/RE-PARAMS.md and src/re_params.h). This task's
// own full disassembly of ThumbnailFsAsyncWorker::Execute @0x38f8 (the previous
// RE-PARAMS.md pass only covered @0x3906..0x397a and left a gap) shows the
// ENTIRE function, byte-for-byte:
//
//   vips_thumbnail(inputPath, &out, width, "height", height, "size", 3, NULL);
//   if (rc) { throw "An error occurred in thumbnailing using file system"; }
//   vips_image_write_to_file(out, outputPath, NULL);   // ZERO options
//   vips_image_set_kill(out, 1);
//   g_object_unref(out);
//
// Unlike the buffer variant (thumbnail.cc / ThumbnailAsyncWorker::Execute),
// there is NO vips_image_hasalpha() call and NO vips_flatten() call anywhere
// in this function -- confirmed by disassembling every instruction between
// the vips_thumbnail() call and the vips_image_write_to_file() call; that
// span is entirely the error-handling branch (thrown when vips_thumbnail
// fails), not any flatten/alpha logic. Format and save options (jpeg Q,
// strip, png compression, etc.) are therefore 100% libvips' extension-
// inferred defaults for vips_image_write_to_file -- no per-format saver is
// ever called directly by this addon.
//
// The JS `quality` argument is intentionally IGNORED (the mac
// ThumbnailFsAsyncWorker ctor is (string inputPath, string outputPath, int
// width, int height, Function cb) -- no quality param), so it is never
// forwarded to any saver.
#include <napi.h>
#include <vips/vips.h>
#include <memory>
#include <stdexcept>
#include <string>
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
  std::string msg = "zimage thumbnailFs: " + op + ": " + vips_error_buffer();
  vips_error_clear();
  throw std::runtime_error(msg);
}

// Runs the RE'd thumbnail-to-file pipeline. Writes outputPath directly;
// format/options are whatever libvips infers from outputPath's extension.
void DoThumbnailFs(const std::string& inPath, const std::string& outPath,
                    int width, int height) {
  VipsImage* rawThumb = nullptr;
  if (vips_thumbnail(inPath.c_str(), &rawThumb, width, "height", height,
                      "size", zimage_re::kThumbSize, NULL)) {
    ThrowVipsError("vips_thumbnail");
  }
  VipsImagePtr thumb(rawThumb);

  // No flatten, no per-format options -- matches the mac binary exactly
  // (see file header comment / RE-PARAMS.md for the full disassembly).
  if (vips_image_write_to_file(thumb.get(), outPath.c_str(), NULL)) {
    ThrowVipsError("vips_image_write_to_file");
  }
}

class ThumbnailFsWorker : public Napi::AsyncWorker {
 public:
  ThumbnailFsWorker(Napi::Function cb, std::string in, std::string out, int w,
                     int h)
      : Napi::AsyncWorker(cb),
        in_(std::move(in)),
        out_(std::move(out)),
        w_(w),
        h_(h) {}

  void Execute() override {
    try {
      DoThumbnailFs(in_, out_, w_, h_);
    } catch (const std::exception& e) {
      SetError(e.what());
    }
  }

  void OnOK() override { Callback().Call({Env().Null()}); }

  void OnError(const Napi::Error& e) override { Callback().Call({e.Value()}); }

 private:
  std::string in_;
  std::string out_;
  int w_;
  int h_;
};

}  // namespace

// Two calling conventions are accepted, mirroring thumbnail.cc:
//
// 1. Object form -- what the real Zalo loader actually calls at the native
//    boundary. `app/native/nativelibs/zimage/index.js`'s `Image.resizeQA`
//    is positional at the JS-wrapper level
//    (inputPath, outputPath, width, height, quality, _, callback) but packs
//    its args into a single object before calling the addon:
//      zimage.thumbnailFs({inputPath, outputPath, width, height, quality}, callback)
//    (confirmed by reading index.js directly: `_` is dropped entirely and
//    never forwarded; `quality` is included in the object but ignored here,
//    matching the mac ctor which has no quality parameter.)
//
// 2. Positional form -- (inputPath, outputPath, width, height[, quality], callback),
//    matching the mac ThumbnailFsAsyncWorker C++ ctor's parameter list
//    (string, string, int, int, Function&) recovered in RE-PARAMS.md, and
//    used by this task's direct-binding test.
//
// Either way `quality` (if present) is read but never forwarded to a saver.
static Napi::Value ThumbnailFs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  std::string inPath;
  std::string outPath;
  int width = 0;
  int height = 0;
  Napi::Function cb;

  if (info.Length() >= 2 && info[0].IsObject() && !info[0].IsBuffer()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (!opts.Has("inputPath") || !opts.Has("outputPath") ||
        !info[1].IsFunction()) {
      Napi::TypeError::New(env,
                            "thumbnailFs: expected "
                            "({inputPath,outputPath,width,height}, callback)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    inPath = GetString(opts.Get("inputPath"));
    outPath = GetString(opts.Get("outputPath"));
    width = opts.Get("width").As<Napi::Number>().Int32Value();
    height = opts.Get("height").As<Napi::Number>().Int32Value();
    cb = info[1].As<Napi::Function>();
  } else {
    if (info.Length() < 4 || !info[0].IsString() || !info[1].IsString()) {
      Napi::TypeError::New(
          env,
          "thumbnailFs: expected (inputPath, outputPath, width, height, "
          "..., callback)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Value last = info[info.Length() - 1];
    if (!last.IsFunction()) {
      Napi::TypeError::New(env, "thumbnailFs: callback required")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    inPath = GetString(info[0]);
    outPath = GetString(info[1]);
    width = info[2].As<Napi::Number>().Int32Value();
    height = info[3].As<Napi::Number>().Int32Value();
    cb = last.As<Napi::Function>();
  }

  (new ThumbnailFsWorker(cb, std::move(inPath), std::move(outPath), width,
                          height))
      ->Queue();
  return env.Undefined();
}

void RegisterThumbnailFs(Napi::Env env, Napi::Object exports) {
  exports.Set("thumbnailFs", Napi::Function::New(env, ThumbnailFs));
}

}  // namespace zimage
