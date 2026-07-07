# RE-PARAMS — image-codec parameters recovered from the mac `jxl.node`

Source binary: `app/native/nativelibs/zjxl/build/darwin_x64/jxl.node` (x86_64 Mach-O,
C++ symbols intact). Tool: `r2 -q -c 'e scr.color=0; aa; af @ <addr>; s <addr>; pdf'`.
All addresses below are file/vaddr offsets as reported by radare2.

Every constant in `src/re_params.h` is traced here to a binary address + disassembly
snippet, with a per-value confidence note.

---

## Encode path — `bitmapToJxl` → `encodeJxlOneshot`

`bitmapToJxl(Napi::CallbackInfo const&)` @0x594c only unpacks JS args
(`buffer/width/height`, `maxThreads` default **8** @0x5a19, `apiVersion` default **1**
@0x5a55) and dispatches an AsyncWorker. All encoder immediates live in the shared helper
`encodeJxlOneshot(const uchar*, ulong, uint, uint, vector<uchar>*, uint)` @0x91e4, which
is also the re-encode helper for `resizeJxl` (call @0xa0ce) and `jxlCompress` (call
@0x992f).

### kEncodeLossless = false — certain
```
0x000093a4  call JxlEncoderFrameSettingsCreate
0x000093af  xor esi, esi                 ; JXL_FALSE
0x000093b1  call JxlEncoderSetFrameLossless   ; SetFrameLossless(fs, 0)
```

### kEncodeDistance = 2.28f — certain
```
0x000093b6  movss xmm0, dword [0x00016a2c]   ; [0x16a2c] = 0x4011eb85
0x000093be  mov rdi, rbx
0x000093c1  call JxlEncoderSetFrameDistance   ; SetFrameDistance(fs, 2.28f)
```
`0x4011eb85` decoded as IEEE-754 float = **2.2799999713897705** → 2.28f.

### kEncodeEffort = 1 — certain
`JxlEncoderFrameSettingsSetOption(fs, option, value)` = (rdi, esi, rdx).
```
0x000093c6  push 1 ; pop rdx             ; value = 1
0x000093cc  xor esi, esi                 ; option = JXL_ENC_FRAME_SETTING_EFFORT (0)
0x000093ce  call JxlEncoderFrameSettingsSetOption   ; EFFORT = 1
```
Note: effort 1 = "lightning" (fastest). Low but deliberate for a chat client.

### kEncodeDecodingSpeed = 4 — certain (bonus, not in brief)
```
0x000093d3  push 1 ; pop rsi             ; option = JXL_ENC_FRAME_SETTING_DECODING_SPEED (1)
0x000093d6  push 4 ; pop rdx             ; value = 4
0x000093dc  call JxlEncoderFrameSettingsSetOption   ; DECODING_SPEED = 4
```

### kEncodeBitsPerSample = 8, kEncodeAlpha = false, kEncodeNumChannels = 3 — certain
`JxlEncoderInitBasicInfo` sets library defaults; the code overrides **only** xsize/ysize,
so bits_per_sample=8, num_color_channels=3, num_extra_channels=0, alpha_bits=0 remain.
```
0x000092bf  lea rdi, [var_100h]
0x000092c6  call JxlEncoderInitBasicInfo
0x000092d2  mov dword [rsi + 4], r13d    ; basic_info.xsize   (only override)
0x000092d6  mov dword [rsi + 8], r12d    ; basic_info.ysize   (only override)
0x000092dd  call JxlEncoderSetBasicInfo
```
Cross-checked against 22 real Zalo samples (see below): all have ImageMetadata
`all_default=1` ⇒ 8-bit, 3 color channels, no alpha, SRGB. Matches.

### Input pixel format (kEncodePixelDataType / Endianness / Align / NumChannels) — certain
A 24-byte `JxlPixelFormat` is loaded from a constant block and passed to
`JxlEncoderAddImageFrame` @0x93f5.
```
0x000092b1  movups xmm0, xmmword [0x00016a38]   ; 16 bytes -> pixel format [0..15]
0x000092a3  mov rax, qword [0x00016a48]         ; 8 bytes -> align [16..23]
```
Raw bytes `px @0x16a38`: `03 00 00 00  02 00 00 00  00 00 00 00  00 ...`
→ num_channels=**3**, data_type=**2 (JXL_TYPE_UINT8)**, endianness=**0 (JXL_NATIVE_ENDIAN)**,
align=**0**.

---

## Decode → JPEG path — `jxlToJpeg` → `encodeJpegOneShotTurbo`

The app JPEG path is turbojpeg (`tj3*`), **not** libjpeg. (`jpeg_set_quality` exists in the
binary but only inside the vendored `jxl::extras::JPEGEncoder::Encode`, which is not on the
app path.)

### Quality is caller-supplied; kJpegQualityScale = 100.0f — certain
`jxlToJpeg` @0x5011 reads JS `"quality"` as a float and scales it:
```
0x0000519b  call Napi::Number::FloatValue() const   ; xmm0 = quality (0..1)
0x000051a0  mulss xmm0, dword [0x000168e0]           ; [0x168e0] = 100.0 (0x42c80000)
0x000051a8  cvttss2si eax, xmm0
0x000051c2  movzx r8d, al                            ; -> worker as uchar quality
```
The JS wrapper (`index.js` `decodeToJpeg`) also forwards `quality` verbatim — **no default
anywhere in C++ or JS**. `kDefaultJpegQuality` therefore has no binary provenance.

### kDefaultJpegQuality = 90 — assumed (verify functionally in Task 6)
Not present in the binary; set to 90 as a common visually-lossless default. **Must be
confirmed functionally in Task 6** (or sourced from the higher-level Zalo caller). It only
matters if a Linux caller ever omits quality; the mac callers always pass it.

### kJpegSubsamp = 2 (TJSAMP_420), kJpegFastDct = 1 — certain
### ⚠️ CORRECTION to the original Task-2 RE — ordinal 10 is FASTDCT, not PROGRESSIVE
`encodeJpegOneShotTurbo` @0x81fa. `tj3Set(h, param, value)` = (rdi, esi, rdx).
```
0x00008249  push 3 ; pop rsi ; mov edx, r13d
0x00008252  call tj3Set                  ; TJPARAM_QUALITY(3) = arg5 (caller quality)
0x00008257  push 4 ; pop rsi
0x0000825a  push 2 ; pop rdx
0x00008260  call tj3Set                  ; TJPARAM_SUBSAMP(4) = 2 (TJSAMP_420)
0x00008265  push 0xa ; pop rsi
0x00008268  push 1 ; pop rdx
0x0000826e  call tj3Set                  ; TJPARAM_FASTDCT(10) = 1   <-- NOT progressive
```
The ordinal pushed at @0x8265 is `0xa` = **10**. In `turbojpeg.h` (identical enum in
libjpeg-turbo 3.0.2 and 3.1.1) the `TJPARAM` enum is: STOPONWARNING=0, BOTTOMUP=1,
NOREALLOC=2, QUALITY=3, SUBSAMP=4, JPEGWIDTH=5, JPEGHEIGHT=6, PRECISION=7, COLORSPACE=8,
FASTUPSAMPLE=9, **FASTDCT=10**, OPTIMIZE=11, **PROGRESSIVE=12**. So ordinal 10 is
**TJPARAM_FASTDCT** (fast integer DCT), value **1** — the mac produces a **BASELINE**
JPEG. It never touches TJPARAM_PROGRESSIVE (ordinal 12), which therefore stays 0.
The original Task-2 RE mislabeled ordinal 10 as "progressive" (value 1) and the Linux
port wrongly set `TJPARAM_PROGRESSIVE=1`, emitting a progressive JPEG (SOF2) instead of
the mac's baseline (SOF0). `re_params.h` `kJpegProgressive` is replaced by
`kJpegFastDct = 1`.

### The mac ALSO embeds the decoded JXL's ICC profile — certain (was missing from Task-2 RE)
Between the last `tj3Set` and `tj3Compress8`, `encodeJpegOneShotTurbo` calls
`tj3SetICCProfile(h, iccBuf, iccSize)`:
```
0x00008273  ... load {ptr,len} pair (iccBuf, iccSize) from the decoded-image struct
0x00008285  call tj3SetICCProfile        ; embed ICC -> APP2 (FF E2) marker
```
The profile is the one recovered during decode. The decode path subscribes
`JXL_DEC_COLOR_ENCODING` and fetches the profile of the **decoded pixel data** with the
libjxl imports `JxlDecoderGetICCProfileSize` / `JxlDecoderGetColorAsICCProfile`
(target `JXL_COLOR_PROFILE_TARGET_DATA`). libjxl 0.9.3 signatures (from
`<prefix>/include/jxl/decode.h`, this point release drops the `JxlPixelFormat*` arg):
```
JxlDecoderStatus JxlDecoderGetICCProfileSize(const JxlDecoder*, JxlColorProfileTarget, size_t*);
JxlDecoderStatus JxlDecoderGetColorAsICCProfile(const JxlDecoder*, JxlColorProfileTarget, uint8_t*, size_t);
```
The Linux port (`src/decode.cc`) replicates this and passes `icc.data(), icc.size()` to
`tj3SetICCProfile`, guarded on a non-empty profile (mirrors the mac's non-null {ptr,len}
branch); when the sample carries no ICC the call is skipped and no APP2 marker is emitted.

### libjpeg-turbo version — the mac bundles 3.1.1 (we now pin 3.1.1) — certain
`strings app/native/.../libturbojpeg.0.dylib` → `libjpeg-turbo version 3.1.1`. For
byte-identical JPEG output the Linux deps pin (`scripts/deps-hash.js` `PINS.libjpeg_turbo`)
is bumped **3.0.2 → 3.1.1** (SONAME `libturbojpeg.so.0.4.0`). The turbojpeg entropy /
Huffman tables and default quant behavior can differ across turbojpeg majors/minors, so
matching 3.1.1 is required for bit-exact output.

### kJpegPixelFormat = 0 (TJPF_RGB) — certain
`tj3Compress8(h, src, w, pitch, h, pixelFormat, &buf, &size)`; pixelFormat = r9d.
```
0x000082a3  xor r9d, r9d                 ; pixelFormat = 0 = TJPF_RGB
0x000082a9  call tj3Compress8
```
Pitch is `width*3` (`lea eax, [r12+r12*2]` @0x823d) — consistent with 3-channel RGB.

### Batch-decode contract (kDecodeNumChannels / kDecodePixelDataType) — certain
`decodeJpegXlOneShot` @0x8417 loads the **same** pixel-format constant block for its
`JxlDecoderSetImageOutBuffer`:
```
0x00008579  movups xmm0, xmmword [0x00016a38]   ; num_channels=3, JXL_TYPE_UINT8, native endian
0x00008680  call JxlDecoderSetImageOutBuffer
```
So decode output = 3-channel RGB UINT8, feeding turbojpeg TJPF_RGB. The multi/batch
decoders (`DecodeLocalPathJXLMulti` @0xc324, `...Oneshot` @0xbcb0) share this format.

---

## ⚠️ CORRECTION — the exported `resizeJxl` does NOT use OpenCV (uses hand-rolled bilinear)

**Task-7 RE (this correction supersedes the OpenCV description below for the
`resizeJxl` export.)** The exported `resizeJxl` in BOTH mac binaries
(darwin_x64 @0x9f20 and darwin_arm64 @0x9184) resizes with a **hand-rolled
single-pass bilinear** (`bilinearInterpolate`), NOT OpenCV, NOT the two-stage
INTER_LINEAR→INTER_AREA pipeline. Confirmed call chain (x64, `axt` after `aaa`):

```
ResizeJxlAsyncWorker::Execute @0x44fd
  -> resizeJxl @0x9f20            decode -> resizePPF -> encodeJxlOneshot (@0xa0ce)
     -> resizePPF @0x8a82         target dims via clampSize; then:
        -> bilinearInterpolate @0x12eea   (the resampler)
```

`resizePPFWithOpenCV` (@0x8c8d / @0xb578) DOES exist but its ONLY callers are the
**decode/batch** paths, never resizeJxl:
```
axt @0xb578 -> ProcessDecompressTasks @0xb938 ; jxlDecompressMulti thread body @0xec30
axt @0x8c8d -> DecodeLocalPathJXLProgressive @0xac46, @0xadea
```
So the OpenCV two-stage (1000px INTER_LINEAR pre-scale + INTER_AREA) belongs to
**jxlDecompressMulti / DecodeLocalPath** (Task 8), not `resizeJxl` (Task 7).
`shouldResize` @0xa528 has **no callers** (dead code) — `resizeJxl` never gates on
it and always re-encodes (even a no-op "resize" round-trips through the lossy
encoder). `kResizeInterp` / `kResizePreScaleInterp` / `kResizePreScaleCap` in
`re_params.h` therefore apply to the Task-8 decode path, not resizeJxl.

### resizeJxl target-dimension math — `resizePPF` @0x8a82
`resizePPF(PackedPixelFile&, int reqW, int reqH)` (reqW/reqH from JS width/height;
`-1` = auto sentinel). Computes final dims then, iff they differ from source,
calls `bilinearInterpolate`; otherwise leaves pixels as-is (resizeJxl re-encodes
regardless).
- **both auto** (reqW==reqH==-1, @0x8af9): final = source.
- **both given** (@0x8b09, the JS `{width,height}` case): `clampSize(src, reqW,
  reqH)` then `clampSize(that, 65500, 65500)` (overflow guard).
- **one axis auto**: derive the other by integer aspect —
  height-auto (@0x8b52): `fH = min(srcW,reqW,65500)*srcH/srcW`, `fW = reqW`;
  width-auto (@0x8ad5): `fW = min(srcH,reqH,65500)*srcW/srcH`, `fH = reqH`.

### resizeJxl resampler — `bilinearInterpolate` @0x12eea (byte-identical port)
`std::vector<uchar> bilinearInterpolate(uchar* src, ulong srcSize, int srcW, int
srcH, int dstW, int dstH)` (returned via RVO in rdi). Per output pixel (row j,
col i, channel c of 3):
```
xr = srcW/dstW ; yr = srcH/dstH            ; (double; no 0.5 center offset)
sy = j*yr ; y0 = trunc(sy) ; dy = sy-trunc(sy) ; y0 = clamp(y0,0,srcH-1)  (frac uses UNCLAMPED trunc)
sx = i*xr ; x0 = trunc(sx) ; dx = sx-trunc(sx) ; x0 = clamp(x0,0,srcW-1)
w00=(1-dy)(1-dx) w01=(1-dy)dx w10=dy(1-dx) w11=dy*dx
topLeftByte = 3*(x0 + y0*srcW)         (never exceeds srcSize-1)
botLeftByte = 3*(x0 + (y0+1)*srcW)
TL = src[topLeftByte+c]
TR = src[min(topLeftByte+c+3, srcSize-1)]   ; +3 = "x+1" on the FLAT byte offset,
BL = src[min(botLeftByte+c,   srcSize-1)]   ;   clamped to srcSize-1 (NOT per-axis;
BR = src[min(botLeftByte+c+3, srcSize-1)]   ;   right-edge pixels wrap into next row)
out = (uchar)trunc( TL*w00 + TR*w01 + BL*w10 + BR*w11 )   ; accumulate TL,TR,BL,BR
```
The flat-offset neighbour addressing (no per-axis clamp of x+1 / y+1) is an exact
quirk of this implementation that OpenCV would NOT reproduce — hence a hand port
is required for byte-identity. Ported verbatim in `src/resize.cc`.

### resizeJxlLimit — NOT PRESENT in either mac binary (fully assumed)
`rabin2 -qz` of darwin_x64 and darwin_arm64 exports only `resizeJxl` (no
`resizeJxlLimit`). The JS wrapper `index.js` calls
`nodeAddon.resizeJxlLimit({buffer,width,height,limit})`, but the native symbol was
never compiled into either shipping binary — so there is **no binary provenance**
for its algorithm. The Linux port implements it as a faithful extension of
resizeJxl: at a non-binding limit it is byte-identical to `resizeJxl`; when the
encoded output exceeds `limit`, it shrinks the target box (×0.85 per step, same
bilinear+encode pipeline per size) until the output fits. **assumed.**

## clampSize formula — `clampSize` @0x12e7c (byte-identical port)

`void clampSize(uint srcW, uint srcH, uint capW, uint capH, uint& outW, uint& outH)`.
Aspect-preserving downscale into the (capW,capH) box, **truncation** at every step.

```
0x00012e80  cmp edi, edx ; ja 0x12e88          ; srcW > capW ?
0x00012e84  cmp esi, ecx ; jbe 0x12ea5         ; srcW<=capW && srcH<=capH -> NO scale
0x00012e88  seta r10b (srcH>capH); seta r11b (srcW>capW)
0x00012e94  mov eax,esi ; imul eax,edi         ; area = srcW*srcH  (32-bit)
0x00012e99  cmp eax,0x10000000 ; ja 0x12ead    ; area > 2^28 -> scale (overflow guard)
0x00012ea0  and r11b,r10b ; jne 0x12ead        ; (srcW>capW && srcH>capH) -> scale
0x00012ea5  mov [r8],edi ; mov [r9],esi        ; NO scale: outW=srcW, outH=srcH
0x00012ead  cvtsi2sd xmm0,srcW ; cvtsi2sd xmm1,srcH
0x00012ec2  divsd xmm0,xmm1                    ; xmm0 = srcW/srcH  (aspect)
0x00012ec5  cvtsi2sd xmm2,capW ; divsd xmm2,xmm0 ; xmm2 = capW/aspect
0x00012eca  cvttsd2si rax,xmm2                 ; hc = TRUNC(capW/aspect)
0x00012ecf  cmp eax,ecx ; cmovb ecx,eax        ; outH = min_unsigned(hc, capH)
0x00012ed4  mov [r9],ecx
0x00012ed7  cvtsi2sd xmm1,outH ; mulsd xmm1,xmm0
0x00012ee0  cvttsd2si rax,xmm1                 ; outW = TRUNC(outH*aspect)
0x00012ee5  mov [r8],eax
```
So: **scale iff** `(srcW*srcH > 0x10000000)` **or** `(srcW>capW && srcH>capH)`;
else pass through. When scaling:
`aspect = (double)srcW/srcH; outH = min(trunc(capW/aspect), capH);
outW = trunc(outH*aspect)`. Every float→int is `cvttsd2si` = **truncate toward
zero** (no +0.5 rounding). A standalone C oracle reproduces the shipped dims:
`1920x1080 →box 64 = 64x36`, `→box 800 = 800x450`, `602x400 →box 64 = 63x42`,
`1280x592 →box 800 = 1280x592` (only width exceeds ⇒ no scale). Ported verbatim in
`src/resize.cc`.

---

## Resize path — `resizePPFWithOpenCV`  (Task-8 decode/batch path — see correction above)

Two overloads exist and are byte-identical in logic: signed-dims @0x8c8d and unsigned-dims
@0xb578. Both implement a **two-stage** OpenCV downscale. `cv::resize(src, dst, Size, fx,
fy, interpolation)` — interpolation is the 4th integer arg = `rcx`; `fx=fy=0`.

### Stage 1 — pre-scale to a 1000px cap with INTER_LINEAR (kResizePreScaleInterp = 1) — certain
Runs only when a source dimension > 1000 and a target dimension < 1000 (branch @0xb602…):
```
0x0000b638  mov edx, 0x3e8 ; mov ecx, 0x3e8      ; clamp target = 1000x1000
0x0000b642  call clampSize
0x0000b681  push 1 ; pop rcx                      ; interpolation = 1 = INTER_LINEAR
0x0000b68a  call cv::resize
```
(signed overload: `push 1` @0x8d96, `call cv::resize` @0x8d9f). Cap constant 0x3e8 = 1000
→ `kResizePreScaleCap`.

### Stage 2 — final downscale to requested size with INTER_AREA (kResizeInterp = 3) — certain
Runs when current dims still exceed the requested target (`cmp r12d,r15d` @0xb6b8):
```
0x0000b6ec  call clampSize                        ; clamp to (targetW, targetH)
0x0000b732  push 3 ; pop rcx                       ; interpolation = 3 = INTER_AREA
0x0000b73b  call cv::resize
```
(signed overload: `push 3` @0x8e47, `call cv::resize` @0x8e50.)
`kResizeInterp` is set to the **final** downscale flag (INTER_AREA=3). For bit-identical
output the full two-stage pipeline (LINEAR pre-scale to a 1000px cap, then AREA to target)
must be reproduced — hence the extra `kResizePreScaleInterp` / `kResizePreScaleCap`.

`shouldResize(w,h,tw,th)` @0xa528 only requests a resize when a target dim is > 0 and
strictly smaller than the source dim (downscale-only).

### Resize re-encode (kResizeReencodeDist = 2.28f, kResizeReencodeEffort = 1) — certain
`resizeJxl` @0x9f20 re-encodes via the shared `encodeJxlOneshot` (call @0xa0ce), so the
re-encode distance/effort/lossless/pixel-format are identical to the encode path above.

---

## Sample header cross-check

**jxlinfo cross-check: DEFERRED.** The pinned libjxl tools (`jxlinfo`, `djxl`) built by
Task 1 were not yet present at
`nativelibs/zjxl/.deps-prefix/f28d936cd8cb/bin/` (only libjpeg-turbo tools existed). The
check was instead performed manually against libjxl's own field layout
(`deps-src/libjxl/lib/jxl/headers.cc` `SizeHeader::VisitFields`,
`image_metadata.cc` `ImageMetadata::VisitFields`).

A bit-exact parser (`scratchpad/jxlparse.py`) reads each sample's `ff0a` codestream:
signature → SizeHeader → ImageMetadata's first bit `all_default`. Result over all 22
Zalo samples in `scratchpad/jxl-samples/`:

```
22/22 samples: valid ff0a codestream, ImageMetadata all_default = 1
```

`all_default=1` means the image uses default metadata: **8-bit, 3 color channels, no extra
channels / no alpha, SRGB**. This exactly matches the recovered encoder configuration
(`kEncodeBitsPerSample=8`, `kEncodeNumChannels=3`, `kEncodeAlpha=false`). Parsed dimensions
(e.g. 1920x1080, 2560x1440, 602x400) are sensible real image sizes, confirming the parser.

When Task 1's `jxlinfo` becomes available, re-running
`jxlinfo -v scratchpad/jxl-samples/<file>.jxl` should report the same `8-bit`, RGB, no
alpha for final confirmation.

---

## Confidence summary

| Constant | Value | Confidence |
|---|---|---|
| kEncodeDistance | 2.28f | certain |
| kEncodeLossless | false | certain |
| kEncodeEffort | 1 | certain |
| kEncodeDecodingSpeed | 4 | certain |
| kEncodeBitsPerSample | 8 | certain |
| kEncodeAlpha | false | certain |
| kEncodeNumChannels | 3 | certain |
| kEncodePixelDataType | 2 (UINT8) | certain |
| kEncodeEndianness | 0 | certain |
| kEncodePixelAlign | 0 | certain |
| kJpegQualityScale | 100.0f | certain |
| kDefaultJpegQuality | 90 | **assumed** — verify in Task 6 |
| kJpegSubsamp | 2 (TJSAMP_420) | certain |
| kJpegFastDct | 1 (TJPARAM_FASTDCT, ordinal 10 → BASELINE) | certain — corrects Task-2 "progressive" mislabel |
| (ICC embed) | tj3SetICCProfile @0x8285, profile from decoded JXL | certain — was missing from Task-2 RE |
| libjpeg-turbo pin | 3.1.1 (mac-bundled) | certain — bumped from 3.0.2 |
| kJpegPixelFormat | 0 (TJPF_RGB) | certain |
| kDecodeNumChannels | 3 | certain |
| kDecodePixelDataType | 2 (UINT8) | certain |
| kResizeInterp | 3 (INTER_AREA) | certain |
| kResizePreScaleInterp | 1 (INTER_LINEAR) | certain |
| kResizePreScaleCap | 1000 | certain |
| kResizeReencodeDist | 2.28f | certain |
| kResizeReencodeEffort | 1 | certain |

**20 certain, 1 assumed** (`kDefaultJpegQuality` — no binary/JS provenance; caller always
supplies quality, so it only matters as a Linux-side fallback; confirm functionally in
Task 6).

---

## getJxlInfo output keys

**Certain — disassembled `GetJxlInfoAsyncWorker::OnOK()`** (mac x86_64
`app/native/nativelibs/zjxl/build/darwin_x64/jxl.node`, symbol
`__ZN21GetJxlInfoAsyncWorker4OnOKEv` @0x40b0):

```
0x00004109  lea rsi, [str.width]       ; "width"    @0x1548d
0x00004117  call Napi::Object::Set(..., "width", Number(worker+0x88))
0x0000413b  lea rsi, [str.height]      ; "height"   @0x15493
0x00004149  call Napi::Object::Set(..., "height", Number(worker+0x8c))
0x0000416d  lea rsi, [str.orientation] ; "orientation" @0x1549a
0x0000417b  call Napi::Object::Set(..., "orientation", Number(worker+0x90))
```

The returned object has **exactly three keys: `width`, `height`, `orientation`** — no
`hasAlpha` / `bitsPerSample` (those were the Task-4-brief placeholder default, now
corrected). `Execute()` (`GetJxlInfoAsyncWorker::Execute()` @0x4012) confirms the field
mapping by tracing the outputs of the internal helper
`getJxlInfo(const uchar*, size_t, uint32_t*, uint32_t*, uint32_t*, int&)`:

```
0x00004041  call getJxlInfo(data, size, &var_1c, &var_18, &var_14, &worker+0xa0)
0x0000404a  mov eax, [var_1c]; mov [worker+0x88], eax   ; out param #1 -> width
0x00004053  mov eax, [var_18]; mov [worker+0x8c], eax   ; out param #2 -> height
0x0000405c  mov eax, [var_14]; mov [worker+0x90], eax   ; out param #3 -> orientation
```

so the helper's 3rd `uint32_t*` out-param is orientation, and its `int&` out-param
(`worker+0xa0`) is *not* part of the returned object — `OnOK` passes it straight through
as the callback's 3rd argument (`status_code`), i.e. the native helper computes the
status code directly.

Linux implementation (`src/info.cc`) maps `JxlBasicInfo` 1:1: `bi.xsize` → `width`,
`bi.ysize` → `height`, `bi.orientation` → `orientation` (libjxl `JxlOrientation` enum,
1 = identity/no rotation, matching EXIF orientation 1-8).

### jxlinfo cross-check — now available, closes Task 2's deferred item

Task 1's pinned `jxlinfo` is present at
`nativelibs/zjxl/.deps-prefix/f28d936cd8cb/bin/jxlinfo`. Confirmed against
`scratchpad/jxl-samples/z7974466650218_d9ca89985e4f111a92d52b084240a65a.jxl`:

```
$ LD_LIBRARY_PATH=<prefix>/lib <prefix>/bin/jxlinfo <sample>
JPEG XL image, 1920x1080, lossy, 8-bit RGB
```

matches `getJxlInfo`'s `{width: 1920, height: 1080}` on the same file exactly.
