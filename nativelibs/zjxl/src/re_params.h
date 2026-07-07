#pragma once
// Constants reverse-engineered from app/native/nativelibs/zjxl/build/darwin_x64/jxl.node
// (x86_64 Mach-O). Derivation for each value is documented in RE-PARAMS.md with the
// binary address + disassembly it came from. These are the single source of truth for
// bit-identical output; do not change without re-deriving from the binary.
//
// Confidence per value is noted inline (certain / assumed). All `assumed` values are
// flagged in RE-PARAMS.md for functional confirmation in Task 6.
namespace zjxl_re {

// --- bitmapToJxl encode path (helper: encodeJxlOneshot @0x91e4) ---
// JxlEncoderSetFrameDistance(fs, 2.28f) @0x93c1; float immediate 0x4011eb85 @0x16a2c.
constexpr float kEncodeDistance      = 2.28f;   // certain
// JxlEncoderSetFrameLossless(fs, JXL_FALSE) @0x93b1 (esi=0).
constexpr bool  kEncodeLossless      = false;   // certain
// JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_EFFORT=0, 1) @0x93ce.
constexpr int   kEncodeEffort        = 1;       // certain
// JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_DECODING_SPEED=1, 4) @0x93dc.
constexpr int   kEncodeDecodingSpeed = 4;       // certain
// JxlEncoderInitBasicInfo default (not overridden); confirmed by 22/22 sample headers
// (ImageMetadata all_default=1) and by the JXL_TYPE_UINT8 input pixel format.
constexpr int   kEncodeBitsPerSample = 8;       // certain
// InitBasicInfo defaults: 3 color channels, num_extra_channels=0, alpha_bits=0.
// Input JxlPixelFormat.num_channels=3 @0x16a38. No alpha.
constexpr bool  kEncodeAlpha         = false;   // certain
constexpr int   kEncodeNumChannels   = 3;       // certain (RGB)
// Input JxlPixelFormat used for JxlEncoderAddImageFrame, block @0x16a38.
constexpr int   kEncodePixelDataType = 2;       // JXL_TYPE_UINT8   certain
constexpr int   kEncodeEndianness    = 0;       // JXL_NATIVE_ENDIAN certain
constexpr int   kEncodePixelAlign    = 0;       // certain

// --- jxlToJpeg decode->jpeg path (turbojpeg helper: encodeJpegOneShotTurbo @0x81fa) ---
// Quality is caller-supplied: jxlToJpeg reads JS "quality" as a 0..1 float and scales it
// by 100.0 (mulss @0x51a0, const @0x168e0) then passes it to tj3Set(TJPARAM_QUALITY=3).
constexpr float kJpegQualityScale    = 100.0f;  // certain
// No hardcoded default exists in the binary or JS wrapper; caller always passes quality.
constexpr int   kDefaultJpegQuality  = 90;      // assumed (verify functionally in Task 6)
// tj3Set(h, TJPARAM_SUBSAMP=4, 2) @0x8260.
constexpr int   kJpegSubsamp         = 2;       // TJSAMP_420   certain
// tj3Set(h, TJPARAM_PROGRESSIVE=10, 1) @0x826e.
constexpr int   kJpegProgressive     = 1;       // certain
// tj3Compress8(..., pixelFormat=0, ...) @0x82a3 (r9d=0).
constexpr int   kJpegPixelFormat     = 0;       // TJPF_RGB     certain

// --- decode (decodeJpegXlOneShot @0x8417) / batch decode contract ---
// Output JxlPixelFormat block @0x16a38 (same as encode): 3-channel UINT8.
constexpr int   kDecodeNumChannels   = 3;       // certain
constexpr int   kDecodePixelDataType = 2;       // JXL_TYPE_UINT8   certain

// --- resizeJxl / resizePPFWithOpenCV (@0x8c8d and @0xb578) ---
// Two-stage OpenCV downscale (both overloads identical):
//   Stage 1 (optional pre-scale): if a source dimension > 1000 and a target dimension
//   < 1000, cv::resize to a 1000px cap with INTER_LINEAR (rcx=1) @0x8d9f / @0xb68a.
//   Stage 2 (final downscale to requested size): cv::resize with INTER_AREA (rcx=3)
//   @0x8e50 / @0xb73b.
constexpr int   kResizeInterp         = 3;      // cv::INTER_AREA (final downscale)  certain
constexpr int   kResizePreScaleInterp = 1;      // cv::INTER_LINEAR (pre-scale pass) certain
constexpr int   kResizePreScaleCap    = 1000;   // 0x3e8 px cap                      certain
// resizeJxl re-encodes via the same encodeJxlOneshot (call @0xa0ce), so the re-encode
// parameters are identical to the encode path above.
constexpr float kResizeReencodeDist   = 2.28f;  // certain
constexpr int   kResizeReencodeEffort = 1;      // certain

}  // namespace zjxl_re
