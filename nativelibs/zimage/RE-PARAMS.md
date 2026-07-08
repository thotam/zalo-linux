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

```
0x3906  mov  rdi, [rdi+0x68]           ; filename
0x390a  mov  edx, [rbx+0x90]           ; width
0x3910  mov  r8d, [rbx+0x94]           ; height VALUE
0x3917  and  qword [var_8h], 0         ; NULL terminator
0x391d  mov  dword [rsp], 3            ; "size" VALUE = 3
0x3924  lea  rcx, str.height
0x392b  lea  r9,  str.size
0x3932  lea  rsi, [var_18h]            ; &out
0x3938  call vips_thumbnail
0x397a  call vips_image_write_to_file  ; dest = [rbx+0x70]
```
Reconstructed: `vips_thumbnail(filename, &out, width, "height", height, "size", 3, NULL)`
then `vips_image_write_to_file(out, dest)` (format/options driven by dest extension, all defaults).

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

- **`format == "jpeg"`** (fall-through): flatten alpha → white, then jpegsave.
- **else (`"png"`)** (`je 0x15a5`): pngsave, no options. Only jpeg & png are produced.

### JPEG path
```
0x151f..0x155d  vips_flatten(img, "background", [255,255,255])   ; movabs 0x406fe0..=255.0
0x15dd  lea rsi,[rbx+0x88] ; &buf
0x15e4  lea rdx,[rbx+0xb8] ; &len
0x15eb  lea rcx, str.strip                 ; "strip"
0x15f2  push 1 ; pop r8                     ; strip = 1 (TRUE)
0x15f6  xor r9d,r9d                         ; NULL terminator
0x15fb  call vips_jpegsave_buffer
```
Reconstructed: `vips_jpegsave_buffer(img, &buf, &len, "strip", 1, NULL)`.

| Constant | Value | Address / evidence | Confidence |
|---|---|---|---|
| `kJpegStrip` | `true` (1) | `"strip"` + `push 1` @0x15eb–0x15f2 | **certain (explicit)** |
| `kJpegFlattenBg` | `255.0` | movabs `0x406fe00000000000` @0x152d → `vips_flatten background` @0x154a | **certain (explicit)** |
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

- **Explicit (certain):** `kThumbSize=FORCE`, `kJpegStrip=true`, `kJpegFlattenBg=255`,
  format dispatch (jpeg vs png), FS variant uses write-to-file.
- **Certain (unset→libvips-8.14.2 default):** `kThumbCrop`, `kThumbAutoRotate`,
  `kThumbLinear`, `kThumbIntent`, `kJpegQ`, `kJpegOptimize`, `kJpegSubsample`,
  `kPngCompression`, `kPngStrip`, `kPngPalette`. These are provably not set; parity is
  achieved by leaving them unset (or setting the identical default) on Linux with the
  same libvips version.
- **Assumed/unused:** all WebP constants (addon never emits WebP).

To later functionally confirm the "unset→default" values, run the deferred `vipsthumbnail`
cross-check against `scratchpad/img-samples/` once Task 1's pinned deps exist, and compare
byte output of a native Linux build against the mac addon on the same inputs.
