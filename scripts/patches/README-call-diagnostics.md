# Linux call diagnostics — how to run

Diagnostics-only. Finds why Zalo voice/video calls don't work on the Linux build by
logging the webview + permission + console events during a REAL call. See the design at
`docs/superpowers/specs/2026-07-12-linux-call-diagnostics-design.md`.

## Build + run

    SETUP=true BUILD=true node scripts/main.js       # builds dist/Zalo-*.deb with the diagnostics patch
    sudo dpkg -i dist/Zalo-*.deb
    rm -f ~/zalo-call-diag.log
    zalo                                              # log in with YOUR account

Place a real 1-1 call (this Linux machine -> your own phone), try audio then video, let it
ring/connect for ~15s, then hang up.

    cat ~/zalo-call-diag.log

Send that log. It shows, in order: whether the call `<webview>` attached
(`DID-ATTACH-WEBVIEW` / `WEBVIEW-CREATED`), whether it loaded the voicecall-wpa page
(`WEBVIEW-DID-FINISH-LOAD` vs `DID-FAIL-LOAD`), any in-page errors (`CONSOLE`, e.g.
`getUserMedia` NotAllowedError), and every media permission request/grant
(`PERMISSION-REQUEST` / `PERMISSION-CHECK`). The device picker runs in a normal renderer,
so its `getListDevices` failure surfaces as a `CONSOLE` line too. That log is the gap
report input.

## Notes
- Only touches the app's own `persist:zalo` session, your own account. No third party.
- Remove this patch (and `app/main-dist/__call_diag.js`) before any shipping build.
