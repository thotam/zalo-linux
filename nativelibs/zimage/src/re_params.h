#pragma once
// Constants reverse-engineered from the macOS zimage native addon:
//   app/native/nativelibs/zimage/darwin_x64/zimage.node   (x86_64 Mach-O)
//   app/native/nativelibs/zimage/darwin_x64/libvips-cpp.42.dylib (libvips 8.14.2)
// Zalo bundle 26.6.20.
//
// Each value's derivation (binary address + r2 disassembly + confidence) is in
// nativelibs/zimage/RE-PARAMS.md. This header is the single source of truth the
// Linux addon compiles against for bit-identical thumbnail output.
//
// KEY FINDING: the mac addon calls the libvips *C API* directly
// (vips_thumbnail_buffer / vips_thumbnail / vips_jpegsave_buffer /
// vips_pngsave_buffer), NOT the C++ VImage wrappers. It sets only TWO thumbnail
// options ("height" and "size") and, on save, only jpeg "strip". Every other
// option is left UNSET, i.e. it takes the libvips 8.14.2 built-in default.
// "certain (explicit)" below = an immediate recovered from disassembly.
// "certain (unset->default)" = the option is provably NOT passed, so the value
// is the libvips default and MUST be reproduced by keeping it unset (or by
// explicitly setting the same default) on Linux.

namespace zimage_re {

// ----- libvips enum mirrors (from vips headers; values are ABI-stable) -----
enum VipsSize        { kSizeBoth = 0, kSizeUp = 1, kSizeDown = 2, kSizeForce = 3 };
enum VipsInteresting { kInterestNone = 0, kInterestCentre = 2, kInterestEntropy = 3, kInterestAttention = 4 };
enum VipsIntent      { kIntentPerceptual = 0, kIntentRelative = 1, kIntentSaturation = 2, kIntentAbsolute = 3 };
enum VipsSubsample   { kSubsampleAuto = 0, kSubsampleOn = 1, kSubsampleOff = 2 };

// ===== VImage/vips_thumbnail(_buffer) option set =====
// Call form recovered (buffer variant, ThumbnailAsyncWorker::Execute @0x1468):
//   vips_thumbnail_buffer(buf, len, &out, width, "height", height, "size", 3, NULL)
// File variant (ThumbnailFsAsyncWorker::Execute @0x38f8) is identical:
//   vips_thumbnail(filename, &out, width, "height", height, "size", 3, NULL)
// width  = positional arg (JS width),  height = "height" option (JS height).

constexpr int  kThumbSize       = kSizeForce;   // =3. EXPLICIT immediate @0x14b0 (buffer) / @0x391d (fs). certain.
constexpr int  kThumbCrop       = kInterestNone;// =0. "crop" NOT set -> libvips default. certain(unset->default).
constexpr bool kThumbAutoRotate = true;         // "no_rotate" NOT set -> default no_rotate=FALSE -> auto-rotate ON. certain(unset->default).
constexpr bool kThumbLinear     = false;        // "linear" NOT set -> default FALSE. certain(unset->default).
constexpr int  kThumbIntent     = kIntentRelative; // =1. "intent" NOT set -> default VIPS_INTENT_RELATIVE. certain(unset->default).

// ===== Output-format dispatch (ThumbnailAsyncWorker::Execute) =====
// if (format == "jpeg")  -> IF vips_image_hasalpha(img): flatten onto WHITE
//                           [255,255,255] first; THEN jpegsave (see below).
// else (i.e. "png")      -> pngsave (no options)
// Only "jpeg" and "png" are ever produced. WebP is NEVER emitted by this addon.
// The JS `quality` argument is NOT forwarded to native (ctor takes only
// buffer,int width,int height,std::string format,callback), so Q is never set.
//
// CORRECTION (re-verified directly against
// app/native/nativelibs/zimage/darwin_x64/zimage.node with r2 during Task 4,
// 2026-07-09): the original Task 2 pass at RE-PARAMS.md read the flatten call
// as unconditional and the background as a single scalar. Both are wrong.
// Full disassembly of ThumbnailAsyncWorker::Execute @0x1468 shows:
//   0x1501  call operator==(format, "jpeg")
//   0x150c  test al,al; je 0x15a5          -> else branch: pngsave, no flatten
//   0x1512  call vips_image_hasalpha(img)  -> ONLY reached when format=="jpeg"
//   0x1519  test eax,eax; je 0x15be        -> no alpha: skip flatten, jpegsave as-is
//   0x151f..0x1543  build background = vips_array_double_new({255.0,255.0,255.0}, 3)
//   0x155d  call vips_flatten(img, &out, "background", bg3, NULL)
//   0x15dd  call vips_jpegsave_buffer(img_or_flat, &buf, &len, "strip", 1, NULL)
// i.e. flatten is GATED on vips_image_hasalpha(), and the background is a
// 3-element array [255,255,255] (verified via `pf ddd` at the movaps source
// address section.5.__TEXT.__const: both preloaded doubles are 0x406fe0...
// = 255.0, matching the explicit third movabs 255.0). Reproducing this
// unconditionally (as the original doc said) corrupts every alpha-less JPEG:
// vips_flatten always drops the LAST band regardless of whether it is really
// alpha, verified with `vips flatten` CLI on a real 3-band sRGB sample
// (3 bands in -> 2 bands out, i.e. it silently discards the blue channel).

// ----- JPEG save: vips_jpegsave_buffer(img, &buf, &len, "strip", 1, NULL) @0x15fb -----
constexpr int  kJpegQ           = 75;    // "Q" NOT set -> mozjpeg/libvips default 75. certain(unset->default).
constexpr bool kJpegOptimize    = false; // "optimize_coding" NOT set -> default FALSE. certain(unset->default).
constexpr int  kJpegSubsample   = kSubsampleAuto; // =0. "subsample_mode" NOT set -> default AUTO. certain(unset->default).
constexpr bool kJpegStrip       = true;  // "strip" EXPLICITLY set to 1 @0x15eb..0x15f2. certain(explicit).
// JPEG alpha handling: IF vips_image_hasalpha(img) (@0x1512, checked ONLY on
// the jpeg path), pre-flatten over white RGB(255,255,255) via vips_flatten
// "background"=[255,255,255] (3-element VipsArrayDouble, "push 3; pop rsi"
// @0x153b before vips_array_double_new) @0x151f..0x155d. certain(explicit).
// Each background component: double 255.0 = 0x406fe000... (verified via r2
// `pf ddd` on section.5.__TEXT.__const, the movaps source for the first two
// components, plus the explicit third movabs). Flatten is SKIPPED entirely
// (image passed to jpegsave unchanged) when hasalpha() is false.
constexpr double kJpegFlattenBg = 255.0;  // single-channel value; array = {kJpegFlattenBg}x3
constexpr bool kJpegFlattenOnlyIfAlpha = true; // gate @0x1512-0x1519. certain(explicit).

// ----- PNG save: vips_pngsave_buffer(img, &buf, &len, NULL) @0x15b7 (NO options) -----
constexpr int  kPngCompression  = 6;     // "compression" NOT set -> default 6. certain(unset->default).
constexpr bool kPngStrip        = false; // "strip" NOT set -> default FALSE (PNG keeps metadata). certain(unset->default).
constexpr bool kPngPalette      = false; // "palette" NOT set -> default FALSE. certain(unset->default).

// ----- WebP: NOT USED by this addon. Values below are libvips defaults only,
//       provided for API completeness. Do NOT rely on them for parity; the mac
//       addon never calls webpsave. confidence: assumed/unused.
constexpr int  kWebpQ           = 75;    // libvips webpsave default. assumed/unused.
constexpr int  kWebpEffort      = 4;     // libvips webpsave default. assumed/unused.
constexpr bool kWebpLossless    = false; // libvips webpsave default. assumed/unused.

// ----- ThumbnailFs (write-to-file) save options -----
// vips_image_write_to_file(out, dest) @0x397a: format & options are chosen by
// libvips from the destination file extension with ALL defaults (no VOptions
// passed). No per-format overrides. certain(unset->default).

// ===== Codec versions the mac libvips was built against (from dylib strings) =====
// libvips        8.14.2      (certain: "print libvips version" string)
// JPEG codec     mozjpeg 4.1.1 (build 20230321)  (certain) -- NOT plain libjpeg-turbo
// libpng         1.6.39      (certain)   + libspng PNG load/save enabled
// libwebp        present (build reports "libwebp: true"); exact ver indeterminate
// libjxl         DISABLED    ("JXL load/save with libjxl: false") -- no JXL in this addon
// libtiff        present     ("libtiff: true")

}  // namespace zimage_re
