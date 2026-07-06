# Zalo for Linux

A clean re-port of the Zalo desktop app (Electron, Vietnamese messenger by VNG)
to **Linux x64**, packaged as a `.deb`. The bundle is extracted from the official
**macOS DMG** (`ZaloSetup-universal`), patched minimally, with native modules
rebuilt from source for Linux.

> Zalo is a trademark of VNG Corporation. This project is not affiliated with or
> endorsed by VNG. It repackages the original bundle with minimal patches and
> rebuilds native modules from source for Linux.

## Requirements

System packages (Debian/Ubuntu):

```bash
sudo apt install build-essential libssl-dev liblzma-dev libsqlcipher-dev \
  p7zip-full dpkg fakeroot
```

Node.js 18+ and npm.

## Usage

```bash
npm install          # install the Electron shell + build deps
npm run setup        # download DMG, extract bundle to app/, patch, build native
npm start            # run the app (dev)
npm run build        # produce dist/Zalo-<version>.deb
npm run main         # setup + build in one shot
```

Set `ZALO_DMG=/path/to/ZaloSetup-universal-<ver>.dmg` to skip the download and
use a local DMG.

## Layout

- `main.js` — Electron shell entry (loads the extracted bundle).
- `scripts/` — orchestrator, download/extract, build, and patches.
- `nativelibs/` — native module sources built from scratch every setup.
- `app/` — extracted Zalo bundle (git-ignored, never committed).

## License

MIT (harness only). The Zalo bundle itself is proprietary to VNG.
