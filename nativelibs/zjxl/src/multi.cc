#include <napi.h>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

#include "common.h"
#include "re_params.h"

// jxlDecompressMulti — the BATCH decode-and-resize path.
//
// RE'd from the mac binary app/native/nativelibs/zjxl/build/darwin_x64/jxl.node:
//   Napi entry  jxlDecompressMulti            @0x5d4d
//   worker      JxlDecompressMultiAsyncWorker::Execute @0x496e / ::OnOK @0x4a1a
//   handler     jxlDecompressMultiHandler     @0xcd90
//               -> DecodeBlobJxlMulti         @0xcb52 (buffer)
//               -> DecodeLocalPathJXLMulti*   @0xc324/@0xbcb0 (localPath)
//   per-task    ProcessDecompressTasks        @0xb7fa
//               -> resizePPFWithOpenCV        @0xb578 (two-stage OpenCV)
//               -> encodeJpegOneShotTurbo     @0x81fa (JPEG re-encode)
//
// CONTRACT (verified against the binary, NOT the naive brief example):
//   * The single input JXL (buffer or localPath) is decoded ONCE to RGB8+ICC.
//   * For each `tasks[]` entry the decoded image is resized (OpenCV two-stage:
//     INTER_LINEAR pre-scale to a 1000px cap, then INTER_AREA to target) and
//     RE-ENCODED TO JPEG (baseline 4:2:0, fast DCT, ICC embedded) at the mac's
//     `quality`. The output is JPEG bytes — NOT raw RGB, NOT JXL. (ProcessDecom-
//     pressTasks @0xb967/@0xbac2 calls encodeJpegOneShotTurbo on every task.)
//   * If a task has an `outputPath`, the JPEG is written to that file and the
//     returned object carries no `data` buffer (data=undefined), only size/dims.
//     Otherwise the JPEG is returned inline as `data`.
//   * OnOK marshals an Array of objects, one per task:
//       { data: Buffer|undefined, size: Number, outputPath: String,
//         width: Number, height: Number }
//     and invokes the callback (error, data=array, status_code). On success
//     status_code = 1 (SUCCESS_STATUS — the JxlOutput default; the mac only
//     overwrites JxlOutput.status @[+0x20] on error). See index.js wrapper which
//     resolves {data, status_code} and the renderer's `status_code === 1` gate.
namespace zjxl {

// Status codes as observed by the JS renderer's FAILURE/SUCCESS enum
// (utility-process-media.js: FAILURE_STATUS=0, SUCCESS_STATUS=1).
enum MultiStatus { MULTI_FAILURE = 0, MULTI_SUCCESS = 1 };

// One decode task, mirroring the mac `DecompressTask` struct read in the Napi
// entry @0x6023..0x619d (offsets: maxWidth@0, maxHeight@4, width@8, height@12,
// outputPath@16). Absent numeric keys default to -1 ("auto"); outputPath to "".
struct MultiTask {
  int maxWidth = -1;
  int maxHeight = -1;
  int width = -1;
  int height = -1;
  std::string outputPath;
};

// One produced output, mirroring the mac `JxlDecompressMultiOutput` struct
// (data@0, size@8, outputPath@16, width@0x28, height@0x2c) as read in OnOK.
struct MultiOutput {
  std::vector<uint8_t> jpeg;  // encoded JPEG (kept empty when written to a file)
  size_t size = 0;            // JPEG byte length (always set, even for files)
  std::string outputPath;     // "" when returned inline
  bool wroteFile = false;     // true => JS `data` is undefined (mac null ptr)
  uint32_t width = 0;
  uint32_t height = 0;
};

// ---------------------------------------------------------------------------
// resizePPFWithOpenCV @0xb578 — verbatim two-stage OpenCV downscale.
// Wraps `rgb` (srcW x srcH, interleaved RGB8) as a CV_8UC3 Mat (arg4 = 0x10 =
// CV_8UC3 @0xb935), then:
//   Stage 1 (@0xb602): iff (srcW>1000 && targetW<1000) || (srcH>1000 &&
//     targetH<1000): clampSize(src, 1000, 1000) then cv::resize INTER_LINEAR
//     (interpolation=1 @0xb681). Otherwise the source Mat passes through.
//   Stage 2 (@0xb6b8): iff currentW>targetW || currentH>targetH:
//     clampSize(current, targetW, targetH) then cv::resize INTER_AREA
//     (interpolation=3 @0xb732). Otherwise the current Mat passes through.
//   @0xb74c: out = final Mat pixels (currentW*currentH*3), outW/outH = dims.
// Returns false only if the input Mat is empty (mac @0xb5bf).
// ---------------------------------------------------------------------------
static bool ResizePPFWithOpenCV(const uint8_t* rgb, uint32_t srcW, uint32_t srcH,
                                uint32_t targetW, uint32_t targetH,
                                std::vector<uint8_t>& out, uint32_t& outW,
                                uint32_t& outH) {
  cv::Mat src(static_cast<int>(srcH), static_cast<int>(srcW), CV_8UC3,
              const_cast<uint8_t*>(rgb));
  if (src.empty()) {
    std::fprintf(stderr, "Failed to create input cv::Mat\n");
    return false;
  }

  uint32_t curW = srcW, curH = srcH;
  cv::Mat stage1;
  // Stage 1 condition (mac @0xb602..0xb628): cap = kResizePreScaleCap (1000).
  const bool doStage1 =
      (srcW > static_cast<uint32_t>(zjxl_re::kResizePreScaleCap) &&
       targetW < static_cast<uint32_t>(zjxl_re::kResizePreScaleCap)) ||
      (srcH > static_cast<uint32_t>(zjxl_re::kResizePreScaleCap) &&
       targetH < static_cast<uint32_t>(zjxl_re::kResizePreScaleCap));
  if (doStage1) {
    uint32_t w1, h1;
    ClampSize(srcW, srcH, zjxl_re::kResizePreScaleCap,
              zjxl_re::kResizePreScaleCap, w1, h1);
    cv::resize(src, stage1, cv::Size(static_cast<int>(w1), static_cast<int>(h1)),
               0, 0, zjxl_re::kResizePreScaleInterp);  // INTER_LINEAR
    curW = w1;
    curH = h1;
  } else {
    stage1 = src;  // mac cv::Mat::operator= @0xb6b3 (shallow pass-through)
  }

  cv::Mat stage2;
  // Stage 2 condition (mac @0xb6b8): resize only if current still exceeds target.
  if (curW > targetW || curH > targetH) {
    uint32_t w2, h2;
    ClampSize(curW, curH, targetW, targetH, w2, h2);
    cv::resize(stage1, stage2,
               cv::Size(static_cast<int>(w2), static_cast<int>(h2)), 0, 0,
               zjxl_re::kResizeInterp);  // INTER_AREA
    curW = w2;
    curH = h2;
  } else {
    stage2 = stage1;  // mac cv::Mat::operator= @0xb6d1 (shallow pass-through)
  }

  const size_t n = static_cast<size_t>(curW) * curH * 3;
  const uint8_t* p = stage2.data;
  out.assign(p, p + n);  // mac vector::assign @0xb764
  outW = curW;
  outH = curH;
  return true;
}

// ---------------------------------------------------------------------------
// Per-task target-dimension decision, ported verbatim from ProcessDecompressTasks
// @0xb897..0xb8f9. Priority: task.width/height first, then task.maxWidth/maxHeight;
// a target axis only "counts" when it is > 0 and strictly smaller than the source
// (downscale-only). Returns true if a resize is requested (and fills tw/th), false
// for a straight source-size encode (mac branch @0xba99).
// ---------------------------------------------------------------------------
static bool ComputeMultiTarget(const MultiTask& t, int srcW, int srcH, int& tw,
                               int& th) {
  // Block 1: explicit width/height (both must be present, i.e. != -1).
  if (t.width != -1 && t.height != -1) {
    if ((t.width > 0 && t.width < srcW) || (t.height > 0 && t.height < srcH)) {
      tw = t.width;
      th = t.height;
      return true;
    }
  }
  // Block 2: maxWidth/maxHeight fallback.
  if (t.maxWidth > 0 && t.maxWidth < srcW) {
    tw = t.maxWidth;
    th = t.maxHeight;
    return true;
  }
  if (t.maxHeight > 0 && t.maxHeight < srcH) {
    tw = t.maxWidth;  // target width = maxWidth even if invalid (matches asm)
    th = t.maxHeight;
    return true;
  }
  return false;  // no resize
}

// Best-effort file write (mac WriteFileByChunk @0x13124; its return is unchecked
// in ProcessDecompressTasks, so a write failure does not fail the batch).
static void WriteFile(const std::string& path, const std::vector<uint8_t>& bytes) {
  std::ofstream f(path, std::ios::binary | std::ios::trunc);
  if (f) f.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
}

// ProcessDecompressTasks @0xb7fa: for each task, resize (or not) then encode to
// JPEG; write-to-file or keep inline. Returns false on any resize/encode failure
// (mac returns false if the loop does not complete — @0xbb43 setae).
static bool ProcessTasks(const std::vector<uint8_t>& rgb, uint32_t srcW,
                         uint32_t srcH, const std::vector<uint8_t>& icc,
                         int quality, const std::vector<MultiTask>& tasks,
                         std::vector<MultiOutput>& outputs) {
  for (const MultiTask& task : tasks) {
    int tw = 0, th = 0;
    const bool doResize = ComputeMultiTarget(task, static_cast<int>(srcW),
                                             static_cast<int>(srcH), tw, th);

    const uint8_t* pixels;
    uint32_t w, h;
    std::vector<uint8_t> resized;
    if (doResize) {
      if (!ResizePPFWithOpenCV(rgb.data(), srcW, srcH,
                               static_cast<uint32_t>(tw),
                               static_cast<uint32_t>(th), resized, w, h)) {
        std::fprintf(stderr, "Error resizing the image\n");
        return false;
      }
      pixels = resized.data();
    } else {
      pixels = rgb.data();
      w = srcW;
      h = srcH;
    }

    std::vector<uint8_t> src(pixels, pixels + static_cast<size_t>(w) * h * 3);
    std::vector<uint8_t> jpeg;
    if (!RgbToJpeg(src, w, h, quality, icc, jpeg)) {
      std::fprintf(stderr, "Error encoding JPEG\n");
      return false;
    }

    MultiOutput o;
    o.size = jpeg.size();
    o.width = w;
    o.height = h;
    if (!task.outputPath.empty()) {
      WriteFile(task.outputPath, jpeg);
      o.outputPath = task.outputPath;
      o.wroteFile = true;  // JS data = undefined (mac null data ptr)
    } else {
      o.jpeg = std::move(jpeg);
    }
    outputs.push_back(std::move(o));
  }
  return true;
}

// ---------------------------------------------------------------------------
// AsyncWorker
// ---------------------------------------------------------------------------
class MultiWorker : public Napi::AsyncWorker {
 public:
  MultiWorker(Napi::Function cb, std::vector<uint8_t> buffer, std::string localPath,
              std::vector<MultiTask> tasks, int quality)
      : Napi::AsyncWorker(cb),
        buffer_(std::move(buffer)),
        localPath_(std::move(localPath)),
        tasks_(std::move(tasks)),
        quality_(quality) {}

  void Execute() override {
    // Load the single source JXL (buffer takes priority, as in the mac handler
    // which tries DecodeBlobJxlMulti before the localPath decoders).
    std::vector<uint8_t> in;
    if (!buffer_.empty()) {
      in = std::move(buffer_);
    } else if (!localPath_.empty()) {
      std::ifstream f(localPath_, std::ios::binary | std::ios::ate);
      if (!f) {
        SetError("jxlDecompressMulti: cannot open localPath");
        return;
      }
      const std::streamsize len = f.tellg();
      f.seekg(0);
      in.resize(static_cast<size_t>(len));
      if (len > 0) f.read(reinterpret_cast<char*>(in.data()), len);
    } else {
      SetError("jxlDecompressMulti: buffer or localPath required");
      return;
    }

    std::vector<uint8_t> rgb, icc;
    uint32_t w = 0, h = 0;
    if (!DecodeToRgb(in, rgb, w, h, icc) || w == 0 || h == 0) {
      SetError("Error while decoding the jxl file");
      return;
    }

    if (!ProcessTasks(rgb, w, h, icc, quality_, tasks_, outputs_)) {
      SetError("Error while processing decompress tasks");
      return;
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Napi::Array arr = Napi::Array::New(env, outputs_.size());
    for (size_t i = 0; i < outputs_.size(); ++i) {
      const MultiOutput& o = outputs_[i];
      Napi::Object obj = Napi::Object::New(env);
      if (o.wroteFile) {
        obj.Set("data", env.Undefined());  // mac null data ptr -> undefined
      } else {
        obj.Set("data",
                Napi::Buffer<uint8_t>::Copy(env, o.jpeg.data(), o.jpeg.size()));
      }
      obj.Set("size", Napi::Number::New(env, static_cast<double>(o.size)));
      obj.Set("outputPath", Napi::String::New(env, o.outputPath));
      obj.Set("width", Napi::Number::New(env, static_cast<double>(o.width)));
      obj.Set("height", Napi::Number::New(env, static_cast<double>(o.height)));
      arr.Set(static_cast<uint32_t>(i), obj);
    }
    Callback().Call(
        {env.Null(), arr, Napi::Number::New(env, MULTI_SUCCESS)});
  }

  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Callback().Call(
        {e.Value(), env.Null(), Napi::Number::New(env, MULTI_FAILURE)});
  }

 private:
  std::vector<uint8_t> buffer_;
  std::string localPath_;
  std::vector<MultiTask> tasks_;
  int quality_;
  std::vector<MultiOutput> outputs_;
};

// ---------------------------------------------------------------------------
// Napi entry jxlDecompressMulti @0x5d4d — parse options object.
// ---------------------------------------------------------------------------
static int TaskInt(const Napi::Object& o, const char* key) {
  Napi::Value v = o.Get(key);
  return v.IsNumber() ? v.As<Napi::Number>().Int32Value() : -1;  // -1 = auto
}

static Napi::Value JxlDecompressMulti(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();

  // buffer (optional) — the source JXL blob.
  std::vector<uint8_t> buffer;
  if (opts.Has("buffer")) {
    Napi::Value v = opts.Get("buffer");
    if (v.IsBuffer()) {
      auto b = v.As<Napi::Buffer<uint8_t>>();
      buffer.assign(b.Data(), b.Data() + b.Length());
    }
  }

  // localPath (optional) — read the source JXL from a file.
  std::string localPath;
  if (opts.Has("localPath")) {
    Napi::Value v = opts.Get("localPath");
    if (v.IsString()) localPath = v.As<Napi::String>().Utf8Value();
  }

  // quality: JS float 0..1 scaled x100 (mac @0x5eed mulss 100.0); default 95
  // (mac @0x5ec1 mov cl,0x5f). Passed as a byte to turbojpeg.
  int quality = 95;
  if (opts.Has("quality")) {
    Napi::Value v = opts.Get("quality");
    if (v.IsNumber()) {
      quality = static_cast<int>(v.As<Napi::Number>().FloatValue() *
                                 zjxl_re::kJpegQualityScale);
    }
  }

  // tasks: array of resize/encode requests. Absent => a single default task
  // (all dims -1 => source-size encode), matching the mac @0x6204.
  std::vector<MultiTask> tasks;
  if (opts.Has("tasks") && opts.Get("tasks").IsArray()) {
    Napi::Array a = opts.Get("tasks").As<Napi::Array>();
    for (uint32_t i = 0; i < a.Length(); ++i) {
      Napi::Value tv = a.Get(i);
      if (!tv.IsObject()) continue;
      Napi::Object to = tv.As<Napi::Object>();
      MultiTask t;
      t.maxWidth = TaskInt(to, "maxWidth");
      t.maxHeight = TaskInt(to, "maxHeight");
      t.width = TaskInt(to, "width");
      t.height = TaskInt(to, "height");
      Napi::Value op = to.Get("outputPath");
      if (op.IsString()) t.outputPath = op.As<Napi::String>().Utf8Value();
      tasks.push_back(std::move(t));
    }
  }
  if (tasks.empty()) tasks.emplace_back();  // one default task (source-size)

  (new MultiWorker(cb, std::move(buffer), std::move(localPath), std::move(tasks),
                   quality))
      ->Queue();
  return env.Undefined();
}

void RegisterMulti(Napi::Env env, Napi::Object exports) {
  exports.Set("jxlDecompressMulti",
              Napi::Function::New(env, JxlDecompressMulti));
}

}  // namespace zjxl
