# Porting Guide — Zalo for Linux (.deb)

Dành cho maintainer muốn **re-port một phiên bản Zalo mới** sang Linux. Mô tả *đúng*
những gì repo đang build. Đọc kèm `README.md` và design spec trong
`docs/superpowers/specs/`.

**Nguyên tắc**: không viết lại Zalo. Lấy nguyên bundle JS (`app.asar`) từ **bộ cài
macOS DMG**, patch tối thiểu, và build lại native module cho **Linux x64** từ source.
JS trong `app.asar` là arch-neutral; chỉ các file `.node` cần build mới.

---

## 1. Nguồn & cách lấy bộ cài (macOS DMG)

Bộ cài mới nhất resolve qua một redirect (bắt buộc User-Agent **macOS**):

    GET https://zalo.me/download/zalo-pc?utm=90000   (UA macOS)
    -> HTTP 302  Location: https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-<ver>.dmg

- Version parse từ `Location` bằng regex `ZaloSetup-universal-([0-9.]+)\.dmg`.
- `assertValidVersion(/^[0-9.]+$/)` chống shell-injection.
- Logic ở `scripts/download-installer.js`. Ép version: `ZALO_VERSION=<ver>`; dùng DMG
  có sẵn: `ZALO_DMG=<file.dmg>` (bỏ qua download).

Layout DMG: `Zalo*/Zalo.app/Contents/Resources/app.asar` (+ `app.asar.unpacked/`).

## 2. Extraction (`scripts/extract-installer.js`)

Cần `7z` (`p7zip-full`). Thứ tự:
1. `7z x` tách `app.asar` + `app.asar.unpacked/*` từ DMG.
2. `@electron/asar` `extractAll(app.asar -> app/)`.
3. **Overlay `app.asar.unpacked/*` lên `app/`** (`overwrite:true`) — BẮT BUỘC: loader
   native thật chỉ nằm trong `.unpacked`; bản trong `app.asar` là stub rỗng.
4. Rename `app/package.json` -> `app/package.json.bak` (giữ để lấy version).

`app/` **không commit** (gitignore).

## 3. Sáu patch (`scripts/patches/`), chạy theo thứ tự cố định

Orchestrator `scripts/main.js` chạy: **platform-id → renderer-win32 → sqlite3 →
db-cross-v4 → zfile → linux-guards**. Patch critical **throw** khi pattern không khớp
(fail loud) — không âm thầm ship bản hỏng.

1. **patch-platform-id** — `app/main-dist/main.js` (+`compact-app.js`):
   `case "LINUX": return 25` -> `24`. Client-type 24 = WIN32 → server bật **đồng bộ
   lịch sử E2EE**.
2. **patch-renderer-win32** — `app/pc-dist/**.js`: `platform:"DARWIN"` -> `"WIN32"`;
   `getClientType(){return 23}` -> `24`. Renderer vẽ titlebar **win32 gốc**
   (min/max/close) trên cửa sổ frameless. KHÔNG đổi `frame:false`->`true`; KHÔNG dùng
   `titleBarOverlay`.
3. **patch-sqlite3** — build mapbox sqlite3 **có SQLCipher** từ source, đặt `.node` vào
   `app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node`. Verify
   `PRAGMA cipher_version` trả về giá trị (không chỉ check ELF).
4. **patch-db-cross-v4** — build `.node` (AES-256-CBC + XZ, clean-room), đặt vào
   `.../db-cross-v4/prebuilt/linux/electron/x64/db-cross-v4-native.node` + splice nhánh
   `process.platform === 'linux'` vào `dist/binding.js` (regex fail-loud).
5. **patch-zfile** — build `.node` + splice nhánh linux vào `index.js` (parity; 0
   call-site trong bundle này nhưng build theo yêu cầu "all nativelibs from cc").
6. **patch-linux-guards** — short-circuit `checkAppSigned()` (spawn `codesign` của
   macOS) trên Linux; bọc loader `zwalker`/`mp4thumb`/`v8-profiles` để binary vắng mặt
   không throw.

## 4. Native builds (`nativelibs/`)

Electron pin **22.3.27** (ABI N-API v6, khớp Electron 22.3.9 mà Zalo bundle). Build qua
`nativelibs/builder.js`:

    npx node-gyp rebuild --target=<electron-ver> --arch=x64 \
      --dist-url=https://electronjs.org/headers

- **Không** tải prebuilt, **không** commit `.node` (gitignore). **Mỗi SETUP rebuild từ
  source.**
- Chỉ 3 module có source: `sqlite3` (SQLCipher), `db-cross-v4`, `zfile`.
- 8 module proprietary còn lại (`zwalker`, `zimage`, `zjxl`, `mp4thumb`, `zcall`, …)
  giữ guard/stub — ngoài scope v1.

System deps:

    sudo apt-get install -y p7zip-full build-essential libssl-dev liblzma-dev \
      libsqlcipher-dev dpkg fakeroot

## 5. Dev vs Deploy

**Dev** (không download):

    ZALO_DMG=<file.dmg> npm run setup   # extract + 6 patch + build native
    ./run-dev.sh                        # electron . --no-sandbox
    scripts/_smoke-boot.sh              # headless: cửa sổ tạo được, không throw import

**Deploy** (CI — `.github/workflows/build.yml`):
- **Push git tag** (`on: push: tags`) → build **và tạo GitHub Release** kèm `.deb`
  (step Release gate `if: startsWith(github.ref,'refs/tags/')`).
- **`workflow_dispatch`** (input `zalo_version` tùy chọn) → build + upload artifact,
  **KHÔNG** Release.

`.deb` metadata trong `package.json` (`maintainer`, `productName:"Zalo"`,
`appId:"com.zalo.linux"`); tên artifact `Zalo-<ver>.deb` (version từ
`package.json.bak`). `.desktop` có `Icon=` (favicon-512x512) và
`MimeType=x-scheme-handler/zalo;` (deep link `zalo://` qua argv).

## 6. Checklist: Bump lên phiên bản Zalo mới

1. Chạy pipeline cho version mới:

       ZALO_VERSION=<new-ver> npm run main     # download + extract + 6 patch + build .deb
       # hoặc, DMG có sẵn (không build .deb):
       ZALO_DMG=<file.dmg> npm run setup

2. **Đọc log patch.** Patch critical **throw** nếu pattern minified dịch chuyển
   ("pattern not found / no longer matches"). Re-locate trong `app/` rồi cập nhật chuỗi
   trong `scripts/patches/*.js`:
   - platform-id → `case"LINUX":return <n>` trong `app/main-dist/main.js`.
   - renderer-win32 → `platform:"DARWIN"` / `getClientType(){return 23}` trong
     `app/pc-dist/**.js` (xác nhận **số lần thay** khớp).
   - db-cross-v4 → chỗ splice trong `dist/binding.js`.
3. **Smoke boot**: `scripts/_smoke-boot.sh` phải in `SMOKE_OK` (cửa sổ tạo được,
   sqlite3 + db-cross load không throw). Rồi verify thủ công với tài khoản thật: login
   QR → **đồng bộ lịch sử E2EE** → gửi/nhận text → nút min/max/close + kéo cửa sổ → DB
   local đúng là SQLCipher-encrypted.
4. **Verify docs khớp code:**

       grep -q 'napi-v6-linux-x64' docs/PORTING-GUIDE.md \
         && grep -q 'return .24' docs/PORTING-GUIDE.md && echo "doc OK"

5. **Release:** commit (nếu có sửa patch), rồi push git tag:

       git tag <new-ver> && git push origin <new-ver>

   CI build + tạo GitHub Release kèm `Zalo-<ver>.deb`.

## Ghi công

- db-cross-v4 reverse engineering: **realdtn2**.
- Zalo là thương hiệu của VNG Corporation. Dự án không liên kết/được bảo trợ bởi VNG.
