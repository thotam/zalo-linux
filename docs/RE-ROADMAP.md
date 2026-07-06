# Roadmap — Reverse-engineering the remaining native modules (Linux)

Trạng thái hiện tại của `app/native/nativelibs/*`. **3 module đã port** (build/relink cho Linux); **8 module proprietary** còn lại chỉ có prebuilt darwin/win → hiện **guard/stub** (không crash) và cần RE để chạy thật trên Linux.

> "RE" ở đây = **reimplement JS API trên OSS lib tương đương** (không có source gốc để build). API surface nhỏ và đã biết chính xác (tên hàm + shape tham số lấy từ `index.js`), nên khả thi. Với module Rust (NAPI-RS) có thể reimplement JS hoặc dựng lại addon Rust.

---

## Bảng tổng quan

| Module | Chức năng | Bọc OSS | Linux hiện tại | API app gọi | Ưu tiên |
|---|---|---|---|---|---|
| **sqlite3** | DB SQLCipher | mapbox sqlite3 + SQLCipher | ✅ DONE (build) | — | — |
| **db-cross-v4** | Giải mã backup E2EE | clean-room C++ | ✅ DONE (build) | — | — |
| **zfile** | Disk info / file ops | glibc statvfs | ✅ DONE (build+wrapper) | — | — |
| **zjxl** | Codec **JPEG-XL** | libjxl+OpenCV+turbojpeg | ❌ `{error:'not support'}` | `decodeToJpeg, bitmapToJxl, jxlToRgb, resizeJxl` | **P1** |
| **zimage** | Thumbnail/resize | **libvips** (sharp) | ❌ `{error:NOT_SUPPORT}` | `thumbnail, resizeQA` | **P1** |
| **mp4thumb** | Thumbnail video | FFmpeg | ⚠️ stub (throw khi gọi) | `generateThumbnail(Async), cancel` | **P2** |
| **zwalker** | Quét/GC cache media | Rust (NAPI-RS) | ⚠️ stub no-op (guard) | `scanDirectory, deleteHomelessFiles, deleteEmptyFolders, statUnmarkedFiles, updateReferenceMessageId` | **P2** |
| **file-utilities** | Dung lượng thư mục, hardlink, fs-type | Rust (NAPI-RS) | ⚠️ barrel nuốt lỗi → `{}` | `getDirectorySize(Sync/Async/ByGlob), detectHardlinks*, detectFilesystem*` | **P3** |
| **file-utils** | Disk usage (statvfs) | glibc | ❌ `{error:'not support'}` | `getDiskUsage` | **P3 (trivial)** |
| **zcall** | Engine gọi thoại/video | WebRTC (Opus/AAC/H264) proprietary | ⚠️ `{error:'not support'}` | `bindCanvas, render, startRender, getActiveAudioCodecs, holdAudio, …` (~30) | **P4 (out-of-scope)** |
| **v8-profiles** | CPU profiler | v8-profiler | ⚠️ stub (0 call-site) | — | **Skip** |

---

## Phase 1 — Hiển thị ảnh (P1) · **ưu tiên cao nhất, UX rõ nhất**

Zalo lưu ảnh dạng **JPEG-XL**. Không có `zjxl` → ảnh trong chat **không hiển thị** (decode fail). `zjxl` + `zimage` cùng dựa trên **libvips/libjxl** → làm chung một build.

### Hạ tầng chung: `sharp` (libvips) có hỗ trợ JXL
- **Rào cản cần xác minh trước:** prebuilt `sharp`/libvips **mặc định KHÔNG bật JXL** (lý do license/size). Ba lựa chọn, xác minh thực tế rồi chọn:
  1. **Custom libvips + libjxl** rồi `sharp` link vào (`SHARP_FORCE_GLOBAL_LIBVIPS=1` với libvips hệ thống build kèm `--with-jxl`). Sát bản gốc nhất, nhanh nhất lúc chạy. Effort: Med.
  2. **`@jsquash/jxl`** (WASM, thuần JS) cho decode/encode JXL; `sharp` (bản thường) cho resize/thumbnail. Đơn giản, không cần build C, nhưng chậm hơn & tăng CPU. Effort: Low–Med.
  3. **Build wrapper N-API quanh libjxl** (giống bản gốc). Sát nhất nhưng nặng nhất. Effort: High.
- **Khuyến nghị:** thử (2) để có bản chạy nhanh, đo hiệu năng ảnh; nếu chậm chuyển (1).

### `zjxl` — codec JPEG-XL (P1, load-bearing)
- **API cần reimplement:** `decodeToJpeg(jxlBuf) → jpegBuf` (hiển thị), `bitmapToJxl(bitmap, quality, opts) → jxlBuf` (gửi ảnh), `jxlToRgb`, `resizeJxl`.
- **Map sang OSS:** `decodeToJpeg` = JXL→raw→JPEG (`@jsquash/jxl` decode + `sharp().jpeg()`); `bitmapToJxl` = raw→JXL (`sharp().jxl()` hoặc `@jsquash/jxl` encode); `resizeJxl` = decode→`sharp().resize()`→encode.
- **Rủi ro:** khớp tham số chất lượng/effort của Zalo (ảnh gửi đi phải để đầu kia đọc được). Verify round-trip với ảnh JXL thật lấy từ tài khoản.

### `zimage` — thumbnail/resize (P1)
- **API:** `thumbnail(input, w, h, …) → buf`, `resizeQA(…)`.
- **Map:** `sharp(input).resize(w,h,{fit}).toBuffer()`; `thumbnail` dùng `sharp().resize()` + `.jpeg()/.webp()`.
- Effort: Low–Med (chia sẻ build với zjxl).

**Deliverable Phase 1:** ảnh trong chat hiển thị + gửi ảnh được. Verify: mở 1 chat có ảnh JXL → hiện; gửi 1 ảnh → đầu kia xem được.

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

1. **P1 — zjxl + zimage** (ảnh hiển thị/gửi) — thay đổi lớn nhất về trải nghiệm. Bắt đầu bằng spike: xác minh đường JXL (@jsquash vs custom libvips) trên 1 ảnh thật.
2. **P2 — mp4thumb** (video thumb, dễ với ffmpeg) → **zwalker** (GC, làm khi cache phình).
3. **P3 — file-utils / file-utilities** (thống kê dung lượng, dễ).
4. **P4 — zcall**: đánh giá khả thi riêng; mặc định để stub.

## Nguyên tắc chung khi RE mỗi module
- Giữ **đúng API surface** (tên hàm + shape trả về) mà `index.js`/renderer mong đợi — như đã làm với `zfile` (renderer tra `diskInfo` theo path → cần khớp shape).
- Thêm nhánh `linux` vào `index.js` của module (như patch-zfile/db-cross), fail-loud nếu pattern đổi.
- Verify bằng **dữ liệu thật** (ảnh JXL thật, video thật) + smoke boot, không chỉ unit test.
- Runtime deps mới (ffmpeg, libvips-jxl…) → thêm vào `.deb` `build.deb.depends` và CI apt list.
