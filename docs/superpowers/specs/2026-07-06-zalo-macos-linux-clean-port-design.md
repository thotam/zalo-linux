# Zalo for Linux — Clean re-port từ macOS DMG (Design)

- **Ngày**: 2026-07-06
- **Trạng thái**: Approved design → sẵn sàng viết implementation plan
- **Nguồn**: `ZaloSetup-universal-26.6.11.dmg` (chỉ macOS DMG, không dùng nguồn Windows)
- **Tiền thân**: `/mnt/data/Work/Zalo/Zalo-linux` (bản cũ, dùng làm tham chiếu — port lại sạch, không kế thừa git history)

> Zalo là thương hiệu của VNG Corporation. Dự án không liên kết/được bảo trợ bởi VNG. Chỉ repackage bundle gốc + patch tối thiểu + build lại native module từ source cho Linux.

---

## 1. Mục tiêu & phạm vi

**Mục tiêu v1**: Làm lại đúng những gì bản cũ đã đạt được — **boot → login → đồng bộ lịch sử E2EE → gửi/nhận tin nhắn text → đóng gói `.deb`** — nhưng **sạch, tối thiểu, đúng như native**. Đóng gói `.deb`, kiến trúc **x64**, repo mới lịch sử git đơn tại `/mnt/data/Work/zalo-linux`.

**Nâng cấp so với bản cũ (để "như native")**:
- Kho DB local **mã hóa SQLCipher** như client thật (bản cũ dùng sqlite3 vanilla → DB local **plaintext**).
- Titlebar dùng **component win32 gốc của Zalo** (bản cũ chèn titlebar tự vẽ qua `console.log` — fragile).
- Bỏ toàn bộ rác: patch thử nghiệm titlebar, code nguồn-Windows, docs cũ, nhánh git rối.

**Non-goals v1** (fast-follow, xem §11):
- Hiển thị ảnh JPEG-XL (`zimage`/`zjxl`), video thumbnail (`mp4thumb`), dọn cache (`zwalker` bản đầy đủ).
- Tray, auto-update, AppImage/Flatpak, arm64, gọi thoại/video (`zcall`).

---

## 2. Sự thật về nguồn (đã verify từ bundle 26.6.11)

- **Electron runtime**: `22.3.9` → ABI native = **N-API v6**. Shell Electron pin `22.3.x`.
- **App version**: `26.6.11`; Zalo internal client build `686`.
- Entry: `bootstrap.js` (`package.json main`) → `main-dist/migration.js` (đã có sẵn nhánh XDG/Linux) → `main-dist/main.js`. `main.js` đăng ký `app.on('ready')` ở top-level ⇒ **phải `require` đồng bộ, không đặt trong `whenReady()`**.
- Renderer: React SPA trong `pc-dist/` (bundle macOS: `isMacOS()→true`, `getClientType()→23`, `platform:"DARWIN"` baked-in).
- **Client type** (`getClientType()`): `DARWIN=23, WIN32=24, LINUX=25`. Các nhánh platform trong app gate bằng client-type này, **không** bằng `process.platform`.
- **Cửa sổ**: tất cả **frameless** (`frame:false` + `titleBarStyle:"hidden"`). Không có `trafficLightPosition`/`vibrancy`/`titleBarOverlay`. Renderer tự vẽ titlebar; nút min/max/close chỉ render ở nhánh `.win32`, **không có nhánh Linux** → trên Linux (nghĩ mình là macOS) cửa sổ **không có nút điều khiển**.
- **DB local = SQLCipher**: bundle chạy `PRAGMA key='<key>'`; chỉ `win32` thêm `PRAGMA cipher_compatibility = 3`, còn macOS **và Linux** dùng mặc định **SQLCipher 4**.
- `migration.js` đã tính path theo XDG (`~/.local/share`, `~/.config`, `~/.cache`, `~/.local/state`), `appFolder="ZaloData"`.
- Không có code TCC camera/mic của macOS (`systemPreferences`/`getMediaAccessStatus` = 0) → không phải port.

---

## 3. Kiến trúc

Dự án là **build harness bọc quanh bundle Zalo nguyên gốc** — không viết lại Zalo. Bundle giải nén nằm ở `app/` (gitignore, không commit).

```
zalo-linux/                          # repo mới, /mnt/data/Work/zalo-linux
├── main.js                          # Electron shell entry: require app/bootstrap.js ĐỒNG BỘ
├── package.json                     # deps shell + cấu hình electron-builder .deb
├── run-dev.sh                       # electron . --no-sandbox
├── README.md
├── .gitignore                       # app/ dist/ node_modules/ *.node temp/ *.dmg
├── scripts/
│   ├── main.js                      # orchestrator (pha SETUP / BUILD)
│   ├── download-installer.js        # tải DMG (UA macOS) + validate version
│   ├── extract-installer.js         # 7z DMG → asar.extractAll → app/ → overlay .unpacked
│   ├── build.js                     # electron-builder --linux deb
│   ├── utils/logger.js
│   └── patches/
│       ├── patch-platform-id.js     # main: case "LINUX": return 25 → 24
│       ├── patch-renderer-win32.js  # renderer: DARWIN→WIN32 + getClientType 23→24
│       ├── patch-sqlite3.js         # build SQLCipher + đặt .node vào napi-v6-linux-x64
│       ├── patch-db-cross-v4.js     # build .node + chèn nhánh linux vào dist/binding.js
│       ├── patch-zfile.js           # build .node + chèn nhánh linux vào index.js
│       └── patch-linux-guards.js    # guard codesign()/zwalker/mp4thumb/v8-profiles
├── nativelibs/
│   ├── builder.js                   # node-gyp rebuild theo Electron headers
│   ├── db-cross-v4/{binding.gyp, package.json, src/main.cc}
│   └── zfile/{binding.gyp, package.json, src/zfile.cc, zfile-linux.js}
├── docs/
│   ├── superpowers/specs/…          # tài liệu này
│   ├── superpowers/plans/…          # implementation plan (bước sau)
│   └── PORTING-GUIDE.md             # viết lại sạch
├── .github/workflows/build.yml      # CI: build native + .deb, release chỉ khi push tag
└── app/                             # bundle Zalo giải nén (gitignore)
```

**Nguyên tắc thiết kế mã**: mỗi patch/script một trách nhiệm rõ ràng, giao tiếp qua interface đơn giản (đọc `app/…`, ghi `app/…`), verify hậu-điều-kiện. Patch critical **throw** khi không khớp pattern (fail loud khi Zalo bump version) — không âm thầm ship bản hỏng.

---

## 4. Pipeline

### SETUP (`SETUP=true node scripts/main.js`, hoặc `npm run setup`)
1. **Download** (nếu không có `ZALO_DMG=<file>`): `download-installer.js` — UA macOS → `zalo.me/download/zalo-pc` → 302 → `res-download-pc.zadn.vn/mac/ZaloSetup-universal-${ver}.dmg`. `assertValidVersion(/^[0-9.]+$/)` chống shell-injection.
2. **Extract** (`extract-installer.js`):
   - `7z` tách `Zalo*/Zalo.app/Contents/Resources/app.asar` + `app.asar.unpacked` từ DMG.
   - `@electron/asar` `extractAll` app.asar → `app/`.
   - **Overlay `app.asar.unpacked` đè lên `app/` (ghi đè)** — bước bắt buộc, không hiển nhiên: loader native thật chỉ nằm trong `.unpacked`; bản trong `app.asar` là stub rỗng.
   - Rename `app/package.json` → `app/package.json.bak` (giữ để lấy version).
3. **Patch**: chạy tuần tự 6 patch (§5).
4. **Build native** (trong các patch): rebuild 3 module từ source (§6), đặt `.node` đúng slot, verify.

### DEV (`run-dev.sh`)
`npx electron . --no-sandbox` → `main.js` → `require(app/bootstrap.js)` đồng bộ.

### BUILD (`BUILD=true node scripts/main.js`, hoặc `npm run build`)
`build.js` → `electron-builder --linux deb` (`extraMetadata.version` lấy từ `package.json.bak`), artifact `Zalo-<ver>.deb`. `.node` để `asarUnpack`. Sinh `.desktop` có `Icon=` + `MimeType=x-scheme-handler/zalo;`.

---

## 5. Patches (tối thiểu, phẫu thuật)

| Patch | File đích | Thay đổi | Vì sao |
|---|---|---|---|
| **platform-id** | `app/main-dist/main.js` (và `compact-app.js`) | `case "LINUX": return 25` → `24` | Server chỉ bật đồng bộ lịch sử E2EE cho client-type 24; đồng nhất logic cửa sổ/phím tắt |
| **renderer-win32** | `app/pc-dist/**.js` | `platform:"DARWIN"` → `"WIN32"`; `getClientType(){return 23}` → `24` | Renderer vẽ titlebar `.win32` gốc (min/max/close) trên cửa sổ frameless. Plumbing nút→IPC→BrowserWindow không đổi. **KHÔNG** đổi `frame:false`→`true` (sẽ bị 2 titlebar); **KHÔNG** dùng `titleBarOverlay` (không render trên Electron 22.3/GNOME) |
| **sqlite3** | build + `app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node` | Build từ source **có SQLCipher**, đặt `.node` (path resolve động, không cần patch JS) | Mở được DB mã hóa SQLCipher như client thật |
| **db-cross-v4** | build + `…/db-cross-v4/prebuilt/linux/electron/x64/db-cross-v4-native.node` + `dist/binding.js` | Build `.node`; chèn nhánh `process.platform === 'linux'` vào `binding.js` | Shared-worker gọi `dbUtils()` lúc import; throw ở đây → chết toàn bộ messaging |
| **zfile** | build + `…/zfile/linux/zfile-native.node` + `zfile-linux.js` + `index.js` | Build `.node`; chèn nhánh linux + wrapper Proxy resolve disk info theo absolute path | Parity với bản cũ (0 call-site nhưng build từ source theo yêu cầu) |
| **linux-guards** | `app/main-dist/main.js` + `app/native/nativelibs/{zwalker,mp4thumb,v8-profiles}/index.js` | main.js: short-circuit `checkAppSigned()` trên Linux. Loader: bọc require trong nhánh linux/try-catch để binary vắng mặt không throw | `checkAppSigned` spawn `codesign` của macOS (fail trên Linux); `zwalker` throw lúc load nếu thiếu binary, `mp4thumb`/`v8-profiles` throw khi gọi |

Các nhánh khác của Zalo trên Linux đã đúng sẵn (badge `setBadgeCount`, notifications, XDG paths, `window-all-closed` quit) — không cần patch.

---

## 6. Native modules — build từ source (không prebuilt, không commit `.node`)

**Nguyên tắc**: không tải prebuilt, không commit `.node`. **Mỗi lần SETUP đều rebuild toàn bộ từ source, không cache.** Build qua `nativelibs/builder.js`:
```
npx node-gyp rebuild --target=<ELECTRON_VERSION> --arch=x64 --dist-url=https://electronjs.org/headers
```

**Chỉ 3 module có source để build** (đúng bằng những gì bản cũ thực sự build):

### 6.1 sqlite3 (Critical) — **có SQLCipher**
- Package: mapbox `sqlite3` (C amalgamation), build từ source link SQLCipher.
- Cách build (verify empirically khi implement — có vài chỗ finicky về include path):
  - Primary: `apt install libsqlcipher-dev` rồi build mapbox sqlite3 với `--build-from-source --sqlite_libname=sqlcipher --sqlite=/usr` + Electron target/headers.
  - Fallback: `@journeyapps/sqlcipher` (fork bundle SQLCipher, cùng API mapbox, ép `--build-from-source`).
- Kết quả: `node_sqlite3.node` napi-v6, codec bật (`SQLITE_HAS_CODEC`) → đặt vào `binding/napi-v6-linux-x64/`.
- **Verify**: mở DB test, `PRAGMA key='x'` + `PRAGMA cipher_version` trả về giá trị (không chỉ check ELF).

### 6.2 db-cross-v4 (Critical) — C++ clean-room
- Source: vendor `nativelibs/db-cross-v4/{binding.gyp, src/main.cc}` từ bản cũ (credit realdtn2). `binding.gyp`: `-llzma -lcrypto`, C++17, `NAPI_DISABLE_CPP_EXCEPTIONS`, include `node-addon-api`.
- Sự thật RE (đã comment trong `main.cc`): AES-256-CBC, key = 32 ký tự ASCII đầu của `privateKey.toUpperCase()` dùng trực tiếp làm bytes (không hex-decode); IV=0 reset mỗi 64KB; magic `"ZDB4.0"`; stream XZ (liblzma); `progress_cb` gọi 1 lần/file không tham số.
- `dist/binding.js`: chèn nhánh linux (regex trong `patch-db-cross-v4.js`, fail-loud nếu không khớp).

### 6.3 zfile (Optional — build cho parity)
- Source: vendor `nativelibs/zfile/{binding.gyp, src/zfile.cc, zfile-linux.js}` từ bản cũ (`getmntent_r`+`statvfs`).
- 0 call-site trong bundle này (mac stub nó) nhưng build từ source theo yêu cầu "tất cả nativelibs từ cc".

### 6.4 System deps (CI + local)
```
build-essential libssl-dev liblzma-dev libsqlcipher-dev  (+ p7zip-full dpkg fakeroot cho packaging)
```

### 6.5 8 module KHÔNG có source (giữ guard/stub như bản cũ)
`zwalker`, `zimage`, `zjxl`, `mp4thumb`, `file-utilities`, `file-utils`, `zcall`, `v8-profiles` — proprietary prebuilt-only (Mach-O/Rust/WebRTC), **không tồn tại source wrapper để build từ cc**. Hầu hết loader đã degrade an toàn (`{error}`/`{}`/stub); riêng `zwalker`/`mp4thumb`/`v8-profiles` throw khi gọi → `patch-linux-guards.js` bọc lại. Muốn chúng chạy thật = reimplement JS API trên OSS mới build (libvips/libjxl/ffmpeg/Rust) → scope riêng, ngoài v1.

---

## 7. Platform fixes ngoài native (nhỏ, cho sạch/không crash)

- `checkAppSigned()` (spawn macOS `codesign`) → short-circuit trên Linux (trong `patch-linux-guards.js`). Hệ quả: `isAppSigned=false` → key lưu qua `safeStorage`/libsecret nếu có, không có keyring thì lưu thô (chấp nhận cho v1).
- `.desktop`: `Icon=` từ `pc-dist/favicon-512x512.png` (không cửa sổ nào set `icon:`); `MimeType=x-scheme-handler/zalo;` (deep link `zalo://` tới qua argv → `receiveArguments()`, không qua `open-url`).
- Auto-launch: nếu bật autostart, set `e.path=process.execPath` (bản Linux để trống path). Optional cho v1.
- Metadata sạch: `package.json` `name`, `description` (nguồn macOS), `appId`, `maintainer` đúng.

---

## 8. Packaging (`.deb`, x64)

`electron-builder` config trong `package.json` (tham chiếu bản cũ):
- `files: ["main.js","package.json"]`, `extraFiles: [{from:"app", to:"app", filter:["**/*","!node_modules","!package.json.bak"]}]`.
- `asarUnpack: ["**/*.node"]`, `buildDependenciesFromSource:false`, `nodeGypRebuild:false`, `npmRebuild:false`.
- `linux: { target:"deb", category:"Network", icon:"app/pc-dist/favicon-512x512.png", … }`.
- Artifact: `Zalo-<ver>.deb`, version lấy từ `app/package.json.bak`.

---

## 9. Testing / verification

- **Assert lúc build**: mỗi patch verify hậu-điều-kiện — `db-cross` load lại được + probe; `zfile` `diskInfo()` probe path qua Proxy; sqlite3 mở DB + `PRAGMA cipher_version`; kiểm tra `.node` là ELF + tồn tại đúng slot.
- **Smoke boot** (xvfb/headless): app không throw lúc import (sqlite3 + db-cross load), cửa sổ tạo được.
- **Verify runtime thủ công** (cần tài khoản Zalo thật): login QR → xác nhận đồng bộ lịch sử E2EE → gửi/nhận text → nút min/max/close + kéo cửa sổ hoạt động → DB local đúng là SQLCipher-encrypted.
- **CI** (`build.yml`): cài system deps → SETUP (extract + patch + build native) → BUILD `.deb` → **release chỉ khi push git tag** (`on: push: tags`, step release gated `if: startsWith(github.ref,'refs/tags/')`). `workflow_dispatch` chỉ build + upload artifact.

---

## 10. Tái sử dụng từ bản cũ (KEEP — copy, dọn sạch)

| Artifact bản cũ | Xử lý |
|---|---|
| `scripts/extract-installer.js` (DMG + overlay) | KEEP gần như nguyên |
| `scripts/download-installer.js` (mac DMG UA) | KEEP |
| `scripts/build.js`, `scripts/utils/logger.js` | KEEP |
| `scripts/main.js` orchestrator (SETUP/BUILD) | KEEP, cập nhật danh sách patch |
| `nativelibs/builder.js` | KEEP |
| `nativelibs/db-cross-v4/{binding.gyp, src/main.cc, package.json}` | KEEP (crown jewel) |
| `nativelibs/zfile/{binding.gyp, src/zfile.cc, zfile-linux.js, package.json}` | KEEP |
| `scripts/patches/patch-platform-id.js` | KEEP |
| `scripts/patches/patch-db-cross-v4.js`, `patch-zfile.js` (build + regex splice, fail-loud) | KEEP |
| `.github/workflows/build.yml` | KEEP, thêm `libsqlcipher-dev` |
| `package.json` build block | KEEP, sửa metadata |

**REWRITE/NEW**:
- `patch-sqlite3.js` → build SQLCipher từ source + verify `cipher_version` (bản cũ chỉ copy vanilla + check ELF).
- `patch-renderer-win32.js` → NEW (DARWIN→WIN32 + getClientType 23→24).
- `patch-linux-guards.js` → NEW (codesign short-circuit + guard loader throw).
- `main.js` shell → đơn giản hóa: bỏ hack titlebar `console.log`; dựa vào win32 controls của renderer.
- `docs/PORTING-GUIDE.md` → viết lại (bản cũ vẫn mô tả patch `frame:!1→!0` đã bỏ).

**DROP** (không mang sang): 3 patch titlebar thử nghiệm (`patch-titlebar`, `patch-window-controls`, `patch-macos-titlebar`), 2 patch nguồn-Windows (`patch-native-path`, `patch-resource-drive`), đường download `.exe`/NSIS, docs specs/plans cũ, `reference-zalo-for-linux/`, toàn bộ nhánh git cũ.

---

## 11. Fast-follows (ngoài v1)

1. **Hiển thị ảnh JXL** (`zimage`/`zjxl` → `sharp` build với libvips+libjxl) — ưu tiên #1, khoảng cách cảm nhận lớn nhất.
2. Video thumbnail (`mp4thumb` → ffmpeg), storage GC (`zwalker` đầy đủ).
3. Tray (Linux dùng PNG + AppIndicator), auto-update (cần AppImage + feed thật), AppImage/Flatpak, arm64.
4. Voice/video call (`zcall`) — nặng nhất, reverse/reimplement WebRTC.

---

## 12. Rủi ro & điểm cần xác minh khi implement

- **sqlite3 + SQLCipher build**: include path libsqlcipher (`/usr/include/sqlcipher`) và flag mapbox node-sqlite3 hơi finicky — verify bằng cách mở DB thật. Nếu máy có DB plaintext từ bản cũ, build SQLCipher sẽ không mở được DB đó → phải login/sync lại (cài mới không ảnh hưởng).
- **patch-renderer-win32**: xác nhận số lần thay `DARWIN→WIN32` và `getClientType 23→24` khớp đúng các bundle `pc-dist` của 26.6.11; verify titlebar render thật trên GNOME.
- **db-cross-v4 binding.js regex**: fail-loud nếu Zalo đổi format `binding.js`.
- **Login handshake**: sau khi spoof client-type 24, nếu login lỗi bất thường thì đây là chỗ cần soi lại.
- **ElectronAsarIntegrity**: bản macOS có integrity check trong Info.plist; ta build asar riêng nên tự kiểm soát — xác nhận electron-builder không nhét integrity gây lỗi.
