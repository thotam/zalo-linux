# Roadmap — Reverse-engineering the remaining native modules (Linux)

Trạng thái hiện tại của `app/native/nativelibs/*`. **5 module đã port** (build/relink cho Linux); **6 module proprietary** còn lại chỉ có prebuilt darwin/win → hiện **guard/stub** (không crash) và cần RE để chạy thật trên Linux.

> **Phát hiện quan trọng (2026-07-09) — feature-flag gating:** app Zalo route resize/decode ảnh qua nhiều resizer (Canvas 2D, WASM, native) và chọn bằng **remote-config flags mặc định OFF**: `image_resizer.enable_libvips_macos`, `offload_config.enable_offload_lipvips_resize` (zimage), `enable_offload_{jxl_resize,decode_jxl,encode_jxl}` (zjxl). Vì vậy **mặc định app KHÔNG gọi zimage/zjxl** — dùng Chromium/canvas/WASM. Đây là thiết kế của Zalo (rollout dần từ server), **không phải lỗi port**. Đã verify: khi ép các flag = true, cả zimage (thumbnail JPEG/PNG thật, 2–110ms) và zjxl (decode/resize JXL) chạy đúng trong app thật, **zero crash**. Chi tiết cơ chế + cách ép flag để test: xem memory `zalo-native-lib-feature-flags`.

> "RE" ở đây = **reimplement JS API trên OSS lib tương đương** (không có source gốc để build). API surface nhỏ và đã biết chính xác (tên hàm + shape tham số lấy từ `index.js`), nên khả thi. Với module Rust (NAPI-RS) có thể reimplement JS hoặc dựng lại addon Rust.

> **Công cụ version-drift** (`nativelibs/scripts/check-native-versions.js`, baseline `nativelibs/expected-versions.json`): đọc version thư viện thật từ binary macOS, cảnh báo khi bản Zalo mới đổi version để cập nhật pin. Chạy tự động (non-fatal) mỗi `npm run setup`. Nó cũng đã phát hiện **zimage bundle libvips 59.2.0** (dùng cho RE zimage bên dưới).

---

## Bảng tổng quan

| Module | Chức năng | Bọc OSS | Linux hiện tại | API app gọi | Ưu tiên |
|---|---|---|---|---|---|
| **sqlite3** | DB SQLCipher | mapbox sqlite3 + SQLCipher | ✅ DONE (build) | — | — |
| **db-cross-v4** | Giải mã backup E2EE | clean-room C++ | ✅ DONE (build) | — | — |
| **zfile** | Disk info / file ops | glibc statvfs | ✅ DONE (build+wrapper) | — | — |
| **zjxl** | Codec **JPEG-XL** | libjxl 0.9.3+OpenCV 4.12+turbojpeg 3.1.1 | ✅ **DONE (native, byte-identical)** | `getJxlInfo, decodeToJpeg(jxlToJpeg), bitmapToJxl, resizeJxl(+Limit), jxlDecompressMulti` | — (flag-gated) |
| **zimage** | Thumbnail/resize | **libvips** 8.14.2 (mozjpeg 4.1.1) | ✅ **DONE (native, byte-identical)** | `thumbnail, resizeQA` | — (flag-gated) |
| **v8-profiles** | CPU profiler | v8-profiler (NAN, raw-V8) | ✅ DONE (build) | — | — |
| **mp4thumb** | Thumbnail video | FFmpeg | ⚠️ stub (throw khi gọi) | `generateThumbnail(Async), cancel` | **P2** |
| **zwalker** | Quét/GC cache media | Rust (NAPI-RS) | ⚠️ stub no-op (guard) | `scanDirectory, deleteHomelessFiles, deleteEmptyFolders, statUnmarkedFiles, updateReferenceMessageId` | **P2** |
| **file-utilities** | Dung lượng thư mục, hardlink, fs-type | Rust (NAPI-RS) | ❌ throw `Unsupported OS: linux` → barrel `{}` | `getDirectorySize(Sync/Async/ByGlob), detectHardlinks*, detectFilesystem*` | **P2 (chặn màn Storage)** |
| **file-utils** | Disk usage (statvfs) | glibc | ❌ `{error:'not support'}` | `getDiskUsage` | **P3 (trivial)** |
| **zcall** | Engine gọi thoại/video | WebRTC (Opus/AAC/H264) proprietary | ⚠️ `{error:'not support'}` | `bindCanvas, render, startRender, getActiveAudioCodecs, holdAudio, …` (~30) | **P4 (out-of-scope)** |

---

## Phase 1 — Ảnh (P1)

### ✅ `zjxl` — codec JPEG-XL — **DONE (native, byte-identical)**

**KHÔNG** làm theo hướng `@jsquash`/`sharp` như dự tính ban đầu — đã **RE native đầy đủ từ binary macOS** (`docs/superpowers/plans/2026-07-07-zjxl-linux-native-re.md`, 11 task, merge `4001fd6`):
- Addon **N-API C++** (`nativelibs/zjxl/`), link **libjxl 0.9.3 + OpenCV 4.12.0 + libjpeg-turbo 3.1.1 + hwy 1.0.7 + brotli 1.0.9** — pin **đúng version macOS bundle**, build từ source vào cache `.deps-prefix/<hash>/`, bundle 9 `.so` cạnh `.node` với `RPATH=$ORIGIN` (self-contained).
- 6 method: `getJxlInfo, jxlToJpeg(+FromLocalPath), bitmapToJxl, resizeJxl(+Limit), jxlDecompressMulti, moduleReady`.
- **Byte-identical**: mọi hằng số encode/decode/resize disassemble từ binary mac (`RE-PARAMS.md` + `src/re_params.h`). Decode khớp byte `djxl`; JPEG **baseline+fastDCT+ICC**; resize **bilinear tự viết** (verify bit-exact) cho `resizeJxl`, **OpenCV hai tầng** cho batch; quality `FloatValue×100→cvttss2si truncate`.
- Verified: 6/6 test trên 22 ảnh JXL thật + chạy qua barrel app (`nativelibs.zjxl()`) đủ 5 method.

> **Phát hiện quan trọng:** build 26.6.11 bật `--enable-features=JXL` → **Chromium tự giải mã JXL để hiển thị ảnh**; renderer ưu tiên `createImageBitmap`/canvas. `$zFeatures.libjxl.*` (zjxl) chỉ là **fallback** khi Chromium không làm được → trên Linux desktop **hiếm thao tác UI chạm zjxl**. Module vẫn đúng/parity macOS và chạy chính xác khi được gọi.

### ✅ `zimage` — thumbnail/resize — **DONE (native, byte-identical)**

Chọn hướng **RE native + libvips từ source** (giống zjxl), không dùng sharp. Branch `re/zimage` (9 task, Subagent-Driven; `docs/superpowers/plans/2026-07-08-zimage-linux-native-re.md`):
- Addon **N-API C++** (`nativelibs/zimage/`) link **libvips 8.14.2** static-codecs, backend khớp mac **line-for-line**: **mozjpeg 4.1.1** (không phải libjpeg-turbo), libspng, libwebp, libtiff, libheif (decode-only de265+dav1d), lcms2, libexif, ORC, cgif (qua libimagequant). jxl/magick/pdf/openjpeg **tắt như mac**. glib build **shared** (fix SIGABRT `gchar` dưới Electron). Bundle 7 `.so` cạnh `.node` với `RPATH=$ORIGIN`.
- 2 method: `thumbnail(buffer→buffer, jpeg strip=1)`, `resizeQA→thumbnailFs(file→file, giữ EXIF)`. Params `size=FORCE`, flatten IFF alpha `[255,255,255]` — disassemble từ binary mac (`RE-PARAMS.md` + `src/re_params.h`).
- **Byte-identical**: cả 2 path khớp byte `vips` CLI oracle độc lập trên 6 ảnh thật (Step 3 cross-check). *Còn lại: diff thật với binary mac cần máy mac (Mach-O không chạy trên Linux).*
- Version-tracker mở rộng: cross-check codec zimage (mozjpeg/orc/aom/libpng) vs mac dylib strings.
- **Verified trong app thật** (2026-07-09, ép flag): resize hàng loạt ảnh JPEG 24KB–6MB → thumbnail 300xN, 2–110ms, zero crash.

> **Feature-flag:** như zjxl, zimage dormant theo mặc định (flag `enable_libvips_macos` + `enable_offload_lipvips_resize` OFF); thumbnail hiển thị đi qua Chromium/canvas. Lib sẵn sàng, tự kích hoạt khi Zalo bật flag. Xem note đầu file.

---

## Phase 2 — Media & housekeeping (P2)

### `mp4thumb` — thumbnail video
- **API:** `generateThumbnail(path, opts) → buf`, `generateThumbnailAsync`, `cancel`.
- **Map sang OSS:** `ffmpeg -ss <t> -i <video> -vframes 1 -f image2 <out.jpg>` (spawn) hoặc `fluent-ffmpeg`. `cancel` = kill child process.
- Effort: Low–Med. Dep runtime: `ffmpeg` (thêm vào `.deb` Depends). Verify: sinh thumbnail từ 1 mp4 test.

### `zwalker` — quét & GC cache media (Rust NAPI-RS)
- **API:** `scanDirectory(dir)`, `deleteHomelessFiles`, `deleteEmptyFolders`, `statUnmarkedFiles`, `updateReferenceMessageId`. Hiện stub no-op → cache **không được dọn** (phình dần) nhưng app chạy bình thường.
- **RE approach:** reimplement JS bằng `fs` walk. **Cần hiểu semantics** trước: "homeless files" = file cache không còn message nào tham chiếu; `updateReferenceMessageId` = cập nhật bảng tham chiếu. Đọc cách main-dist gọi (~10 refs) để suy ra hợp đồng, rồi implement `fs.readdir` + đối chiếu với bảng reference trong DB.
- Effort: Med (logic tham chiếu) / Low (nếu chỉ làm scanDirectory + deleteEmptyFolders). Rủi ro: xoá nhầm → phải cẩn trọng, test kỹ trên thư mục giả.
- **Có thể giữ stub cho tới khi cache thực sự phình** (không chặn tính năng nào).

---

## Phase 3 — Storage stats (P3, dễ)

### `file-utils` — disk usage (trivial)
- **API:** `getDiskUsage(path)`. **Map:** dùng luôn `zfile` (đã có `statvfs`) hoặc npm `check-disk-space` (đã là dep). Effort: Very low.

### `file-utilities` — dir size / hardlink / fs-type (Rust)
- **API:** `getDirectorySize(Sync/Async)`, `getDirectorySizeByGlob*`, `detectHardlinks*`, `detectFilesystem*`.
- **Map JS:** dir size = `fs` walk cộng dồn `stat().size` (glob dùng `fast-glob`, đã là dep); hardlink = `stat().nlink > 1` / so `ino`; fs-type = đọc `/proc/mounts` hoặc `statfs`.
- Effort: Low–Med. Hiện barrel nuốt lỗi → màn thống kê dung lượng chỉ thiếu số liệu, không crash.

---

## Phase 4 — Gọi thoại/video (P4) · **out-of-scope ngắn hạn**

### `zcall` — WebRTC engine (proprietary)
- **API (~30 hàm):** `startRender/render/bindCanvas` (video), `getActiveAudioCodecs/holdAudio` (audio), signaling, …
- **Bọc:** stack WebRTC riêng của VNG (Opus/AAC/H264), **không có OSS drop-in**. Giao thức tới call-server nhiều khả năng proprietary/mã hoá, gated theo client.
- **RE approach:** reverse giao thức ZCall + dựng client WebRTC tương thích server Zalo → **dự án reverse-engineering riêng, nhiều tháng, rủi ro cao** (có thể bất khả thi nếu server chặn client type). **Khuyến nghị:** giữ stub (gọi = không khả dụng), chỉ làm khi có nguồn lực chuyên cho nó.

### ✅ `v8-profiles` — CPU profiler — **DONE (build)**
- Addon raw-V8 (NAN), **build cho Linux** (`profiler_electron_linux_x64.node`) + splice nhánh linux (`patch-v8-profiles.js`). Native thật, không stub. ABI gắn chặt Electron 22.3.27.
- **Verified addon chạy đúng** (2026-07-09, gọi trực tiếp dưới Electron ABI): `startProfiling`→busy-work→`stopProfiling` trả CPU profile thật (samples + call tree). API: `startProfiling, stopProfiling, setSamplingInterval, deleteAllProfiles, profiles` + set `process.profiler`.
- **0 call-site trong app**: barrel `v8Profiles()` không được gọi lần nào. Các chuỗi `startProfiling`/`stopProfiling` trong bundle là của **Sentry profiling** (JS/CDP), không phải module này. → **Không có thao tác UI nào trigger** → không thể "test qua app"; chỉ verify được bằng self-test trực tiếp (đã làm). Thêm probe runtime sẽ luôn im lặng (xác nhận 0 usage).

---

## Thứ tự đề xuất

1. ~~**P1 — zjxl**~~ ✅ **DONE**. ~~**zimage**~~ ✅ **DONE** (native, byte-identical, branch `re/zimage`). Cả hai flag-gated (dormant mặc định).
2. **P2 — file-utilities + file-utils** (đã lên P2): **chặn màn Quản lý dữ liệu/Storage** trên Linux (verified 2026-07-09 — flow gọi `getDirectorySizeAsync`/`detectFilesystem` trên `{}` → hỏng, zfile không được chạm tới). Map JS thuần (fs walk + statvfs), không cần byte-identical. → **mp4thumb** (video thumb, ffmpeg) → **zwalker** (GC, làm khi cache phình).
3. **P4 — zcall**: đánh giá khả thi riêng; mặc định để stub.
4. **v8-profiles**: đã build; xác minh logging/trigger (đang làm).

## Nguyên tắc chung khi RE mỗi module
- Giữ **đúng API surface** (tên hàm + shape trả về) mà `index.js`/renderer mong đợi — như đã làm với `zfile` (renderer tra `diskInfo` theo path → cần khớp shape).
- Thêm nhánh `linux` vào `index.js` của module (như patch-zfile/db-cross), fail-loud nếu pattern đổi.
- Verify bằng **dữ liệu thật** (ảnh JXL thật, video thật) + smoke boot, không chỉ unit test.
- Runtime deps mới (ffmpeg, libvips-jxl…) → thêm vào `.deb` `build.deb.depends` và CI apt list.
