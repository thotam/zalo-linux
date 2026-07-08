# Linux Tray Icon — Design

- **Date:** 2026-07-08
- **Branch:** `feat/linux-tray`
- **Status:** approved (design), pending implementation plan

## Problem

Zalo's system-tray icon does not work on Linux. The tray is **fully implemented**
in the ported macOS main-process bundle (`app/main-dist/main.js`) — icon, tooltip,
context menu, unread badge, status switching, show/quit handlers — but the whole
setup is wrapped in a macOS-only platform gate, so no `Tray` is ever created on
Linux.

## Goal

Enable the existing tray on Linux, reusing the macOS menu and behavior as-is
(user decision: "giữ nguyên menu macOS"). Fix the two Linux-specific pitfalls
that would otherwise break it: icon format/size, and the XWayland blank-window
bug when restoring from the tray.

### Non-goals

- No new menu items or redesign (parity with the existing macOS menu).
- No single-instance changes (Zalo self-manages via its socket; see
  `patch-relaunch-reveal`).
- Not solving GNOME's AppIndicator-extension requirement in code (documented +
  verified at test time).

## Existing implementation (from code investigation)

All in `app/main-dist/main.js`, module with `u=s.Tray, p=s.nativeImage`:

- **Gate (the blocker):** the tray IIFE runs at startup but its body is guarded by
  `if(J()===q){ … }` where `J()`=`getClientType()` and `q`=`MAC_CLIENT_TYPE` (23).
  On Linux `getClientType()` returns 24 (LINUX, patched) so the gate is false →
  no `Tray`.
- **Creation:** `xe = new Tray(Nt)` where
  `Nt = nativeImage.createFromPath(join(te(), "favicon.ico"))` (`te()` = `pc-dist`
  dir; `favicon.ico` ships there). `xe.setToolTip("Zalo")`.
- **Icon states (2):** in the dock-badge module, `m.setImage(createFromDataURL(i))`
  when there are unread messages (`i` = badge data URL), else `m.setImage(l)` (base
  icon). Tied to unread count `t`.
- **Context menu (rebuilt from current status `Ln`):**
  - Logged in (`Ln>=0`): `Mở Zalo` → show; `Đổi trạng thái` ▸ [`Đang online` (✓ if
    `Ln===0`), `Đang bận (Tắt thông báo tin nhắn)` (✓ if `Ln===2`)]; separator;
    `Thoát` → `requestQuitApp`. Dev-only prepend: `Mở Zalo Logger`.
  - Not logged in (`Ln===-1`): `Mở Zalo`; separator; `Thoát`.
  - The setup is idempotent (`xe||(xe=new Tray(Nt))`) and rebuilds the menu with the
    current `Ln`, so it updates after login/status change.
- **Handlers:** `xe.on("double-click", tn)`. `tn()` → `Ae.webContents.send("show-from-tray"); en(Ae)`.
  `en(e)` (show helper) Linux branch: `e.isMinimized()?e.restore():e.show(); e.focus()`.
- **Status `Ln`:** `-1` not logged in, `0` online, `2` busy/mute.

## Design (Approach A: minimal un-gate patch)

New patch `scripts/patches/patch-tray.js` (main-dist), registered in
`scripts/main.js` after `patch-platform-id`. Fail-loud on anchor drift, idempotent,
unit-tested. Three splices; no committed image asset (icon is resized at runtime).

### Edit 1 — un-gate the tray on Linux

Anchor: `G.requestQuitApp()};if(J()===q){const t=s.Menu;`

Change `if(J()===q){` → `if(J()===q||"linux"===process.platform){`

The whole guarded block (Tray create + menu build + tooltip + setContextMenu) is
cross-platform; only the gate blocks Linux. Idempotency marker:
`J()===q||"linux"===process.platform`.

### Edit 2 — tray icon: app icon, resized at runtime

Anchor: `Nt=p.createFromPath(c.join(te(),"favicon.ico"))`

Change to: `Nt=p.createFromPath(c.join(te(),"apple-icon-57x57.png")).resize({width:44,height:44})`

- `nativeImage.resize({width:44,height:44})` runs at launch in the main process (a
  standard Electron API), so the tray icon is derived from the app's current icon
  **every run** — if a future Zalo version changes `apple-icon-57x57.png`, the tray
  follows automatically. No build-time image tool, no committed PNG.
- `apple-icon-57x57.png` (57×57 RGBA) ships in `pc-dist`; 44×44 suits the GNOME
  panel (2× of 22 logical) and stays crisp on HiDPI. `.ico` is avoided (renders
  poorly on Linux trays).
- Idempotency marker: `apple-icon-57x57.png`.

### Edit 3 — reveal repaint for show-from-tray

Anchor (the `en` show helper's Linux branch):
`function en(e){if(e){if(J()===K)return e.isMinimized()?e.restore():e.show(),void e.focus();`

After `e.show()` on Linux, a maximized frameless window is not re-composited by
GNOME/mutter (same XWayland bug as relaunch). Add one native reconfigure
(`unmaximize()→maximize()`, deferred a tick) when `e.isMaximized()` on Linux, so
restoring from the tray shows content instead of a blank surface. Reuses the exact
technique proven in `patch-relaunch-reveal` (kept as a separate splice — different
function/anchor). Idempotency marker: the injected toggle string.

## Constraints / risks

- **GNOME AppIndicator:** Electron `Tray` on GNOME needs the *AppIndicator and
  KStatusNotifierItem Support* extension (enabled by default on Ubuntu). Verify at
  first test; if absent, document enabling it (not a code fix).
- **No click-to-show on GNOME:** AppIndicator left-click opens the menu; there is no
  separate activate/double-click. The window is restored via the `Mở Zalo` menu
  item, not by clicking the icon. Acceptable (menu is the primary interaction).
- **To verify during implementation (existing behavior, expected to carry over):**
  menu rebuilds after login (`Ln` change); unread badge (`setImage` from data URL);
  `Đổi trạng thái` handlers; `Thoát` fully quits.

## Testing

Install the built `.deb`, launch via icon, then:
1. Tray icon appears in the top bar (else: check AppIndicator extension).
2. Right-click → context menu shows all Vietnamese items.
3. `Mở Zalo` reveals the window **with content** (no blank) after it was hidden.
4. `Thoát` quits the app fully (process gone).
5. Unread messages → tray icon shows the badge state.
6. `Đổi trạng thái` → Online / Bận toggles and the checkmark reflects it.

## Test coverage (patch unit test)

`scripts/patches/__tests__/patch-tray.test.js` — stub main.js with the three
anchors (two minification schemes where vars differ), assert each splice applied,
idempotent (second run = no-op), and fail-loud when an anchor is missing.
