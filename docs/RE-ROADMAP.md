# Roadmap — Reverse-engineering the remaining native modules (Linux)

Trạng thái hiện tại của `app/native/nativelibs/*`. **4 module đã port** (build/relink cho Linux); **7 module proprietary** còn lại chỉ có prebuilt darwin/win → hiện **guard/stub** (không crash) và cần RE để chạy thật trên Linux.

> "RE" ở đây = **reimplement JS API trên OSS lib tương đương** (không có source gốc để build). API surface nhỏ và đã biết chính xác (tên hàm + shape tham số lấy từ `index.js`), nên khả thi. Với module Rust (NAPI-RS) có thể reimplement JS hoặc dựng lại addon Rust.

> **Công cụ version-drift** (`nativelibs/scripts/check-native-versions.js`, baseline `nativelibs/expected-versions.json`): đọc version thư viện thật từ binary macOS, cảnh báo khi bản Zalo mới đổi version để cập nhật pin. Chạy tự động (non-fatal) mỗi `npm run setup`. Nó cũng đã phát hiện **zimage bundle libvips 59.2.0** (dùng cho RE zimage bên dưới).

---

## Bảng tổng quan

| Module | Chức năng | Bọc OSS | Linux hiện tại | API app gọi | Ưu tiên |
|---|---|---|---|---|---|
| **sqlite3** | DB SQLCipher | mapbox sqlite3 + SQLCipher | ✅ DONE (build) | — | — |
| **db-cross-v4** | Giải mã backup E2EE | clean-room C++ | ✅ DONE (build) | — | — |
| **zfile** | Disk info / file ops | glibc statvfs | ✅ DONE (build+wrapper) | — | — |
| **zjxl** | Codec **JPEG-XL** | libjxl 0.9.3+OpenCV 4.12+turbojpeg 3.1.1 | ✅ **DONE (native, byte-identical)** | `getJxlInfo, decodeToJpeg(jxlToJpeg), bitmapToJxl, resizeJxl(+Limit), jxlDecompressMulti` | — |
| **zimage** | Thumbnail/resize | **libvips** 59.2.0 (sharp) | ❌ `{error:NOT_SUPPORT}` | `thumbnail, resizeQA` | **P1 (next)** |
| **mp4thumb** | Thumbnail video | FFmpeg | ⚠️ stub (throw khi gọi) | `generateThumbnail(Async), cancel` | **P2** |
| **zwalker** | Quét/GC cache media | Rust (NAPI-RS) | ⚠️ stub no-op (guard) | `scanDirectory, deleteHomelessFiles, deleteEmptyFolders, statUnmarkedFiles, updateReferenceMessageId` | **P2** |
| **file-utilities** | Dung lượng thư mục, hardlink, fs-type | Rust (NAPI-RS) | ⚠️ barrel nuốt lỗi → `{}` | `getDirectorySize(Sync/Async/ByGlob), detectHardlinks*, detectFilesystem*` | **P3** |
| **file-utils** | Disk usage (statvfs) | glibc | ❌ `{error:'not support'}` | `getDiskUsage` | **P3 (trivial)** |
| **zcall** | Engine gọi thoại/video | WebRTC (Opus/AAC/H264) proprietary | ⚠️ `{error:'not support'}` | `bindCanvas, render, startRender, getActiveAudioCodecs, holdAudio, …` (~30) | **P4 (out-of-scope)** |
| **v8-profiles** | CPU profiler | v8-profiler | ⚠️ stub (0 call-site) | — | **Skip** |

---

## Phase 1 — Ảnh (P1)

### ✅ `zjxl` — codec JPEG-XL — **DONE (native, byte-identical)**

**KHÔNG** làm theo hướng `@jsquash`/`sharp` như dự tính ban đầu — đã **RE native đầy đủ từ binary macOS** (`docs/superpowers/plans/2026-07-07-zjxl-linux-native-re.md`, 11 task, merge `4001fd6`):
- Addon **N-API C++** (`nativelibs/zjxl/`), link **libjxl 0.9.3 + OpenCV 4.12.0 + libjpeg-turbo 3.1.1 + hwy 1.0.7 + brotli 1.0.9** — pin **đúng version macOS bundle**, build từ source vào cache `.deps-prefix/<hash>/`, bundle 9 `.so` cạnh `.node` với `RPATH=$ORIGIN` (self-contained).
- 6 method: `getJxlInfo, jxlToJpeg(+FromLocalPath), bitmapToJxl, resizeJxl(+Limit), jxlDecompressMulti, moduleReady`.
- **Byte-identical**: mọi hằng số encode/decode/resize disassemble từ binary mac (`RE-PARAMS.md` + `src/re_params.h`). Decode khớp byte `djxl`; JPEG **baseline+fastDCT+ICC**; resize **bilinear tự viết** (verify bit-exact) cho `resizeJxl`, **OpenCV hai tầng** cho batch; quality `FloatValue×100→cvttss2si truncate`.
- Verified: 6/6 test trên 22 ảnh JXL thật + chạy qua barrel app (`nativelibs.zjxl()`) đủ 5 method.

> **Phát hiện quan trọng:** build 26.6.11 bật `--enable-features=JXL` → **Chromium tự giải mã JXL để hiển thị ảnh**; renderer ưu tiên `createImageBitmap`/canvas. `$zFeatures.libjxl.*` (zjxl) chỉ là **fallback** khi Chromium không làm được → trên Linux desktop **hiếm thao tác UI chạm zjxl**. Module vẫn đúng/parity macOS và chạy chính xác khi được gọi.

### `zimage` — thumbnail/resize (P1, **next**) — dựa trên libvips

- **API app gọi:** `thumbnail(input, w, h, …) → buf`, `resizeQA(…)`. Bundle mac: **`libvips-cpp.42.dylib` (version 59.2.0)** (từ version-tracker).
- **Hai hướng (chọn sau khi RE binary):**
  1. **RE native + libvips từ source** (giống zjxl): build libvips 59.2.0 pinned + reimplement N-API addon từ disasm `zimage` mac. Sát nhất, byte-identical-friendly, nhưng libvips kéo theo nhiều dep (glib, expat, …). Effort: High.
  2. **`sharp` (libvips)**: map `thumbnail`/`resizeQA` sang `sharp(input).resize(...).toBuffer()`. Nhanh, ít việc C, nhưng không byte-identical và phải khớp shape/format output. Effort: Low–Med.
- **Bước đầu:** disasm `app/native/nativelibs/zimage/build/darwin_x64/*.node` để lấy API surface chính xác + tham số resize/format; đối chiếu call-site renderer xem `thumbnail`/`resizeQA` được dùng ở đâu (và có bị Chromium/canvas giành như zjxl không).
- Effort: Med.

**Deliverable Phase 1 (còn lại):** `zimage.thumbnail`/`resizeQA` chạy trên Linux (nếu renderer thực sự gọi — cần xác minh call-site trước, tránh lặp lại tình huống zjxl bị Chromium giành).

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

### `v8-profiles` — **skip**
- 0 call-site, chỉ profiler nội bộ. Đã guard không crash. Không cần RE.

---

## Thứ tự đề xuất

1. ~~**P1 — zjxl**~~ ✅ **DONE** (native, byte-identical). **P1 còn lại — zimage**: bắt đầu bằng disasm binary `zimage` mac để lấy API surface + params, và **xác minh call-site renderer** (tránh lặp lại tình huống zjxl bị Chromium/canvas giành).
2. **P2 — mp4thumb** (video thumb, dễ với ffmpeg) → **zwalker** (GC, làm khi cache phình).
3. **P3 — file-utils / file-utilities** (thống kê dung lượng, dễ).
4. **P4 — zcall**: đánh giá khả thi riêng; mặc định để stub.

## Nguyên tắc chung khi RE mỗi module
- Giữ **đúng API surface** (tên hàm + shape trả về) mà `index.js`/renderer mong đợi — như đã làm với `zfile` (renderer tra `diskInfo` theo path → cần khớp shape).
- Thêm nhánh `linux` vào `index.js` của module (như patch-zfile/db-cross), fail-loud nếu pattern đổi.
- Verify bằng **dữ liệu thật** (ảnh JXL thật, video thật) + smoke boot, không chỉ unit test.
- Runtime deps mới (ffmpeg, libvips-jxl…) → thêm vào `.deb` `build.deb.depends` và CI apt list.
