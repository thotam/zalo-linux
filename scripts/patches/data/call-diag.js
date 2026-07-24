'use strict';
// Linux call diagnostics — main-process instrumentation. DIAGNOSTICS-ONLY; never shipped.
// Copied verbatim to app/main-dist/__call_diag.js by patch-call-diagnostics.js and required
// at the top of main.js. Observes the webview call path + media permissions and appends
// structured events to ~/zalo-call-diag.log so one real call reveals the Linux gaps.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = process.env.ZALO_CALL_LOG || path.join(os.homedir(), 'zalo-call-diag.log');

function safeJson(obj) {
  try { return typeof obj === 'string' ? obj : JSON.stringify(obj); }
  catch (_) { return String(obj); }
}
function formatLine(when, role, tag, obj) {
  let s = when + ' [' + role + '] ' + tag;
  if (obj !== undefined) s += ' ' + safeJson(obj);
  return s + '\n';
}
function log(tag, obj) {
  try { fs.appendFileSync(LOG, formatLine(new Date().toISOString(), process.type || 'main', tag, obj)); }
  catch (_) { /* fail open — diagnostics must never break the app */ }
}

// True for the call signaling / config hosts we tap (voicecall-wpa, wpa.chat, call_config).
function isCallHost(url) {
  if (!url) return false;
  const u = String(url);
  return u.indexOf('voicecall') >= 0 || u.indexOf('wpa.chat') >= 0 || u.indexOf('action=call_config') >= 0;
}

module.exports = { formatLine, safeJson, isCallHost };

// --- Electron wiring (real app only). Skipped in unit tests / when electron is absent. ---
if (!process.env.CALL_DIAG_TEST) {
  try {
    const { app, session } = require('electron');
    log('DIAG-INIT', { log: LOG, electron: (process.versions && process.versions.electron) || null });

    // Opt-in remote debugging (SP2 signaling prototype). Enabled from INSIDE the main process
    // (before app-ready) because the Electron CLI-args fuse rejects --remote-debugging-port.
    // Gate on ZALO_REMOTE_DEBUG so normal launches are unaffected. Diagnostics-only.
    if (process.env.ZALO_REMOTE_DEBUG) {
      try {
        app.commandLine.appendSwitch('remote-debugging-port', process.env.ZALO_REMOTE_DEBUG === '1' ? '9222' : String(process.env.ZALO_REMOTE_DEBUG));
        app.commandLine.appendSwitch('remote-allow-origins', '*');
        log('REMOTE-DEBUG-ENABLED', { port: process.env.ZALO_REMOTE_DEBUG === '1' ? '9222' : process.env.ZALO_REMOTE_DEBUG });
      } catch (err) { log('REMOTE-DEBUG-ERROR', String((err && err.message) || err)); }
    }

    const url = (c) => { try { return c.getURL(); } catch (_) { return '?'; } };

    // Webview + renderer lifecycle: attach, load result, console (in-page getUserMedia errors), crashes.
    app.on('web-contents-created', (_e, contents) => {
      try {
        const type = contents.getType();
        contents.on('did-fail-load', (_ev, code, desc, u) => log('DID-FAIL-LOAD', { type, code, desc, url: u }));
        contents.on('console-message', (_ev, level, message, line, source) =>
          log('CONSOLE', { type, level, message, line, source }));
        contents.on('render-process-gone', (_ev, details) => log('RENDER-GONE', { type, details }));
        contents.on('did-attach-webview', (_ev, wc) => log('DID-ATTACH-WEBVIEW', { host: url(contents) }));
        if (type === 'webview') {
          log('WEBVIEW-CREATED', { url: url(contents) });
          contents.on('did-finish-load', () => log('WEBVIEW-DID-FINISH-LOAD', { url: url(contents) }));
        }
        // CDP Network tap: log call/config HTTP request+response bodies (plaintext, no TLS MITM).
        try {
          const dbg = contents.debugger;
          if (dbg && !dbg.isAttached()) {
            dbg.attach('1.3');
            const pending = {};
            dbg.on('message', (_ev, method, params) => {
              try {
                if (method === 'Network.requestWillBeSent' && isCallHost(params.request && params.request.url)) {
                  pending[params.requestId] = params.request.url;
                  log('HTTP-REQ', { url: params.request.url, method: params.request.method, postData: params.request.postData });
                } else if (method === 'Network.responseReceived' && pending[params.requestId]) {
                  const rurl = pending[params.requestId];
                  dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
                    .then((r) => log('HTTP-RESP', { url: rurl, status: params.response && params.response.status, body: r && r.body }))
                    .catch((e) => log('HTTP-RESP-ERR', { url: rurl, err: String((e && e.message) || e) }));
                }
              } catch (err) { log('CDP-MSG-ERROR', String((err && err.message) || err)); }
            });
            dbg.sendCommand('Network.enable').catch((e) => log('CDP-ENABLE-ERR', String((e && e.message) || e)));
          }
        } catch (err) { log('CDP-ATTACH-ERROR', String((err && err.message) || err)); }
      } catch (err) { log('WC-HOOK-ERROR', String((err && err.message) || err)); }
    });

    // Media permission: log every request/check on the app session and GRANT media, so the
    // run reveals the downstream chain rather than dead-ending at the permission gap.
    app.whenReady().then(() => {
      try {
        const ses = session.fromPartition('persist:zalo');
        ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
          log('PERMISSION-REQUEST', { permission, url: details && details.requestingUrl });
          cb(permission === 'media' || permission === 'mediaKeySystem');
        });
        ses.setPermissionCheckHandler((_wc, permission, origin) => {
          log('PERMISSION-CHECK', { permission, origin });
          return permission === 'media';
        });
        log('PERMISSION-HANDLERS-INSTALLED', { partition: 'persist:zalo' });
      } catch (err) { log('PERMISSION-INSTALL-ERROR', String((err && err.message) || err)); }
    }).catch((err) => log('WHENREADY-ERROR', String((err && err.message) || err)));
  } catch (err) {
    log('DIAG-FATAL', String((err && err.message) || err));
  }
}
