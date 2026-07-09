# zimage — reverse-engineered thumbnail parameters

Recovered from the macOS native addon shipped in Zalo bundle **26.6.20**:

- `app/native/nativelibs/zimage/darwin_x64/zimage.node` (x86_64 Mach-O, C++ symbols intact)
- `app/native/nativelibs/zimage/darwin_x64/libvips-cpp.42.dylib` (libvips **8.14.2**)

Tool: `radare2` (`aaa` + `af` + `pdf`). Addresses are file offsets == vaddr (image base 0).
These values are the single source of truth for `src/re_params.h`.

---

## Call-site check (Step 1) — IS `zimage().Image.thumbnail` REACHED?

**YES — reached directly, not preempted by a Chromium/canvas path.**

`app/main-dist/utility-process-media.js` (Node utility process) contains a `resizeImage`
helper that calls the addon directly:

```js
resizeImage:async(e,t,n,r,i)=>{try{const o=(await H.a.zimage()).Image,
  s=await o.thumbnail(Buffer.from(e),t,n,i,r);return Uint8Array.from(s)}catch...
```

Caller: `...resizeImage(c,n,r,i,"image/jpeg"===o?"jpeg":"png");` then `writeFile(...)`.

Argument threading (JS): `resizeImage(buf, width, height, format, quality)` →
`thumbnail(Buffer, width, height, format, quality)`. So the native addon receives
`(buffer, width, height, format)` and the trailing `quality` — **but the native ctor
ignores quality** (see below). `format` is only ever `"jpeg"` or `"png"`.

Preempt check: `grep '(thumbnail|resizeQA).*(canvas|createImageBitmap)'` over
`app/pc-dist/compact-app-pc.*.js` returned **no matches**. There are ~15 generic
`createImageBitmap`/`OffscreenCanvas` uses in the renderer, but none intercept this
resize path — resize runs in the media utility process via `zimage.node` and writes the
result to disk. Unlike zjxl (whose display path Chromium preempted), **zimage.thumbnail
is genuinely used.**

---

## Native entry points & signatures

```
sym.thumbnail(Napi::CallbackInfo const&)            @0x1a6d  -> ThumbnailAsyncWorker
sym.thumbnailFs(Napi::CallbackInfo const&)          @0x39cd  -> ThumbnailFsAsyncWorker
ThumbnailAsyncWorker::Execute()                     @0x1468
ThumbnailFsAsyncWorker::Execute()                   @0x38f8
```

Constructor (demangled, `c++filt`):
```
ThumbnailAsyncWorker::ThumbnailAsyncWorker(
    Napi::Buffer<char>&, int, int,
    std::__1::basic_string<char,...>, Napi::Function&)
```
→ takes **buffer, int width, int height, std::string format, callback**.
There is **no quality parameter**, confirming the JS `quality` arg is dropped and
JPEG `Q` is never set at the native layer.

---

## Thumbnail options (both variants set only `height` + `size`)

### Buffer variant — `ThumbnailAsyncWorker::Execute` @0x1468

```
0x1484  mov  rdi, [arg1+0x80]          ; buf
0x148b  mov  rsi, [rbx+0xb0]           ; len
0x1492  mov  ecx, [rbx+0xa8]           ; width  (positional)
0x1498  mov  r9d, [rbx+0xac]           ; height VALUE (paired with "height")
0x149f  and  qword [var_10h], 0        ; NULL terminator on stack
0x14a5  lea  rax, str.size ; mov [rsp], rax
0x14b0  mov  dword [var_8h], 3         ; "size" VALUE = 3
0x14b8  lea  r8,  str.height           ; "height" key
0x14bf  lea  rdx, [var_38h]            ; &out
0x14c5  call vips_thumbnail_buffer
```
Reconstructed call:
`vips_thumbnail_buffer(buf, len, &out, width, "height", height, "size", 3, NULL)`

### File variant — `ThumbnailFsAsyncWorker::Execute` @0x38f8

**Full disassembly (Task 5, re-verified with `r2 -A` directly against the mac
binary — the earlier pass below stopped at @0x3906..0x397a and left the
@0x393d..0x3979 span undocumented; that span is now confirmed to be pure
error-handling, not any hidden flatten/alpha logic):**

```
0x38f8  push rbp ; mov rbp, rsp ; push r14 ; push rbx ; sub rsp, 0x30
0x3903  mov  rbx, rdi                  ; this
0x3906  mov  rdi, [rdi+0x68]           ; inputPath (std::string data ptr)
0x390a  mov  edx, [rbx+0x90]           ; width
0x3910  mov  r8d, [rbx+0x94]           ; height VALUE
0x3917  and  qword [var_8h], 0         ; NULL terminator on stack
0x391d  mov  dword [rsp], 3            ; "size" VALUE = 3
0x3924  lea  rcx, str.height
0x392b  lea  r9,  str.size
0x3932  lea  rsi, [var_18h]            ; &out
0x3938  call vips_thumbnail
0x393d  test eax, eax
0x393f  je   0x396e                    ; rc==0 (success) -> skip error path
   ; --- error path (rc!=0): throws "An error occurred in thumbnailing
   ; --- using file system" as a std::string, taken only on vips_thumbnail
   ; --- failure. No vips_image_hasalpha / vips_flatten call anywhere here.
0x3941..0x396c  (build+throw error string; jmp 0x39b0 to epilogue)
0x396e  mov  rdi, [var_18h]            ; out
0x3972  mov  rsi, [rbx+0x70]           ; outputPath (std::string data ptr)
0x3976  xor  edx, edx                  ; NULL options terminator
0x3978  xor  eax, eax                  ; 0 vector regs (no va_arg floats)
0x397a  call vips_image_write_to_file  ; vips_image_write_to_file(out, outputPath, NULL)
0x397f  mov  rdi, [var_18h]
0x3983  push 1 ; pop rsi
0x3986  call vips_image_set_kill       ; vips_image_set_kill(out, 1) -- post-write cleanup
0x398b  mov  rdi, [var_18h]
0x398f  call g_object_unref            ; g_object_unref(out)
0x3994..0x39ab  free the two heap-allocated path strings (operator delete[])
0x39b0  add rsp,0x30 ; pop rbx ; pop r14 ; pop rbp ; ret
```
Reconstructed: `vips_thumbnail(inputPath, &out, width, "height", height, "size", 3, NULL)`
then, only on success, `vips_image_write_to_file(out, outputPath, NULL)` — **zero
save options**, format driven entirely by `outputPath`'s extension via libvips'
own `vips_foreign_find_save` dispatch. Confirmed there is **no**
`vips_image_hasalpha`/`vips_flatten` call in this function at all (unlike the
buffer variant, which gates a flatten-onto-white on `vips_image_hasalpha` for
the jpeg path) — the entire 192-byte function body is accounted for above, and
the `str.jpg`/`str.png`/`strip`/`vips_array_double_new` symbols referenced by
the buffer variant do not appear in this function's disassembly or its nearby
string xrefs. So `thumbnailFs` never flattens alpha and never sets a "strip"
option; it is a strictly thinner pipeline than `thumbnail`.

| Constant | Value | Enum | Address / evidence | Confidence |
|---|---|---|---|---|
| `kThumbSize` | `3` | `VIPS_SIZE_FORCE` | immediate `mov [..],3` @0x14b0 & @0x391d | **certain (explicit)** |
| `kThumbCrop` | `0` | `VIPS_INTERESTING_NONE` | `"crop"` never passed → libvips default | certain (unset→default) |
| `kThumbAutoRotate` | `true` | — | `"no_rotate"` never passed → default FALSE → autorotate ON | certain (unset→default) |
| `kThumbLinear` | `false` | — | `"linear"` never passed → default FALSE | certain (unset→default) |
| `kThumbIntent` | `1` | `VIPS_INTENT_RELATIVE` | `"intent"` never passed → default RELATIVE | certain (unset→default) |

> Note on `size=FORCE`: with `size=3` and both `width` (positional) and `height` set,
> `vips_thumbnail` forces the output to exactly `width × height`; aspect ratio is **not**
> preserved. Only `size` and `height` are ever passed — the string table in the binary
> also contains `crop`, `linear`, `smartcrop`, `subsample`, `resize`, `tile_height`, but
> those belong to inlined libvips wrappers and are **not** referenced from the two
> `Execute` functions.

---

## Format dispatch & save options (`ThumbnailAsyncWorker::Execute`)

```
0x14f3  lea  rdi, [rbx+0x90]           ; &format (std::string)
0x14fa  lea  rsi, str.jpeg             ; "jpeg"
0x1501  call std::operator==(basic_string const&, char const*)   ; sym @0x1686 = "eq"
0x150a  mov  rdi, [var_38h]            ; thumbnailed image
0x150c  test al, al ; je 0x15a5        ; al!=0 (==jpeg) -> fall through; al==0 -> png
```
Operator confirmed `operator==` via `rabin2 -s`: symbol `__ZNSt3__1eqB8ne180100...`
(`eq` = `operator==`; `B8ne180100` is just the libc++ `[abi:...]` tag).

- **`format == "jpeg"`** (fall-through): **if** `vips_image_hasalpha(img)`, flatten alpha → white, **then** jpegsave. If no alpha, jpegsave the thumbnailed image unchanged.
- **else (`"png"`)** (`je 0x15a5`): pngsave, no options. Only jpeg & png are produced.

> **CORRECTION (re-verified 2026-07-09 during Task 4, directly against the mac
> binary with `r2`):** the flatten call is **NOT unconditional** as originally
> stated here, and the background array has **3 elements**, not 1. Full trace
> of `ThumbnailAsyncWorker::Execute` @0x1468:
> ```
> 0x1501  call operator==(format, "jpeg")
> 0x150c  test al,al; je 0x15a5                 -> else: pngsave (no flatten)
> 0x1512  call vips_image_hasalpha(img)          -> only reached when jpeg
> 0x1519  test eax,eax; je 0x15be                -> no alpha: skip flatten
> 0x151f  movaps xmm0, [section.__const]         ; two doubles, both 255.0
> 0x152d  movabs rax, 0x406fe00000000000         ; third double, 255.0
> 0x153b  push 3 ; pop rsi                        ; n = 3
> 0x153e  call vips_array_double_new              ; {255.0,255.0,255.0}
> 0x155d  call vips_flatten(img,&out,"background",bg3,NULL)
> 0x15dd  call vips_jpegsave_buffer(img_or_flat,&buf,&len,"strip",1,NULL)
> ```
> `pf ddd` at the `movaps` source address (`section.5.__TEXT.__const`)
> confirms both preloaded doubles are `0x406fe00000000000` = 255.0, matching
> the explicit third `movabs 255.0` — i.e. background = `[255,255,255]`.
> Reproducing the original (unconditional, 1-element) reading is a real bug:
> `vips_flatten` unconditionally treats the **last band** as alpha and drops
> it, with no check that the image actually has an alpha channel. Confirmed
> empirically with the pinned Linux libvips: `vips flatten` on a real 3-band
> sRGB JPEG sample (no alpha) turns it into a **2-band** image, silently
> discarding the blue channel. Since the overwhelming majority of JPEG inputs
> have no alpha channel, applying flatten unconditionally would corrupt nearly
> every JPEG thumbnail the mac addon ever produced — implausible for shipped
> software, and disproven by the `vips_image_hasalpha` call visible in the
> disassembly once traced fully (the original Task 2 pass stopped short of
> it).

### JPEG path
```
0x1512  vips_image_hasalpha(img)                                      ; gate
0x151f..0x155d  vips_flatten(img, "background", [255,255,255], NULL)  ; ONLY if hasalpha
0x15dd  lea rsi,[rbx+0x88] ; &buf
0x15e4  lea rdx,[rbx+0xb8] ; &len
0x15eb  lea rcx, str.strip                 ; "strip"
0x15f2  push 1 ; pop r8                     ; strip = 1 (TRUE)
0x15f6  xor r9d,r9d                         ; NULL terminator
0x15fb  call vips_jpegsave_buffer
```
Reconstructed: `if (vips_image_hasalpha(img)) img = vips_flatten(img, "background", [255,255,255]); vips_jpegsave_buffer(img, &buf, &len, "strip", 1, NULL)`.

| Constant | Value | Address / evidence | Confidence |
|---|---|---|---|
| `kJpegStrip` | `true` (1) | `"strip"` + `push 1` @0x15eb–0x15f2 | **certain (explicit)** |
| `kJpegFlattenOnlyIfAlpha` | `true` | `vips_image_hasalpha` call + `je 0x15be` @0x1512–0x1519 gating the flatten | **certain (explicit)** |
| `kJpegFlattenBg` | `[255.0, 255.0, 255.0]` (3-elem) | movaps (2×255.0) @0x151f + movabs 255.0 @0x152d, `push 3` (n) @0x153b → `vips_array_double_new` @0x153e → `vips_flatten background` @0x155d | **certain (explicit)** |
| `kJpegQ` | `75` | `"Q"` never passed → mozjpeg/libvips default 75 | certain (unset→default) |
| `kJpegOptimize` | `false` | `"optimize_coding"` never passed → default FALSE | certain (unset→default) |
| `kJpegSubsample` | `0` (AUTO) | `"subsample_mode"` never passed → default AUTO | certain (unset→default) |

### PNG path
```
0x15a5  lea rsi,[rbx+0x88] ; &buf
0x15ac  lea rdx,[rbx+0xb8] ; &len
0x15b3  xor ecx,ecx        ; NULL terminator (no options)
0x15b7  call vips_pngsave_buffer
```
Reconstructed: `vips_pngsave_buffer(img, &buf, &len, NULL)` — **no options at all**.

| Constant | Value | Evidence | Confidence |
|---|---|---|---|
| `kPngCompression` | `6` | no options → libvips default 6 | certain (unset→default) |
| `kPngStrip` | `false` | no options → default FALSE (PNG keeps metadata) | certain (unset→default) |
| `kPngPalette` | `false` | no options → default FALSE | certain (unset→default) |

### WebP
**Not reachable.** No `webpsave` call exists in either `Execute`. The addon emits only
JPEG or PNG. `kWebpQ/kWebpEffort/kWebpLossless` in `re_params.h` are libvips defaults
only, marked **assumed/unused**; do not rely on them for parity.

---

## Recovered mac codec versions (from `libvips-cpp.42.dylib` strings)

| Library | Version | Confidence | Note |
|---|---|---|---|
| libvips | **8.14.2** | certain | adjacent to "print libvips version" |
| JPEG codec | **mozjpeg 4.1.1 (build 20230321)** | certain | **NOT** plain libjpeg-turbo — affects byte-identical JPEG output; Task 1/6 must pin mozjpeg 4.1.1 |
| libpng | **1.6.39** | certain | "libpng version 1.6.39 - November 20, 2022"; libspng PNG load/save also enabled |
| libwebp | present | low | build reports `libwebp: true`; exact version indeterminate (unused anyway) |
| libjxl | **disabled** | certain | `JXL load/save with libjxl: false` — no JXL in this addon |
| libtiff | present | certain | `libtiff: true` |

> **Action for Task 1/6:** the JPEG saver is **mozjpeg 4.1.1**, not stock libjpeg-turbo.
> Bit-identical JPEG thumbnails require building libvips 8.14.2 against mozjpeg 4.1.1.

---

## Step 3 cross-check — DEFERRED

`node nativelibs/zimage/scripts/deps-hash.js` →
`nativelibs/zimage/.deps-prefix/0a877d1c9c92`, but
`.deps-prefix/0a877d1c9c92/bin/vipsthumbnail` does **not exist yet** (Task 1 deps build
still in progress). Cross-check deferred per brief. Real samples are staged in
`scratchpad/img-samples/` (6 JPEG + JXL). The disassembly is unambiguous
(`size=FORCE`, `height` set, jpeg `strip=1`, everything else default), so recovery does
not depend on the CLI check. Re-run once the pinned `vipsthumbnail` exists:
```
PREFIX=$(node nativelibs/zimage/scripts/deps-hash.js)
LD_LIBRARY_PATH="$PREFIX/lib" "$PREFIX/bin/vipsthumbnail" \
  scratchpad/img-samples/<file>.jpg --size <W> -o /tmp/vt.jpg
```

---

## Summary of confidence

- **Explicit (certain):** `kThumbSize=FORCE`, `kJpegStrip=true`,
  `kJpegFlattenBg=[255,255,255]` (3-elem, gated by `kJpegFlattenOnlyIfAlpha` /
  `vips_image_hasalpha` — corrected in Task 4, see the JPEG-path section above),
  format dispatch (jpeg vs png), FS variant uses write-to-file with ZERO save
  options and NO flatten/hasalpha call at all (full disassembly, Task 5).
- **Certain (unset→libvips-8.14.2 default):** `kThumbCrop`, `kThumbAutoRotate`,
  `kThumbLinear`, `kThumbIntent`, `kJpegQ`, `kJpegOptimize`, `kJpegSubsample`,
  `kPngCompression`, `kPngStrip`, `kPngPalette`. These are provably not set; parity is
  achieved by leaving them unset (or setting the identical default) on Linux with the
  same libvips version.
- **Assumed/unused:** all WebP constants (addon never emits WebP).

To later functionally confirm the "unset→default" values, run the deferred `vipsthumbnail`
cross-check against `scratchpad/img-samples/` once Task 1's pinned deps exist, and compare
byte output of a native Linux build against the mac addon on the same inputs.
