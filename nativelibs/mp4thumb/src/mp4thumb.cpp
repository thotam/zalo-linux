// Linux reimplementation of the Zalo `mp4thumb` native addon.
//
// Faithful reconstruction (Capstone disassembly of darwin-x64/mp4thumb.node,
// original source `../src/mp4thumb.cpp`) of a video→JPEG-thumbnail addon built on
// FFmpeg 5.1 (libavcodec 59.37.100). Pinned static FFmpeg is linked in, so the
// decode→scale→encode→mux pipeline is byte-identical-by-construction to the mac
// binary. See docs/superpowers/specs/2026-07-11-mp4thumb-re-design.md and RE-PARAMS.md.
//
// Pipeline (per RE):
//   FindVideoStream  : avformat_find_stream_info + av_find_best_stream(VIDEO)
//   SetupDecoderCtx  : alloc_context3 + parameters_to_context + open2
//   DecodeFirstFrame : read packets of that stream, send/receive, return the FIRST
//                      decoded frame (no seek, no keyframe/thumbnail filter)
//   scale dims       : if (w<=maxW && h<=maxH) keep; else scale=min(maxW/w,maxH/h),
//                      newW=(int)(scale*w)&~1, newH=(int)(scale*h)&~1 (fit-inside, downscale-only)
//   ScaleAndConvert  : sws_getContext(..., YUV420P, SWS_BICUBIC, 0,0,0) + sws_scale
//   EncodeToJPEG     : MJPEG encoder, pix_fmt=YUV420P, color_range=JPEG, time_base=1/1,
//                      av_opt_set_int(priv,"q",3), send_frame/receive_packet
//   WriteJPEGFile    : mux the packet via the "mjpeg" muxer (update=1,frames=1) to outputPath
//
// Full API: class MP4Thumb { generateThumbnail (sync), generateThumbnailAsync (Promise),
// setOutputPath, cancel }. Default max dimensions 640x640 (ctor); optional ctor(w,h).

#include <napi.h>
#include <atomic>
#include <string>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixfmt.h>
#include <libswscale/swscale.h>
}

namespace {

// Decode the first frame the video stream yields (no seek — matches DecodeFirstFrame).
AVFrame* DecodeFirstFrame(AVFormatContext* fmt, AVCodecContext* dec, int streamIdx,
                          std::atomic<bool>& cancelled, std::string& err) {
  AVPacket* pkt = av_packet_alloc();
  AVFrame* frame = av_frame_alloc();
  if (!pkt || !frame) {
    err = "Could not allocate packet/frame";
    av_packet_free(&pkt);
    av_frame_free(&frame);
    return nullptr;
  }
  while (!cancelled.load()) {
    if (av_read_frame(fmt, pkt) < 0) break;
    if (pkt->stream_index != streamIdx) { av_packet_unref(pkt); continue; }
    avcodec_send_packet(dec, pkt);
    if (cancelled.load()) { av_packet_unref(pkt); break; }
    if (avcodec_receive_frame(dec, frame) == 0) {
      av_packet_free(&pkt);
      return frame;  // caller owns `frame`
    }
    av_packet_unref(pkt);
  }
  av_packet_free(&pkt);
  av_frame_free(&frame);
  return nullptr;
}

// sws_scale into a fresh YUV420P frame of (dstW x dstH) using SWS_BICUBIC.
AVFrame* ScaleAndConvertFrame(AVFrame* src, AVPixelFormat srcFmt, int dstW, int dstH,
                              AVPixelFormat dstFmt, std::string& err) {
  SwsContext* sws = sws_getContext(src->width, src->height, srcFmt,
                                   dstW, dstH, dstFmt,
                                   SWS_BICUBIC, nullptr, nullptr, nullptr);
  if (!sws) { err = "Failed to create scale context"; return nullptr; }

  AVFrame* dst = av_frame_alloc();
  if (!dst) { sws_freeContext(sws); err = "Could not allocate frame"; return nullptr; }
  dst->format = dstFmt;
  dst->width = dstW;
  dst->height = dstH;
  if (av_frame_get_buffer(dst, 0) < 0) {
    sws_freeContext(sws);
    av_frame_free(&dst);
    err = "Could not allocate frame buffer";
    return nullptr;
  }
  sws_scale(sws, src->data, src->linesize, 0, src->height, dst->data, dst->linesize);
  sws_freeContext(sws);
  return dst;
}

// Encode one frame with the MJPEG encoder. color_range=JPEG makes YUV420P full-range.
AVPacket* EncodeToJPEG(AVFrame* frame, int w, int h, AVPixelFormat fmt, std::string& err) {
  const AVCodec* enc = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
  if (!enc) { err = "MJPEG encoder not found"; return nullptr; }
  AVCodecContext* ctx = avcodec_alloc_context3(enc);
  if (!ctx) { err = "Failed to allocate MJPEG context"; return nullptr; }
  ctx->width = w;
  ctx->height = h;
  ctx->pix_fmt = fmt;
  ctx->time_base = AVRational{1, 1};
  ctx->color_range = AVCOL_RANGE_JPEG;
  av_opt_set_int(ctx->priv_data, "q", 3, 0);
  if (avcodec_open2(ctx, enc, nullptr) < 0) {
    avcodec_free_context(&ctx);
    err = "Failed to open MJPEG encoder";
    return nullptr;
  }
  AVPacket* pkt = av_packet_alloc();
  frame->pts = 0;
  AVPacket* result = nullptr;
  if (avcodec_send_frame(ctx, frame) >= 0 && avcodec_receive_packet(ctx, pkt) >= 0) {
    result = pkt;   // caller owns `pkt`
  } else {
    av_packet_free(&pkt);
  }
  avcodec_free_context(&ctx);
  return result;
}

// Write the encoded packet to `outPath` via the "mjpeg" muxer.
bool WriteJPEGFile(const std::string& outPath, AVPacket* pkt, int w, int h,
                   AVPixelFormat fmt, std::string& err) {
  AVFormatContext* oc = nullptr;
  if (avformat_alloc_output_context2(&oc, nullptr, "mjpeg", outPath.c_str()) < 0 || !oc) {
    err = "Failed to create output context";
    return false;
  }
  AVStream* st = avformat_new_stream(oc, nullptr);
  if (!st) { err = "Failed to create output stream"; avformat_free_context(oc); return false; }

  const AVCodec* enc = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
  AVCodecContext* ctx = avcodec_alloc_context3(enc);
  if (!ctx) { err = "Failed to allocate MJPEG context"; avformat_free_context(oc); return false; }
  ctx->width = w;
  ctx->height = h;
  ctx->pix_fmt = fmt;
  ctx->time_base = AVRational{1, 1};
  ctx->color_range = AVCOL_RANGE_JPEG;
  av_opt_set_int(ctx->priv_data, "q", 3, 0);
  if (avcodec_open2(ctx, enc, nullptr) < 0) {
    avcodec_free_context(&ctx);
    avformat_free_context(oc);
    err = "Failed to open MJPEG encoder";
    return false;
  }
  avcodec_parameters_from_context(st->codecpar, ctx);
  avcodec_free_context(&ctx);

  if (avio_open(&oc->pb, outPath.c_str(), AVIO_FLAG_WRITE) < 0) {
    avformat_free_context(oc);
    err = "Failed to open output file";
    return false;
  }

  AVDictionary* opts = nullptr;
  av_dict_set(&opts, "update", "1", 0);
  av_dict_set(&opts, "frames", "1", 0);
  bool ok = false;
  if (avformat_write_header(oc, &opts) >= 0) {
    pkt->stream_index = st->index;
    pkt->pts = 0;
    pkt->dts = 0;
    pkt->duration = 0;
    av_packet_rescale_ts(pkt, AVRational{1, 1}, st->time_base);
    ok = av_interleaved_write_frame(oc, pkt) >= 0;
    av_write_trailer(oc);
  } else {
    err = "Failed to write header";
  }
  av_dict_free(&opts);
  if (oc->pb) avio_closep(&oc->pb);
  avformat_free_context(oc);
  if (!ok && err.empty()) err = "Failed to write frame";
  return ok;
}

// Full pipeline on an already-open input context.
bool ProcessVideo(AVFormatContext* fmt, const std::string& outPath,
                  uint32_t maxW, uint32_t maxH, std::atomic<bool>& cancelled,
                  std::string& err) {
  if (avformat_find_stream_info(fmt, nullptr) < 0) { err = "Could not find stream info"; return false; }
  const AVCodec* codec = nullptr;
  int streamIdx = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &codec, 0);
  if (streamIdx < 0 || !codec) { err = "No video stream found"; return false; }

  AVCodecContext* dec = avcodec_alloc_context3(codec);
  if (!dec) { err = "Failed to allocate decoder context"; return false; }
  if (avcodec_parameters_to_context(dec, fmt->streams[streamIdx]->codecpar) < 0 ||
      avcodec_open2(dec, codec, nullptr) < 0) {
    avcodec_free_context(&dec);
    err = "Failed to open decoder";
    return false;
  }
  if (cancelled.load()) { avcodec_free_context(&dec); return false; }

  AVFrame* frame = DecodeFirstFrame(fmt, dec, streamIdx, cancelled, err);
  avcodec_free_context(&dec);
  if (!frame) { if (err.empty()) err = "Failed to decode frame"; return false; }

  int srcW = frame->width, srcH = frame->height;
  int newW = srcW, newH = srcH;
  if (!(srcW <= (int)maxW && srcH <= (int)maxH)) {
    double sw = (double)maxW / srcW;
    double sh = (double)maxH / srcH;
    double scale = sw < sh ? sw : sh;
    newW = (int)(scale * srcW);
    newH = (int)(scale * srcH);
  }
  newW &= ~1;
  newH &= ~1;

  AVPixelFormat srcFmt = (AVPixelFormat)frame->format;
  AVFrame* scaled = ScaleAndConvertFrame(frame, srcFmt, newW, newH, AV_PIX_FMT_YUV420P, err);
  av_frame_free(&frame);
  if (!scaled) return false;

  AVPacket* pkt = EncodeToJPEG(scaled, newW, newH, AV_PIX_FMT_YUV420P, err);
  av_frame_free(&scaled);
  if (!pkt) return false;

  bool ok = WriteJPEGFile(outPath, pkt, newW, newH, AV_PIX_FMT_YUV420P, err);
  av_packet_free(&pkt);
  return ok;
}

// Open the input file and run the pipeline.
bool GenerateCore(const std::string& inPath, const std::string& outPath,
                  uint32_t maxW, uint32_t maxH, std::atomic<bool>& cancelled,
                  std::string& err, std::string& openErr) {
  AVFormatContext* fmt = nullptr;
  int rc = avformat_open_input(&fmt, inPath.c_str(), nullptr, nullptr);
  if (rc < 0) {
    char buf[64] = {0};
    av_strerror(rc, buf, sizeof(buf));
    openErr = std::string("Could not open input file: ") + buf;
    return false;
  }
  bool ok = ProcessVideo(fmt, outPath, maxW, maxH, cancelled, err);
  avformat_close_input(&fmt);
  return ok;
}

}  // namespace

class MP4Thumb : public Napi::ObjectWrap<MP4Thumb> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit MP4Thumb(const Napi::CallbackInfo& info);

 private:
  Napi::Value GenerateThumbnail(const Napi::CallbackInfo& info);
  Napi::Value GenerateThumbnailAsync(const Napi::CallbackInfo& info);
  void SetOutputPath(const Napi::CallbackInfo& info);
  void Cancel(const Napi::CallbackInfo& info);

  // Read (maxWidth,maxHeight) from args[wIdx],args[hIdx], defaulting to members.
  void GetDimensions(const Napi::CallbackInfo& info, size_t wIdx, size_t hIdx,
                     uint32_t& outW, uint32_t& outH) const;

  uint32_t maxW_ = 640;   // ctor default (mac: 0x280)
  uint32_t maxH_ = 640;
  std::string outputPath_;
  std::atomic<bool> cancelled_{false};

  friend class ThumbWorker;
};

class ThumbWorker : public Napi::AsyncWorker {
 public:
  ThumbWorker(Napi::Env env, MP4Thumb* self, std::string in, std::string out,
              uint32_t maxW, uint32_t maxH)
      : Napi::AsyncWorker(env),
        deferred_(Napi::Promise::Deferred::New(env)),
        self_(self), in_(std::move(in)), out_(std::move(out)), maxW_(maxW), maxH_(maxH) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    std::string err, openErr;
    ok_ = GenerateCore(in_, out_, maxW_, maxH_, self_->cancelled_, err, openErr);
    if (!ok_) {
      std::string msg = !openErr.empty() ? openErr
                        : !err.empty()   ? err
                                         : "Failed to generate thumbnail";
      SetError(msg);
    }
  }
  void OnOK() override { deferred_.Resolve(Napi::Boolean::New(Env(), ok_)); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  MP4Thumb* self_;
  std::string in_, out_;
  uint32_t maxW_, maxH_;
  bool ok_ = false;
};

Napi::Object MP4Thumb::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "MP4Thumb", {
      InstanceMethod("generateThumbnail", &MP4Thumb::GenerateThumbnail),
      InstanceMethod("generateThumbnailAsync", &MP4Thumb::GenerateThumbnailAsync),
      InstanceMethod("setOutputPath", &MP4Thumb::SetOutputPath),
      InstanceMethod("cancel", &MP4Thumb::Cancel),
  });
  exports.Set("MP4Thumb", func);
  return exports;
}

MP4Thumb::MP4Thumb(const Napi::CallbackInfo& info) : Napi::ObjectWrap<MP4Thumb>(info) {
  // Optional ctor(maxWidth, maxHeight); JS uses `new MP4Thumb()` -> 640x640.
  if (info.Length() > 0 && info[0].IsNumber()) maxW_ = info[0].As<Napi::Number>().Uint32Value();
  if (info.Length() > 1 && info[1].IsNumber()) maxH_ = info[1].As<Napi::Number>().Uint32Value();
}

void MP4Thumb::GetDimensions(const Napi::CallbackInfo& info, size_t wIdx, size_t hIdx,
                             uint32_t& outW, uint32_t& outH) const {
  outW = maxW_;
  outH = maxH_;
  if (info.Length() > wIdx && info[wIdx].IsNumber()) outW = info[wIdx].As<Napi::Number>().Uint32Value();
  if (info.Length() > hIdx && info[hIdx].IsNumber()) outH = info[hIdx].As<Napi::Number>().Uint32Value();
}

Napi::Value MP4Thumb::GenerateThumbnail(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    throw Napi::TypeError::New(env,
        "Usage: generateThumbnail(inputPath, outputPath [, maxWidth, maxHeight])");
  }
  cancelled_.store(false);
  std::string in = info[0].As<Napi::String>().Utf8Value();
  std::string out = info[1].As<Napi::String>().Utf8Value();
  uint32_t maxW, maxH;
  GetDimensions(info, 2, 3, maxW, maxH);

  std::string err, openErr;
  bool ok = GenerateCore(in, out, maxW, maxH, cancelled_, err, openErr);
  if (!openErr.empty()) throw Napi::Error::New(env, openErr);
  if (!ok) return env.Null();
  return Napi::Boolean::New(env, true);
}

Napi::Value MP4Thumb::GenerateThumbnailAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    throw Napi::TypeError::New(env,
        "Usage: generateThumbnailAsync(inputPath, outputPath [, maxWidth, maxHeight])");
  }
  cancelled_.store(false);
  std::string in = info[0].As<Napi::String>().Utf8Value();
  std::string out = info[1].As<Napi::String>().Utf8Value();
  uint32_t maxW, maxH;
  GetDimensions(info, 2, 3, maxW, maxH);

  auto* worker = new ThumbWorker(env, this, std::move(in), std::move(out), maxW, maxH);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

void MP4Thumb::SetOutputPath(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    throw Napi::Error::New(env, "Expected output path string");
  }
  outputPath_ = info[0].As<Napi::String>().Utf8Value();
}

void MP4Thumb::Cancel(const Napi::CallbackInfo& info) {
  cancelled_.store(true);
}

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return MP4Thumb::Init(env, exports);
}

NODE_API_MODULE(mp4thumb, InitAll)
