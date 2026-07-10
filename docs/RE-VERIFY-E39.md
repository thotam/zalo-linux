# Verify RE native libs chạy thật trong app trên Electron 39

> Branch: **`verify-native-libs-e39`** — giữ lại lâu dài để verify các RE lib (hiện tại + tương lai) có thực sự được app **gọi** và chạy đúng ở runtime, không chỉ "load được `.node`".

Sau khi nâng E22 → E39 (Chromium 108 → 142), Chromium **gỡ JPEG-XL** (chỉ khôi phục ở 145) nên buộc app đi đường native (`patch-native-image-flags` ép các feature-flag = ON). Cần bằng chứng **runtime** rằng đường native thật sự chạy → branch này thêm instrumentation log.

---

## Cơ chế

Mọi native lib đều đi qua **một** entry duy nhất: bundle `require("../native/nativelibs")` rồi gọi `nativelibs.zjxl()`, `nativelibs.zimage()`, `nativelibs.dbUtils()`, … Nên chỉ cần bọc **aggregator** `app/native/nativelibs/index.js` là phủ hết.

- **`scripts/patches/data/zinstrument.js`** — shim runtime. Bọc đệ quy mọi hàm của lib: log `CALL / RET / RESOLVE / REJECT / THROW / NEW` kèm summary args, duration, byte-size. Ghi ra **file** (Zalo override `console`), có sampling chống flood (4 call đầu đầy đủ, sau đó 1/50), **fail-open** (mọi lỗi trong shim → trả lib gốc, không bao giờ làm hỏng app).
- **`scripts/patches/patch-native-lib-logging.js`** — copy shim vào cạnh aggregator + bọc từng accessor trên `instance` (memoized per-name để giữ identity). Idempotent, fail-loud khi aggregator đổi shape.

**An toàn DB hot path:** shim chỉ bọc **own-enumerable props**. Method của native class (sqlite3 `Database.run/get/all`) nằm trên **prototype** → không bị đụng; chỉ log `NEW Database`. Query không bị wrap.

Patch chạy **cuối** pipeline trong `scripts/main.js` (sau `patch-native-image-flags`).

## Cách chạy

```bash
npm run setup        # (nếu extract lại) — patch tự chèn instrumentation
npm start            # electron . --no-sandbox, app đã instrument
# ... thao tác thật trong app ...
cat ~/zalo-native-libs.log
```

Đổi đường dẫn log: `ZALO_NATIVE_LOG=/path/to.log npm start`. Mỗi process (main `browser`, `renderer`, `utility`) tự gắn tag `role:pid`; header ghi electron/chrome/node version.

## Kết quả verify (2026-07-10, E39.8.10 / Chromium 142.0.7444.265)

| Lib | Trạng thái runtime | Bằng chứng |
|---|---|---|
| **zjxl** | ✅ chạy thật | `jxlDecompressMulti` gọi liên tục (localPath thật) → `status_code:1` = SUCCESS. **Đây là đường hiển thị ảnh JXL nhận về** (batch, trong process `utility`) — app dùng `jxlDecompressMulti`, **không** phải `decodeToJpeg` |
| **zimage** | ✅ chạy thật | `Image.thumbnail(buf 188–729KB, w, h, "webp", 0.9)` → 2.8–13KB, ~10–15ms/ảnh |
| **sqlite3** | ✅ chạy nặng | `new Database` 400+ lần trong `utility` (mỗi hội thoại/thread 1 file DB, path str(59–107), flags 786438) + renderer |
| **db-cross-v4 (dbUtils)** | 🟡 load OK, chưa bị gọi | `LOAD` thấy 3 hàm E2EE thật: `decompressAndDecryptDb`, `decompressAndDecryptDb_V2`, `parseBinNet` — chưa có `CALL` trong phiên test |
| **v8-profiles** | ⬜ app không dùng | Không hề `LOAD` (grep bundle = 0). Build được nhưng app không gọi |
| **zfile** | ⬜ chưa kích hoạt | Không log — phiên không gửi/nhận file |
| **file-utils** | ⚠️ native không hỗ trợ Linux | `LOAD → {error:"not support"}` — app fallback, không crash |
| **file-utilities** | ⚠️ trả rỗng trên Linux | `LOAD → {}` (wrapper nuốt lỗi require) |
| **zcall / zwalker / mp4thumb** | ⬜ chưa kích hoạt | Không gọi call/video/quét cache trong phiên |

**Kết luận:** 3 lib quan trọng nhất cho mục tiêu upgrade — **zjxl, zimage, sqlite3 — đã xác nhận chạy thật** trên E39. Xem thêm bảng tổng quan RE ở [RE-ROADMAP.md](RE-ROADMAP.md).

## Ghi chú

- **`status_code` khác convention mỗi hàm:** `jxlDecompressMulti` dùng **1 = SUCCESS** (`nativelibs/zjxl/__tests__/multi.test.js`), còn `decodeToJpeg`/`getJxlInfo` dùng **0 = SUCCESS**. Cả hai trong log đều là thành công.
- **sqlite3 mở 400+ DB/~66s:** Zalo mở file DB riêng cho từng hội thoại/thread (path khác nhau) — hành vi của Zalo, không phải leak của port.
- **file-utils / file-utilities chưa có bản Linux** → ứng viên RE tiếp theo (P2/P3 trong roadmap; file-utilities chặn màn hình Storage).

## Verify lib còn lại — thao tác cần làm

| Muốn thấy lib | Thao tác trong app |
|---|---|
| `zfile` (`stat/copyFolder/getChecksum`) | Gửi hoặc nhận 1 **file** (không phải ảnh) |
| `db-cross-v4` (`decompressAndDecryptDb`) | Mở hội thoại có backup **E2EE** mã hoá |
| `mp4thumb` | Nhận/xem 1 **video** (khi RE xong — hiện stub) |
| `zwalker` | Trigger dọn/GC cache media (khi RE xong) |
| `zcall` | Gọi thoại/video (out-of-scope, hiện stub) |

Chạy thao tác → `cat ~/zalo-native-libs.log` → cập nhật bảng trên.
