# zsrtp — libsrtp2 N-API addon (SP2 2.2)

Wraps `srtp_protect`/`srtp_unprotect` (libsrtp2 v2.5.0, static, internal crypto) for the Linux
zcall media path. Profile `AES_CM_128_HMAC_SHA1_80`, master key = `sessId[0:30]`.

## Build (local Node, for tools/ tests)
```
cd nativelibs/zsrtp
npm install --ignore-scripts
npm run build:deps      # fetch + static-build libsrtp2 into .deps/
npm run build           # node-gyp rebuild -> build/Release/zsrtp.node
node __tests__/roundtrip.test.js
node __tests__/crosscheck.test.js
```

`.deps/`, `build/`, `node_modules/` are git-ignored. The Electron/deb build is step 4.
