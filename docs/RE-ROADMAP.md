# Roadmap — Reverse-engineering the remaining native modules (Linux)

Trạng thái hiện tại của `app/native/nativelibs/*`. **7 module đã port** (build/relink cho Linux); **4 module** còn lại chỉ có prebuilt darwin/win → hiện **guard/stub** (không crash) và cần RE để chạy thật trên Linux.

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
| **mp4thumb** | Thumbnail video | C++ node-addon-api + pinned FFmpeg 5.1 | ✅ **DONE (native, byte-identical by construction, linux/x64)** | `MP4Thumb.{generateThumbnail, generateThumbnailAsync, setOutputPath, cancel}` | — |
| **zwalker** | Quét/GC cache media | Rust (NAPI-RS) | ✅ **DONE (native Rust, reconstruction, linux/x64)** | `scanDirectory, deleteHomelessFiles, deleteEmptyFolders, statUnmarkedFiles, updateReferenceMessageId` | — |
| **file-utilities** | Dung lượng thư mục, hardlink, fs-type | Rust (NAPI-RS) | ✅ **DONE (native, byte-identical output, linux_x64)** | `getDirectorySize(Sync/Async), getDirectorySizeTree(Sync/Async), getDirectorySizeByGlob(Sync/Async), detectHardlinks(Sync/Async), detectFilesystem(Sync/Async), cancelJob` | — |
| **file-utils** | Disk usage (statvfs) | C++ (node-addon-api) | ✅ **DONE (native, byte-identical output, linux/x64)** | `getDiskUsage` | — |
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

### ✅ `mp4thumb` — thumbnail video — **DONE (native C++, byte-identical by construction)**
- **API (native):** class `MP4Thumb` với `generateThumbnail`(sync)/`generateThumbnailAsync`(Promise/AsyncWorker) + `setOutputPath` (ẩn) + `cancel` (atomic flag). Wrapper JS: `{generateThumbnail(in,out,w,h,mediaId), cancel(mediaId)}`.
- **RE bằng disassembly** (Capstone + Mach-O): pipeline `find_best_stream → decode first frame (no seek) → fit-inside-even resize → sws_scale(SWS_BICUBIC→YUV420P) → MJPEG encode (color_range=JPEG, q=3) → mjpeg muxer`. Hằng số + offset xem `nativelibs/mp4thumb/RE-PARAMS.md`.
- **Rebuild** C++ node-addon-api + **pin FFmpeg 5.1 (Lavc 59.37.100) build từ nguồn**, shared + bundle `.so` closure (RPATH=$ORIGIN, như zimage). Deploy `patch-mp4thumb.js`. Branch `re/mp4thumb`.
- **Caveat:** không có Mac oracle → byte-identity theo cấu trúc (pin đúng version + replicate chính xác), verify = JPEG hợp lệ + đúng dimensions + deterministic (2 lần chạy byte-identical).

### ✅ `zwalker` — quét & GC cache media (Rust NAPI-RS) — **DONE (native Rust, reconstruction, linux/x64)**
- **RE native đầy đủ** (không reimplement JS thuần): dựng lại crate Rust `napi-rs`
  (`nativelibs/zwalker/`) từ crate-layout + struct fields + dep-set lộ trên binary mac,
  và hợp đồng suy ra từ facade `$zFeatures.zwalker` + orchestrator `ResourceCleanupManager`.
  Chi tiết: `nativelibs/zwalker/RE-PARAMS.md`,
  `docs/superpowers/specs/2026-07-11-zwalker-re-design.md`.
- **Kiến trúc:** một **cây file toàn cục trong RAM** (behind `parking_lot::Mutex`, sống
  suốt vòng đời process `shared-worker`, không persist đĩa) — khớp panic-string mac
  ("Mutex is poisoned … from tree", "Error locking tree"). `scanDirectory` dựng cây;
  `updateReferenceMessageId` đánh dấu `reference_message_id` từng file; `statUnmarkedFiles`/
  `deleteHomelessFiles` đọc lại. "Homeless" = file không có message tham chiếu (ref id rỗng).
- **Đủ 5 export:** `scanDirectory, updateReferenceMessageId, statUnmarkedFiles,
  deleteHomelessFiles, deleteEmptyFolders`. Structs mac (`FileInfo` 5 fields, `NodeData`
  8 fields, `FolderBasicInfo` 2 fields) tái dựng chuẩn; return objects camelCase khớp
  facade (`fileNumber/size/trackingPath/trackingATime/failedFileNumber/failedSize/…`).
- **Deps pin đúng version binary:** `napi 2.16` (napi8), `ignore 0.4.25` (walk song song),
  `globset 0.4.18`, `rayon 1.11`, `serde_json 1.0.149`, `once_cell 1.21.3`,
  `parking_lot 0.12.5`, `same-file 1.0.6`. `Cargo.lock` gitignore.
- **Xoá THẬT** như mac (không dry-run): `deleteHomelessFiles(...,true)` unlink file homeless
  (trừ ignore-glob), `deleteEmptyFolders` xoá thư mục rỗng bottom-up. Test full-lifecycle
  trên fixture (`nativelibs/zwalker/__tests__/zwalker.test.js`): scan→mark→stat→delete
  chứng minh homeless bị xoá, file đã mark sống sót, ignore-glob bảo vệ.
- **Feature-flag `cleanup.enable` GIỮ default OFF** (VNG rollout) — addon sẵn sàng nhưng
  app **không tự chạy GC** cho tới khi VNG bật (an toàn, không tự xoá cache của user).
- Deploy `patch-zwalker.js` (drop `.node` vào slot `zwalker.linux-x64-gnu.node` của napi
  loader — không cần splice). Đã **tách khỏi `patch-linux-guards`** (addon tự sở hữu load).

---

## Phase 3 — Storage stats (P3, dễ)

### ✅ `file-utilities` — dir size / hardlink / fs-type (Rust) — **DONE (native, byte-identical output, linux_x64)**

Không đi hướng "reimplement JS thuần" như dự tính ban đầu — đã **RE native đầy đủ**
dựng lại crate Rust `napi-rs` từ string recovery trên binary macOS (branch
`re/file-utilities`, `docs/superpowers/specs/2026-07-10-file-utilities-re-design.md`,
`docs/superpowers/plans/2026-07-10-file-utilities-re.md`):
- Addon **Rust `napi-rs`** (`nativelibs/file-utilities/`), pin đúng version crate lấy từ
  string binary mac: `napi`/`napi-derive` 2.x (`napi8` feature — N-API 8, chạy được trên
  Electron 39 = N-API 10), `walkdir 2.5.0`, `same-file 1.0.6` (transitive qua walkdir),
  `lazy_static 1.5.0`, `globset 0.4`, `num_cpus`. `Cargo.lock` gitignore (pin version
  trong `Cargo.toml` bằng `=`).
- **Đủ 11 export** (không chỉ tập con app đang gọi): `getDirectorySize(Sync/Async)`,
  `getDirectorySizeTree(Sync/Async)`, `getDirectorySizeByGlob(Sync/Async)`,
  `detectHardlinks(Sync/Async)`, `detectFilesystem(Sync/Async)`, `cancelJob`. Không lộ
  `Task` struct nào ra JS surface (khớp binding mac — chỉ 11 hàm phẳng).
- **Byte-identical OUTPUT** (không phải byte-identical binary — Mach-O không chạy trên
  Linux, cùng caveat như zimage/zjxl): verify bằng oracle độc lập `du --apparent-size
  -sb`, `find -type f | wc -l`, `stat -c %h`, `stat -f -c %T` qua TDD
  (`nativelibs/file-utilities/__tests__/`). Semantics khoá qua TDD: `totalSize` = Σ
  `st_size` file thường; dedup hardlink theo `(dev, ino)` (không dùng
  `same_file::Handle` — tránh exhaust fd trên cây lớn); symlink bị loại; `fileCount` =
  số file thường theo inode duy nhất.
- `detectFilesystem` **tự author cho Linux** (statfs `f_type` magic → tên fs + bảng
  capability) — đúng cho Linux, **không** đối chiếu byte-cho-byte với mac (mac dùng
  APFS/HFS+ semantics khác hẳn).
- **Residual gaps** (đã ghi rõ trong `RE-PARAMS.md` §7, chờ máy mac nếu có): shape chính
  xác `HardlinkResult`/`DirectoryTreeResult`, rule dedup `fileCount`,
  `DirectoryTreeOptions.includeRoot` (nhận nhưng chưa dùng — luôn emit root),
  `literal_separator` chính xác mac dùng cho glob `*` (port hiện dùng default
  `globset` → `*` match qua `/`), hành vi `detectHardlinks` trên symlink gãy.
- Deploy: `scripts/patches/patch-file-utilities.js` (theo mẫu `patch-zjxl.js`) build
  `cargo build --release` → `linux_x64/file-utilities.node`, splice nhánh `linux` vào
  `getPlatformPath()`, verify ELF + `ldd` chỉ system lib.
- Test: `for t in smoke cancel directory-size hardlinks filesystem glob tree; do node
  __tests__/$t.test.js; done` — 7/7 pass, đối chiếu oracle coreutils.

### ✅ `file-utils` — disk usage — **DONE (native C++, byte-identical output)**
- Module **C++ node-addon-api** khác (không phải Rust `file-utilities` ở trên), expose
  **1 hàm sync** `getDiskUsage(path)` → `{available, free, total}` qua `statvfs`.
- **RE bằng disassembly** (Capstone + Mach-O parser tự viết): công thức
  `field * f_frsize` (available=f_bavail, free=f_bfree, total=f_blocks), thứ tự property
  `available, free, total`, và toàn bộ error strings — xem
  `nativelibs/file-utils/RE-PARAMS.md`.
- **Rebuild** C++ verbatim (`src/diskusage_posix.cc`, node-gyp + node-addon-api, C++
  exceptions ON) → byte-identical output, verify bằng C `statvfs` oracle. Deploy:
  `patch-file-utils.js` (build → splice nhánh linux → ELF/ldd gate). Branch `re/file-utils`.

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
2. ~~**P2 — file-utilities**~~ ✅ **DONE** (native Rust `napi-rs`, byte-identical output, branch `re/file-utilities`) · ~~**file-utils**~~ ✅ **DONE** (native C++ node-addon-api, byte-identical output, branch `re/file-utils`). · ~~**mp4thumb**~~ ✅ **DONE** (native C++ + pinned FFmpeg 5.1, byte-identical by construction, branch `re/mp4thumb`). Còn lại **zwalker** (GC, làm khi cache phình).
3. **P4 — zcall**: đánh giá khả thi riêng; mặc định để stub.
4. **v8-profiles**: đã build; xác minh logging/trigger (đang làm).

## Nguyên tắc chung khi RE mỗi module
- Giữ **đúng API surface** (tên hàm + shape trả về) mà `index.js`/renderer mong đợi — như đã làm với `zfile` (renderer tra `diskInfo` theo path → cần khớp shape).
- Thêm nhánh `linux` vào `index.js` của module (như patch-zfile/db-cross), fail-loud nếu pattern đổi.
- Verify bằng **dữ liệu thật** (ảnh JXL thật, video thật) + smoke boot, không chỉ unit test.
- Runtime deps mới (ffmpeg, libvips-jxl…) → thêm vào `.deb` `build.deb.depends` và CI apt list.
