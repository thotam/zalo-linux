# tools/zcall-media

Media-layer tooling for the Linux zcall engine (SP2). Own account / own phone / own traffic only;
per-call `sessId`/keys/relay-addresses are ephemeral secrets — never committed.

## SRTP decrypt (SP2 2a — validated, authOk 10/10 on real media)

- `srtp-kdf.js` — RFC 3711 §4.3.1 key derivation (AES-CM PRF).
- `srtp-decrypt.js` — RTP parse + AES-128-CTR decrypt + HMAC-SHA1 auth.
- `decrypt-capture.js` — decrypt captured Zalo SRTP media with `sessId[0:30]` (strips the 5-byte
  zrtc wrapper). `CAPTURE-MEDIA-WIN.md` is the capture runbook.

## InitZRTP handshake (SP2 step 2.1)

Build + send the InitZRTP handshake to a real relay and read back the media address.

- `initzrtp.js` — byte-exact builder/parser (§A of the InitZRTP decision doc). Pure, unit-tested.
- `handshake.js` — `dgram` sweep: probe+request to each `servers[]` candidate on `:4200`, collects
  the `0x02` replies. Loopback-tested.
- `live-handshake.js` — operator CLI. Own account / own phone only.

### Run live (own call)
1. Launch Zalo with remote debugging: `ZALO_REMOTE_DEBUG=1 /opt/Zalo/com.zalo.linux`
2. `node tools/zcall-media/live-handshake.js <yourCalleeId>`
3. Success = `relaysReplied >= 1/N` with a (masked) relay media address. The raw sessId/IP are
   never printed or committed. The returned `relayAddr` is the input to step 2.2 (media).

## SRTP media send/receive (SP2 2.2)

Duplex SRTP to the relay using the native `zsrtp` addon (build it first — see
`nativelibs/zsrtp/README.md`).

- `zsrtp.js` — loads the `nativelibs/zsrtp` addon (`srtp_protect`/`srtp_unprotect`).
- `rtp.js` / `media-frame.js` — RTP build/parse (pt=112, 0xBEDE) + the 5-byte zrtc wrapper.
- `media-session.js` — `MediaSession`: duplex UDP to the relay, protect/wrap on send,
  unwrap/unprotect on receive.
- `live-media.js` — operator CLI. Own account / own phone only.

### Run live (own call)
1. Build the addon: `cd nativelibs/zsrtp && npm install --ignore-scripts && npm run build:deps && npm run build`
2. `ZALO_REMOTE_DEBUG=1 /opt/Zalo/com.zalo.linux`
3. `node tools/zcall-media/live-media.js <yourCalleeId>`
4. Success = `inboundAuthOk >= 1` (peer's real media decrypted on Linux). Payload is synthetic
   (opus is step 3). If inbound stays 0, check the §B.3 re-key boundary / the flowToken note.

## Tests
```
node tools/zcall-media/__tests__/initzrtp.test.js
node tools/zcall-media/__tests__/handshake.test.js
node tools/zcall-media/__tests__/rtp-frame.test.js
node tools/zcall-media/__tests__/media-session.test.js
node tools/zcall-media/__tests__/srtp-decrypt.test.js
node tools/zcall-media/__tests__/srtp-kdf.test.js
# native addon (build first — see nativelibs/zsrtp/README.md):
node nativelibs/zsrtp/__tests__/roundtrip.test.js
node nativelibs/zsrtp/__tests__/crosscheck.test.js
```
