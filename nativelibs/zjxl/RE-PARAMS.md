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

### kJpegSubsamp = 2 (TJSAMP_420), kJpegProgressive = 1 — certain
`encodeJpegOneShotTurbo` @0x81fa. `tj3Set(h, param, value)` = (rdi, esi, rdx).
```
0x00008249  push 3 ; pop rsi ; mov edx, r13d
0x00008252  call tj3Set                  ; TJPARAM_QUALITY(3) = arg5 (caller quality)
0x00008257  push 4 ; pop rsi
0x0000825a  push 2 ; pop rdx
0x00008260  call tj3Set                  ; TJPARAM_SUBSAMP(4) = 2 (TJSAMP_420)
0x00008265  push 0xa ; pop rsi
0x00008268  push 1 ; pop rdx
0x0000826e  call tj3Set                  ; TJPARAM_PROGRESSIVE(10) = 1
```

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

## Resize path — `resizePPFWithOpenCV`

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
| kJpegProgressive | 1 | certain |
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
