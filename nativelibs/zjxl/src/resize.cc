#include <napi.h>
#include <cstdint>
#include <vector>
#include "common.h"
#include "re_params.h"

// resizeJxl / resizeJxlLimit — the outgoing-image resize path.
//
// IMPORTANT RE CORRECTION (see RE-PARAMS.md "Resize path" + "clampSize formula"):
// The exported `resizeJxl` in the mac binaries (darwin_x64 @0x9f20 and
// darwin_arm64 @0x9184) does NOT use OpenCV. Its call chain is:
//
//   ResizeJxlAsyncWorker::Execute  (x64 @0x44fd)
//     -> resizeJxl                 (x64 @0x9f20): decode -> resizePPF -> re-encode
//        -> resizePPF              (x64 @0x8a82): computes target dims via clampSize,
//                                                 then hand-rolled bilinearInterpolate
//           -> bilinearInterpolate (x64 @0x12eea)
//
// The OpenCV two-stage helper `resizePPFWithOpenCV` (INTER_LINEAR pre-scale to a
// 1000px box, then INTER_AREA) IS present in the binary but is only called from
// the DECODE/BATCH paths (`jxlDecompressMulti` ProcessDecompressTasks @0xb938 and
// `DecodeLocalPathJXLProgressive` @0xac46) — NOT from resizeJxl. So for
// byte-identical resizeJxl output we MUST reproduce the hand-rolled
// bilinearInterpolate exactly (OpenCV would NOT match). `shouldResize` @0xa528 has
// no callers and is dead code; resizeJxl never gates on it and always re-encodes
// (even when the computed target equals the source, it round-trips the pixels
// through the lossy encoder).
namespace zjxl {

// ---------------------------------------------------------------------------
// clampSize @0x12e7c — verbatim port (see RE-PARAMS.md "## clampSize formula").
//   void clampSize(uint srcW, uint srcH, uint capW, uint capH, uint& outW, uint& outH)
// Scales (srcW,srcH) into the (capW,capH) box preserving aspect, but ONLY when
// both dims exceed the cap (or the 32-bit pixel-area overflow guard trips);
// otherwise it returns the source dims unchanged. Rounding is TRUNCATION
// (cvttsd2si) at every step.
// ---------------------------------------------------------------------------
// Non-static: also reused by the Task-8 batch/decode OpenCV resize (multi.cc)
// via the declaration in common.h. Do not duplicate this port.
void ClampSize(uint32_t srcW, uint32_t srcH, uint32_t capW, uint32_t capH,
               uint32_t& outW, uint32_t& outH) {
  bool scale;
  if (srcW <= capW && srcH <= capH) {
    scale = false;  // both fit (asm: cmp/ja + cmp/jbe -> no-scale)
  } else {
    uint32_t area = srcW * srcH;                 // 32-bit imul (matches asm)
    bool both = (srcW > capW) && (srcH > capH);  // seta & seta
    scale = (area > 0x10000000u) || both;        // ja 0x10000000 || (and;jne)
  }
  if (!scale) {
    outW = srcW;
    outH = srcH;
    return;
  }
  double aspect = static_cast<double>(srcW) / static_cast<double>(srcH);  // xmm0
  double h_cand = static_cast<double>(capW) / aspect;                     // xmm2 = capW/aspect
  uint32_t hc = static_cast<uint32_t>(static_cast<int64_t>(h_cand));      // cvttsd2si (trunc)
  uint32_t nh = (hc < capH) ? hc : capH;                                  // cmovb (unsigned)
  outH = nh;
  double w_d = static_cast<double>(nh) * aspect;                         // mulsd
  outW = static_cast<uint32_t>(static_cast<int64_t>(w_d));               // cvttsd2si (trunc)
}

// ---------------------------------------------------------------------------
// bilinearInterpolate @0x12eea — verbatim port. Resamples interleaved RGB8
// (`src`, srcW x srcH) to dstW x dstH. Reproduces the mac's exact quirks:
//   * sample coordinate = index * (srcDim / dstDim)  (no 0.5 center offset)
//   * fractional weight uses the UNCLAMPED truncated coordinate; the integer
//     index is clamped to [0, srcDim-1] separately
//   * the right/bottom neighbours are addressed by adding to the FLAT byte
//     offset (+3 for x+1, +3*srcW for y+1) and clamping the flat offset to
//     [.., srcSize-1] — NOT by clamping x/y per axis (edge pixels can wrap into
//     the next row). Accumulation order: TL, TR, BL, BR. Final value truncated.
// ---------------------------------------------------------------------------
static std::vector<uint8_t> BilinearInterpolate(const std::vector<uint8_t>& src,
                                                int srcW, int srcH, int dstW,
                                                int dstH) {
  std::vector<uint8_t> out(static_cast<size_t>(dstW) * dstH * 3);
  const uint8_t* s = src.data();
  const int64_t maxByte = static_cast<int64_t>(srcW) * srcH * 3 - 1;  // ebx = srcSize-1
  const double xRatio = static_cast<double>(srcW) / static_cast<double>(dstW);  // xmm10
  const double yRatio = static_cast<double>(srcH) / static_cast<double>(dstH);  // xmm8
  const int maxX = srcW - 1;  // var_34h
  const int maxY = srcH - 1;  // var_30h

  size_t rowOff = 0;
  for (int j = 0; j < dstH; ++j) {
    double srcYf = static_cast<double>(j) * yRatio;
    int y0 = static_cast<int>(srcYf);                                    // trunc
    double dy = srcYf - static_cast<double>(static_cast<int64_t>(srcYf));  // frac (unclamped)
    if (maxY < y0) y0 = maxY;    // cmovl min(y0,maxY)
    if (y0 <= 0) y0 = 0;         // cmovle max(y0,0)
    double wy0 = 1.0 - dy;
    int64_t rowTop = static_cast<int64_t>(y0) * srcW;                    // var_68h (pixels)
    int64_t rowBotByte = 3LL * static_cast<int64_t>(y0 + 1) * srcW;      // byte base of row y0+1

    for (int i = 0; i < dstW; ++i) {
      double srcXf = static_cast<double>(i) * xRatio;
      int x0 = static_cast<int>(srcXf);
      double dx = srcXf - static_cast<double>(static_cast<int64_t>(srcXf));
      if (maxX < x0) x0 = maxX;
      if (x0 <= 0) x0 = 0;
      double wx0 = 1.0 - dx;
      double w00 = wy0 * wx0;  // (1-dy)(1-dx)
      double w01 = wy0 * dx;   // (1-dy)dx
      double w10 = dy * wx0;   // dy(1-dx)
      double w11 = dy * dx;    // dy dx
      int64_t topLeft = 3LL * (static_cast<int64_t>(x0) + rowTop);  // 3*(x0 + y0*W)
      int64_t botLeft = 3LL * x0 + rowBotByte;                      // 3*(x0 + (y0+1)*W)
      for (int c = 0; c < 3; ++c) {
        int64_t tl = topLeft + c;                          // unclamped (always <= maxByte)
        int64_t tr = topLeft + c + 3; if (maxByte < tr) tr = maxByte;
        int64_t bl = botLeft + c;     if (maxByte < bl) bl = maxByte;
        int64_t br = botLeft + c + 3; if (maxByte < br) br = maxByte;
        double p_tl = s[tl];
        double p_tr = s[tr];
        double p_bl = s[bl];
        double p_br = s[br];
        double val = p_tl * w00;    // xmm1 = TL*w00
        val = p_tr * w01 + val;     // + TR*w01
        val = p_bl * w10 + val;     // + BL*w10
        val = p_br * w11 + val;     // + BR*w11
        out[rowOff + static_cast<size_t>(i) * 3 + c] =
            static_cast<uint8_t>(static_cast<int32_t>(val));  // cvttsd2si -> al
      }
    }
    rowOff += static_cast<size_t>(dstW) * 3;
  }
  return out;
}

// ---------------------------------------------------------------------------
// resizePPF @0x8a82 target-dimension logic. Given source dims and the requested
// (reqW,reqH) — where -1 is the "auto / keep aspect" sentinel — computes the
// final (fW,fH). Path B (both specified) = clampSize into the target box, then
// clampSize into a 65500x65500 box (overflow guard). Paths C = one axis given,
// the other derived by integer aspect math (min(src,req,65500)*other/src).
// ---------------------------------------------------------------------------
static void ComputeTargetDims(uint32_t srcW, uint32_t srcH, int reqW, int reqH,
                              uint32_t& fW, uint32_t& fH) {
  const bool wAuto = (reqW == -1);
  const bool hAuto = (reqH == -1);
  if (wAuto && hAuto) {                 // 0x8af9: both auto -> source
    fW = srcW;
    fH = srcH;
    return;
  }
  if (!wAuto && !hAuto) {               // 0x8b09: Path B (both specified)
    uint32_t tw, th;
    ClampSize(srcW, srcH, static_cast<uint32_t>(reqW),
              static_cast<uint32_t>(reqH), tw, th);
    ClampSize(tw, th, 65500u, 65500u, fW, fH);
    return;
  }
  if (hAuto) {                          // 0x8b52: width given, height auto
    uint32_t wp = (srcW < static_cast<uint32_t>(reqW)) ? srcW
                                                       : static_cast<uint32_t>(reqW);
    if (wp > 65500u) wp = 65500u;
    fH = static_cast<uint32_t>(static_cast<uint64_t>(wp) * srcH / srcW);
    fW = static_cast<uint32_t>(reqW);
    return;
  }
  // 0x8ad5: height given, width auto
  uint32_t hp = (srcH < static_cast<uint32_t>(reqH)) ? srcH
                                                     : static_cast<uint32_t>(reqH);
  if (hp > 65500u) hp = 65500u;
  fW = static_cast<uint32_t>(static_cast<uint64_t>(hp) * srcW / srcH);
  fH = static_cast<uint32_t>(reqH);
}

// Decode -> compute target dims (resizePPF) -> bilinear (or pass-through when the
// target equals the source) -> re-encode via the shared EncodeJxl (identical to
// the mac encodeJxlOneshot: distance 2.28, effort 1, decoding-speed 4, 3ch RGB).
static bool ResizeCoreFromRgb(const std::vector<uint8_t>& rgb, uint32_t w,
                              uint32_t h, uint32_t fW, uint32_t fH,
                              std::vector<uint8_t>& out) {
  if (fW == 0 || fH == 0) return false;
  if (fW == w && fH == h) {
    // No resize needed: resizeJxl still re-encodes the decoded pixels at source
    // size (resizePPF leaves the frame untouched; resizeJxl re-encodes it).
    return EncodeJxl(rgb, w, h, 3, out);
  }
  std::vector<uint8_t> resized = BilinearInterpolate(
      rgb, static_cast<int>(w), static_cast<int>(h), static_cast<int>(fW),
      static_cast<int>(fH));
  return EncodeJxl(resized, fW, fH, 3, out);
}

class ResizeWorker : public Napi::AsyncWorker {
 public:
  ResizeWorker(Napi::Function cb, std::vector<uint8_t> in, int reqW, int reqH,
               long limit)
      : Napi::AsyncWorker(cb),
        in_(std::move(in)),
        reqW_(reqW),
        reqH_(reqH),
        limit_(limit) {}

  void Execute() override {
    std::vector<uint8_t> rgb, icc;
    uint32_t w = 0, h = 0;
    if (!DecodeToRgb(in_, rgb, w, h, icc)) {
      status_ = ERR_DECODE;
      SetError("resizeJxl: decode failed");
      return;
    }
    if (w == 0 || h == 0) {
      status_ = ERR_RESIZE;
      SetError("resizeJxl: bad source dimensions");
      return;
    }
    uint32_t fW = 0, fH = 0;
    ComputeTargetDims(w, h, reqW_, reqH_, fW, fH);
    if (!ResizeCoreFromRgb(rgb, w, h, fW, fH, out_)) {
      status_ = ERR_RESIZE;
      SetError("resizeJxl: resize/encode failed");
      return;
    }

    // resizeJxlLimit (ASSUMED — no binary provenance; neither mac binary exports
    // this symbol, only the JS wrapper references it). Faithful extension: if a
    // positive byte `limit` is given and the output exceeds it, progressively
    // shrink the target box (same exact bilinear + encode pipeline per size)
    // until the encoded output fits or a floor is reached. Deterministic and, at
    // a non-binding limit, byte-identical to resizeJxl.
    if (limit_ > 0 && static_cast<long>(out_.size()) > limit_) {
      double curW = static_cast<double>(fW == 0 ? w : fW);
      double curH = static_cast<double>(fH == 0 ? h : fH);
      for (int iter = 0; iter < 40 && static_cast<long>(out_.size()) > limit_;
           ++iter) {
        curW *= 0.85;
        curH *= 0.85;
        uint32_t nw = static_cast<uint32_t>(curW);
        uint32_t nh = static_cast<uint32_t>(curH);
        if (nw < 8) nw = 8;
        if (nh < 8) nh = 8;
        std::vector<uint8_t> next;
        if (!ResizeCoreFromRgb(rgb, w, h, nw, nh, next)) break;
        out_.swap(next);
        if (nw <= 8 && nh <= 8) break;
      }
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
  std::vector<uint8_t> in_, out_;
  int reqW_, reqH_;
  long limit_;
  int status_ = ERR_RESIZE;
};

// Map the JS width/height to the native request. The mac stores width/height as
// uint32 and treats 0xffffffff (-1) as the "auto / keep aspect" sentinel; we map
// any non-positive request to that sentinel (matches the app's ">0 ? v : -1"
// convention used elsewhere for output dims).
static int ToRequest(const Napi::Object& opts, const char* key) {
  int v = GetInt(opts, key, -1);
  return (v > 0) ? v : -1;
}

static Napi::Value ResizeImpl(const Napi::CallbackInfo& info, bool withLimit) {
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
  int reqW = ToRequest(opts, "width");
  int reqH = ToRequest(opts, "height");
  long limit = withLimit ? static_cast<long>(GetInt(opts, "limit", 0)) : 0;
  if (reqW == -1 && reqH == -1) {
    cb.Call({Napi::String::New(env, "resizeJxl: width and/or height required"),
             env.Null(), Napi::Number::New(env, ERR_INPUT)});
    return env.Undefined();
  }
  (new ResizeWorker(cb, std::move(in), reqW, reqH, limit))->Queue();
  return env.Undefined();
}

void RegisterResize(Napi::Env env, Napi::Object exports) {
  exports.Set("resizeJxl", Napi::Function::New(env, [](const Napi::CallbackInfo& i) {
                return ResizeImpl(i, false);
              }));
  exports.Set("resizeJxlLimit",
              Napi::Function::New(env, [](const Napi::CallbackInfo& i) {
                return ResizeImpl(i, true);
              }));
}

}  // namespace zjxl
