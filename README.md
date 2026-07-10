# Zalo for Linux

A clean re-port of the **Zalo** desktop app (Vietnamese messenger by VNG) to
**Linux x64**, packaged as a `.deb`. The bundle is extracted from the official
**macOS DMG** (`ZaloSetup-universal`), patched minimally, and its native modules
are rebuilt from source for Linux. Runs on **Electron 39** (Chromium 142) with
native Wayland.

> Zalo is a trademark of VNG Corporation. This project is **not affiliated with
> or endorsed by VNG**. It repackages the original bundle with minimal patches
> and rebuilds native modules from source for Linux. For personal use.

## Features

- **Native Wayland** (Electron 39) — reliable drag-and-drop ("Gửi nhanh"),
  including fast drags that broke under the old XWayland build.
- **Vietnamese input** via fcitx5/ibus.
- **JPEG-XL images** — Zalo stores received photos as `.jxl`; Chromium 142 can't
  decode them, so the app is forced onto the native RE'd decoders
  (`zjxl` + `zimage`) which render and thumbnail them correctly.
- **System tray** — icon, tooltip, context menu, unread badge, status switching,
  show/quit (the macOS tray, un-gated for Linux).
- **Window state** — opens maximized and remembers size/maximized across restart.
- **Native modules rebuilt from source** — SQLCipher (`sqlite3`), E2EE backup
  decrypt (`db-cross-v4`), `zfile`, `zjxl`, `zimage`, `v8-profiles`.

## Requirements

Node.js 18+ and npm, plus system packages (Debian/Ubuntu):

```bash
# runtime + packaging
sudo apt install -y build-essential libssl-dev liblzma-dev libsqlcipher-dev \
  p7zip-full dpkg fakeroot

# building the native modules from source (zjxl / zimage / v8-profiles / …)
sudo apt install -y cmake meson ninja-build pkg-config libtool autoconf \
  automake gettext autopoint nasm patchelf clang git wget unzip python3
```

The native build scripts under `nativelibs/*/scripts/` also auto-install a few
of their own dependencies via `apt` on first run.

## Usage

```bash
npm install          # install the Electron shell + build deps
npm run setup        # download DMG, extract bundle to app/, patch, build native
npm start            # run the app (dev)
npm run build        # produce dist/Zalo-<version>.deb
npm run main         # setup + build in one shot
```

Install the built package:

```bash
sudo dpkg -i dist/Zalo-*.deb
sudo apt -f install          # pull in any missing runtime deps
```

Set `ZALO_DMG=/path/to/ZaloSetup-universal-<ver>.dmg` to skip the download and
use a local DMG.

## Layout

- `main.js` — Electron shell entry (loads the extracted bundle).
- `scripts/` — orchestrator, download/extract, build, and the `patches/` applied
  to the extracted bundle (each idempotent, fail-loud on version drift).
- `nativelibs/` — native module sources, built from scratch every setup.
- `app/` — extracted Zalo bundle (git-ignored, never committed).
- `docs/` — porting guide, RE roadmap, and per-feature design notes.

## Donate / Ủng hộ

Dự án làm miễn phí cho cộng đồng Linux dùng Zalo. Nếu thấy hữu ích, bạn có thể
ủng hộ tác giả một ly cà phê ☕ — cảm ơn rất nhiều! _(Free project — if it helps
you, a coffee is appreciated. Thank you!)_

- **PayPal:** [paypal.me/totaa237](https://paypal.me/totaa237)
- **VietQR (VIB) — chuyển khoản ngân hàng:**
  - Chủ tài khoản: **THO THANH TAM**
  - Số tài khoản: **003704060209590** (VIB)

<p>
  <img src="docs/donate-qr.jpg" alt="VietQR donate" width="280">
</p>

## License

MIT (harness only). The Zalo bundle itself is proprietary to VNG.
