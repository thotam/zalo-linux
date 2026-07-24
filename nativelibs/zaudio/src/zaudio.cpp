#include <napi.h>
#include <opus.h>
#include "miniaudio.h"
#include <cstring>
#include <vector>
#include <deque>
#include <mutex>

// Full-duplex audio: opus 16 kHz mono 20 ms + miniaudio device (dlopen ALSA/Pulse/PipeWire).
// encodeFrame/decodeFrame are the offline-testable codec path; start/play/stop drive the device.
class ZAudio : public Napi::ObjectWrap<ZAudio> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  ZAudio(const Napi::CallbackInfo& info);
  ~ZAudio();

 private:
  OpusEncoder* enc_ = nullptr;
  OpusDecoder* dec_ = nullptr;
  int sampleRate_ = 16000, channels_ = 1, frameSamples_ = 320;
  double micGain_ = 1.0;   // software gain applied to captured PCM before opus_encode
  ma_device device_;
  bool running_ = false;
  Napi::ThreadSafeFunction tsfn_;
  std::vector<opus_int16> capAccum_;              // accumulate mic PCM to 20 ms frames
  std::deque<opus_int16> playBuf_;                // speaker jitter buffer
  std::mutex playMtx_;

  Napi::Value EncodeFrame(const Napi::CallbackInfo& info);
  Napi::Value DecodeFrame(const Napi::CallbackInfo& info);
  void Start(const Napi::CallbackInfo& info);
  void Play(const Napi::CallbackInfo& info);
  void Stop(const Napi::CallbackInfo& info);
  static void DataCB(ma_device* dev, void* out, const void* in, ma_uint32 frames);
};

Napi::Object ZAudio::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function f = DefineClass(env, "ZAudio", {
    InstanceMethod("encodeFrame", &ZAudio::EncodeFrame),
    InstanceMethod("decodeFrame", &ZAudio::DecodeFrame),
    InstanceMethod("start", &ZAudio::Start),
    InstanceMethod("play", &ZAudio::Play),
    InstanceMethod("stop", &ZAudio::Stop),
  });
  exports.Set("ZAudio", f);
  return exports;
}

ZAudio::ZAudio(const Napi::CallbackInfo& info) : Napi::ObjectWrap<ZAudio>(info) {
  Napi::Env env = info.Env();
  int bitrate = 24000;
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object o = info[0].As<Napi::Object>();
    if (o.Has("sampleRate")) sampleRate_ = o.Get("sampleRate").As<Napi::Number>().Int32Value();
    if (o.Has("channels")) channels_ = o.Get("channels").As<Napi::Number>().Int32Value();
    if (o.Has("frameMs")) frameSamples_ = sampleRate_ * o.Get("frameMs").As<Napi::Number>().Int32Value() / 1000;
    if (o.Has("bitrate")) bitrate = o.Get("bitrate").As<Napi::Number>().Int32Value();
    if (o.Has("micGain")) micGain_ = o.Get("micGain").As<Napi::Number>().DoubleValue();
  }
  int err = 0;
  enc_ = opus_encoder_create(sampleRate_, channels_, OPUS_APPLICATION_VOIP, &err);
  if (err != OPUS_OK) { Napi::Error::New(env, "opus_encoder_create failed").ThrowAsJavaScriptException(); return; }
  opus_encoder_ctl(enc_, OPUS_SET_BITRATE(bitrate));
  dec_ = opus_decoder_create(sampleRate_, channels_, &err);
  if (err != OPUS_OK) { Napi::Error::New(env, "opus_decoder_create failed").ThrowAsJavaScriptException(); return; }
}

ZAudio::~ZAudio() {
  if (running_) { ma_device_uninit(&device_); running_ = false; }
  if (enc_) opus_encoder_destroy(enc_);
  if (dec_) opus_decoder_destroy(dec_);
}

Napi::Value ZAudio::EncodeFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) { Napi::TypeError::New(env, "encodeFrame(pcm: Buffer)").ThrowAsJavaScriptException(); return env.Null(); }
  Napi::Buffer<uint8_t> pcm = info[0].As<Napi::Buffer<uint8_t>>();
  const opus_int16* samples = reinterpret_cast<const opus_int16*>(pcm.Data());
  std::vector<uint8_t> out(4000);
  int n = opus_encode(enc_, samples, frameSamples_, out.data(), (opus_int32)out.size());
  if (n < 0) { Napi::Error::New(env, std::string("opus_encode: ") + opus_strerror(n)).ThrowAsJavaScriptException(); return env.Null(); }
  return Napi::Buffer<uint8_t>::Copy(env, out.data(), n);
}

Napi::Value ZAudio::DecodeFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) { Napi::TypeError::New(env, "decodeFrame(opus: Buffer)").ThrowAsJavaScriptException(); return env.Null(); }
  Napi::Buffer<uint8_t> op = info[0].As<Napi::Buffer<uint8_t>>();
  std::vector<opus_int16> pcm(frameSamples_ * channels_);
  int n = opus_decode(dec_, op.Data(), (opus_int32)op.Length(), pcm.data(), frameSamples_, 0);
  if (n < 0) { Napi::Error::New(env, std::string("opus_decode: ") + opus_strerror(n)).ThrowAsJavaScriptException(); return env.Null(); }
  return Napi::Buffer<uint8_t>::Copy(env, reinterpret_cast<uint8_t*>(pcm.data()), n * channels_ * 2);
}

void ZAudio::DataCB(ma_device* dev, void* out, const void* in, ma_uint32 frames) {
  ZAudio* self = static_cast<ZAudio*>(dev->pUserData);
  if (in) {
    const opus_int16* mic = static_cast<const opus_int16*>(in);
    const ma_uint32 total = frames * self->channels_;
    if (self->micGain_ == 1.0) {
      self->capAccum_.insert(self->capAccum_.end(), mic, mic + total);
    } else {
      for (ma_uint32 i = 0; i < total; i++) {
        int v = (int)(mic[i] * self->micGain_);
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        self->capAccum_.push_back((opus_int16)v);
      }
    }
    const int fs = self->frameSamples_ * self->channels_;
    while ((int)self->capAccum_.size() >= fs) {
      unsigned char enc[4000];
      int n = opus_encode(self->enc_, self->capAccum_.data(), self->frameSamples_, enc, sizeof(enc));
      self->capAccum_.erase(self->capAccum_.begin(), self->capAccum_.begin() + fs);
      if (n > 0 && self->tsfn_) {
        auto* payload = new std::vector<uint8_t>(enc, enc + n);
        self->tsfn_.NonBlockingCall(payload, [](Napi::Env env, Napi::Function cb, std::vector<uint8_t>* d) {
          cb.Call({ Napi::Buffer<uint8_t>::Copy(env, d->data(), d->size()) });
          delete d;
        });
      }
    }
  }
  if (out) {
    opus_int16* spk = static_cast<opus_int16*>(out);
    std::lock_guard<std::mutex> lk(self->playMtx_);
    ma_uint32 want = frames * self->channels_;
    for (ma_uint32 i = 0; i < want; i++) {
      if (!self->playBuf_.empty()) { spk[i] = self->playBuf_.front(); self->playBuf_.pop_front(); }
      else spk[i] = 0;
    }
  }
}

void ZAudio::Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (running_) return;
  if (info.Length() < 1 || !info[0].IsFunction()) { Napi::TypeError::New(env, "start(onFrame)").ThrowAsJavaScriptException(); return; }
  tsfn_ = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "zaudio-onframe", 0, 1);
  ma_device_config cfg = ma_device_config_init(ma_device_type_duplex);
  cfg.sampleRate = sampleRate_;
  cfg.capture.format = ma_format_s16;  cfg.capture.channels = channels_;
  cfg.playback.format = ma_format_s16; cfg.playback.channels = channels_;
  cfg.periodSizeInFrames = frameSamples_;
  cfg.dataCallback = &ZAudio::DataCB;
  cfg.pUserData = this;
  if (ma_device_init(NULL, &cfg, &device_) != MA_SUCCESS) { tsfn_.Release(); tsfn_ = Napi::ThreadSafeFunction(); Napi::Error::New(env, "ma_device_init failed").ThrowAsJavaScriptException(); return; }
  if (ma_device_start(&device_) != MA_SUCCESS) { ma_device_uninit(&device_); tsfn_.Release(); tsfn_ = Napi::ThreadSafeFunction(); Napi::Error::New(env, "ma_device_start failed").ThrowAsJavaScriptException(); return; }
  running_ = true;
}

void ZAudio::Play(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) { Napi::TypeError::New(env, "play(opus: Buffer)").ThrowAsJavaScriptException(); return; }
  Napi::Buffer<uint8_t> op = info[0].As<Napi::Buffer<uint8_t>>();
  std::vector<opus_int16> pcm(frameSamples_ * channels_);
  int n = opus_decode(dec_, op.Data(), (opus_int32)op.Length(), pcm.data(), frameSamples_, 0);
  if (n < 0) return;
  std::lock_guard<std::mutex> lk(playMtx_);
  if ((int)playBuf_.size() > sampleRate_ * channels_ * 4 / 10) playBuf_.clear();  // cap ~400ms
  playBuf_.insert(playBuf_.end(), pcm.begin(), pcm.begin() + n * channels_);
}

void ZAudio::Stop(const Napi::CallbackInfo& info) {
  if (running_) { ma_device_uninit(&device_); running_ = false; }
  if (tsfn_) { tsfn_.Release(); tsfn_ = Napi::ThreadSafeFunction(); }
}

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) { return ZAudio::Init(env, exports); }
NODE_API_MODULE(zaudio, InitAll)
