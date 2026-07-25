const assert = require('assert');
const path = require('path');
const { createCallUI } = require('../call-ui.js');

// Fake Electron
let lastWin = null;
class FakeWin {
  constructor(opts) {
    this.opts = opts; this.sent = []; this._on = {}; this._once = {}; this.destroyed = false; lastWin = this;
  }
  loadFile(p) { this.loaded = p; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  minimize() { this.minimized = true; }
  maximize() { this.maximized = true; }
  unmaximize() { this.maximized = false; }
  isMaximized() { return !!this.maximized; }
  focus() { this.focused = true; }
  close() { this._osClose(); }
  on(ev, cb) { this._on[ev] = cb; }
  once(ev, cb) { this._once[ev] = cb; }
  removeAllListeners(ev) { delete this._on[ev]; }
  get webContents() { const self = this; return {
    // Model real Electron: the renderer's own ipcRenderer listener isn't registered until the
    // page's script runs (after did-finish-load), so anything sent before that point never
    // reaches it. Gating on `pageReady` (distinct from `loaded`, which just records the file
    // path passed to loadFile()) lets tests exercise that race instead of hiding it behind a
    // fake that records every send unconditionally.
    send: (ch, payload) => { if (self.pageReady) self.sent.push([ch, payload]); },
    once: (ev, cb) => { self._once[ev] = cb; },
  }; }
  _finishLoad() { this.pageReady = true; if (this._once['did-finish-load']) this._once['did-finish-load'](); }
  _osClose() { if (this._on['closed']) this._on['closed'](); }
}
const ipcHandlers = {};
const fakeIpc = {
  on: (ch, cb) => { ipcHandlers[ch] = cb; },
  removeListener: (ch, cb) => { if (ipcHandlers[ch] === cb) delete ipcHandlers[ch]; },
  _emit: (ch, msg) => { if (ipcHandlers[ch]) ipcHandlers[ch]({}, msg); },
};

const ui = createCallUI({ BrowserWindow: FakeWin, ipcMain: fakeIpc, htmlPath: '/x/call.html', preloadPath: '/x/preload.js', devicesHtmlPath: '/x/devices.html', incomingHtmlPath: '/x/incoming.html' });

// show -> constructs a frameless 456x720 window, loads html, sends partner after finish-load
ui.show({ name: 'Tâm Tho', avatar: 'http://a/x.png' });
assert.ok(lastWin, 'window created');
assert.strictEqual(lastWin.opts.width, 456); assert.strictEqual(lastWin.opts.height, 720);
assert.strictEqual(lastWin.opts.frame, false, 'frameless');
assert.strictEqual(lastWin.opts.webPreferences.preload, '/x/preload.js', 'preload wired');
assert.strictEqual(lastWin.loaded, '/x/call.html', 'loadFile(html)');
lastWin._finishLoad();
assert.ok(lastWin.sent.some(m => m[0] === 'zcall-ui:partner' && m[1].name === 'Tâm Tho'), 'partner sent');

// setState / setDevices
ui.setState('connected', { connectedAt: 123 });
assert.ok(lastWin.sent.some(m => m[0] === 'zcall-ui:state' && m[1].state === 'connected' && m[1].connectedAt === 123), 'state sent');
ui.setDevices({ capture: [], playback: [], selectedIn: -1, selectedOut: -1 });
assert.ok(lastWin.sent.some(m => m[0] === 'zcall-ui:devices'), 'devices sent');

// renderer action -> registered handler
let ended = 0, muteVal = null;
ui.on('end', () => { ended++; });
ui.on('mute', (v) => { muteVal = v; });
fakeIpc._emit('zcall-ui:action', { action: 'mute', value: true });
assert.strictEqual(muteVal, true, 'mute handler got value');
fakeIpc._emit('zcall-ui:action', { action: 'end' });
assert.strictEqual(ended, 1, 'end handler fired');

// OS close fires end exactly once, and programmatic close does not
ui.show({ name: 'A' }); lastWin._finishLoad();
let osEnds = 0; ui.on('end', () => { osEnds++; });
lastWin._osClose();
assert.strictEqual(osEnds, 1, 'OS close -> end');

// programmatic close destroys and removes the ipc listener
ui.show({ name: 'B' }); lastWin._finishLoad();
let afterClose = 0; ui.on('end', () => { afterClose++; });
ui.close();
assert.ok(lastWin.destroyed, 'window destroyed on close()');
assert.strictEqual(afterClose, 0, 'close() does not fire end');
// the ipc listener must survive close() so a 2nd call's buttons still work
fakeIpc._emit('zcall-ui:action', { action: 'end' });
assert.strictEqual(afterClose, 1, 'action still routes after close() (2nd-call regression)');

// window controls (min/max/close) are handled by the controller itself, not the engine handlers
ui.show({ name: 'W' }); lastWin._finishLoad();
const wctrl = lastWin;
fakeIpc._emit('zcall-ui:action', { action: 'win', value: 'minimize' });
assert.ok(wctrl.minimized, 'win minimize');
fakeIpc._emit('zcall-ui:action', { action: 'win', value: 'maximize' });
assert.ok(wctrl.maximized, 'win maximize');
let winClosedEnd = 0; ui.on('end', () => { winClosedEnd++; });
fakeIpc._emit('zcall-ui:action', { action: 'win', value: 'close' });
assert.strictEqual(winClosedEnd, 1, 'win close -> end (via closed event)');

// messages sent before did-finish-load are queued, then flushed on load
const ui2 = createCallUI({ BrowserWindow: FakeWin, ipcMain: fakeIpc, htmlPath: '/x/call.html', preloadPath: '/x/preload.js' });
ui2.show({ name: 'Q' });
const w2 = lastWin;
ui2.setState('calling', { name: 'Q' });
ui2.setDevices({ capture: [{ index: 0, name: 'm' }], playback: [] });
assert.ok(!w2.sent.some(m => m[0] === 'zcall-ui:state'), 'state queued before load (not sent yet)');
w2._finishLoad();
assert.ok(w2.sent.some(m => m[0] === 'zcall-ui:partner'), 'partner sent on load');
assert.ok(w2.sent.some(m => m[0] === 'zcall-ui:state' && m[1].state === 'calling'), 'queued state flushed');
assert.ok(w2.sent.some(m => m[0] === 'zcall-ui:devices' && m[1].capture.length === 1), 'queued devices flushed');

// --- device-status window (MH2) as a separate, independent window ---
(function () {
  const ipc2 = {};
  const fake2 = { on: (c, cb) => { ipc2[c] = cb; }, removeListener: () => {}, _emit: (c, m) => { if (ipc2[c]) ipc2[c]({}, m); } };
  const ui2 = createCallUI({ BrowserWindow: FakeWin, ipcMain: fake2, htmlPath: '/x/call.html', preloadPath: '/x/preload.js', devicesHtmlPath: '/x/devices.html' });
  ui2.show({ name: 'X' }); lastWin._finishLoad();
  const callW = lastWin;
  fake2._emit('zcall-ui:action', { action: 'openSettings' });
  const devW = lastWin;
  assert.notStrictEqual(devW, callW, 'openSettings opened a separate window');
  assert.strictEqual(devW.loaded, '/x/devices.html', 'device window loads devices.html');
  devW._finishLoad();
  ui2.setDevices({ capture: [{ index: 0, name: 'm' }], playback: [], selectedIn: -1, selectedOut: -1 });
  assert.ok(devW.sent.some(m => m[0] === 'zcall-ui:devices'), 'devices forwarded to device window');
  fake2._emit('zcall-ui:action', { action: 'devwin', value: 'minimize' });
  assert.ok(devW.minimized && !callW.minimized, 'devwin minimize hits the device window only');
  fake2._emit('zcall-ui:action', { action: 'devwin', value: 'close' });
  fake2._emit('zcall-ui:action', { action: 'openSettings' });
  assert.notStrictEqual(lastWin, devW, 'device window reopens fresh after close');
  const devW2 = lastWin; devW2._finishLoad();
  ui2.close();
  assert.ok(devW2.destroyed, 'close() destroys the device window too');
})();

// --- incoming call window (ring screen): showIncoming/closeIncoming, accept/decline routing,
// state forwarding (for the ringtone), incwin window controls, close() cleanup ---
(function () {
  const ipc3 = {};
  const fake3 = { on: (c, cb) => { ipc3[c] = cb; }, removeListener: () => {}, _emit: (c, m) => { if (ipc3[c]) ipc3[c]({}, m); } };
  const ui3 = createCallUI({ BrowserWindow: FakeWin, ipcMain: fake3, htmlPath: '/x/call.html', preloadPath: '/x/preload.js', devicesHtmlPath: '/x/devices.html', incomingHtmlPath: '/x/incoming.html' });
  let accepted = false, declined = false;
  ui3.on('accept', () => { accepted = true; });
  ui3.on('decline', () => { declined = true; });

  ui3.showIncoming({ name: 'Caller X', avatar: null });
  const incWin = lastWin;
  assert.strictEqual(incWin.loaded, '/x/incoming.html', 'incoming window loads incoming.html');
  incWin._finishLoad();
  assert.ok(incWin.sent.some(m => m[0] === 'zcall-ui:partner' && m[1].name === 'Caller X'), 'partner sent to incoming window');

  ui3.setState('ringing-incoming', { name: 'Caller X' });
  assert.ok(incWin.sent.some(m => m[0] === 'zcall-ui:state' && m[1].state === 'ringing-incoming'), 'state forwarded to incoming window');

  fake3._emit('zcall-ui:action', { action: 'accept' });
  assert.ok(accepted, 'accept routed');
  fake3._emit('zcall-ui:action', { action: 'decline' });
  assert.ok(declined, 'decline routed');

  fake3._emit('zcall-ui:action', { action: 'incwin', value: 'minimize' });
  assert.ok(incWin.minimized, 'incwin routes window controls to the incoming window');

  ui3.closeIncoming();
  assert.ok(incWin.destroyed, 'incoming window destroyed by closeIncoming()');

  // close() also destroys a live incoming window
  ui3.showIncoming({ name: 'Caller Y' });
  const incWin2 = lastWin; incWin2._finishLoad();
  ui3.close();
  assert.ok(incWin2.destroyed, 'close() destroys the incoming window too');
})();

// --- incoming-window state race (ringtone fix): the engine calls showIncoming(partner) then
// setState('ringing-incoming', ...) in the SAME synchronous tick, before the incoming page's
// did-finish-load fires. The renderer's ipcRenderer listener isn't registered until the page's
// own script runs, so a state sent before load is unobservable to it -- exactly what the fake's
// `loaded` gate above models. This must model the real ordering (not fire did-finish-load
// synchronously) so the race is genuinely exercised, not hidden.
(function () {
  const ipc5 = {};
  const fake5 = { on: (c, cb) => { ipc5[c] = cb; }, removeListener: () => {}, _emit: (c, m) => { if (ipc5[c]) ipc5[c]({}, m); } };
  const ui5 = createCallUI({ BrowserWindow: FakeWin, ipcMain: fake5, htmlPath: '/x/call.html', preloadPath: '/x/preload.js', devicesHtmlPath: '/x/devices.html', incomingHtmlPath: '/x/incoming.html' });

  ui5.showIncoming({ name: 'Caller Z' });
  const incWinRace = lastWin;
  // showIncoming -> setState happen back-to-back, BEFORE the page finishes loading.
  ui5.setState('ringing-incoming', { name: 'Caller Z' });
  assert.ok(!incWinRace.sent.some(m => m[0] === 'zcall-ui:state'), 'state sent before load is not observed by the (not-yet-ready) renderer -- the race is real');

  // The page finishes loading afterwards; the fix must redeliver the latest state here so the
  // ringtone still plays.
  incWinRace._finishLoad();
  assert.ok(incWinRace.sent.some(m => m[0] === 'zcall-ui:state' && m[1].state === 'ringing-incoming'), 'ringing-incoming state redelivered once the incoming window finishes loading (ringtone fix)');
})();

// --- device-list redelivery regression: setDevices() called BEFORE show() must not be lost for
// the main call window's inline device menu (mirrors devWin's existing re-delivery on load) ---
(function () {
  const ipc4 = {};
  const fake4 = { on: (c, cb) => { ipc4[c] = cb; }, removeListener: () => {}, _emit: (c, m) => { if (ipc4[c]) ipc4[c]({}, m); } };
  const ui4 = createCallUI({ BrowserWindow: FakeWin, ipcMain: fake4, htmlPath: '/x/call.html', preloadPath: '/x/preload.js', devicesHtmlPath: '/x/devices.html' });
  ui4.setDevices({ capture: [{ index: 0, name: 'Mic A' }], playback: [] });
  ui4.show({ name: 'Partner Y' });
  const callWin = lastWin;
  callWin._finishLoad();
  assert.ok(callWin.sent.some(m => m[0] === 'zcall-ui:devices' && m[1].capture && m[1].capture[0].name === 'Mic A'), 'devices set before show() are redelivered to the call window on load');
})();

// --- callType seam: show() accepts opts.callType (0=audio, default). Future video would branch
// on opts.callType===1 (not implemented). Audio path must remain unchanged. ---
(function () {
  const ipc6 = {};
  const fake6 = { on: (c, cb) => { ipc6[c] = cb; }, removeListener: () => {}, _emit: (c, m) => { if (ipc6[c]) ipc6[c]({}, m); } };
  const ui6 = createCallUI({ BrowserWindow: FakeWin, ipcMain: fake6, htmlPath: '/x/call.html', preloadPath: '/x/preload.js' });
  ui6.show({ name: 'A' }, { callType: 0 });
  const callWin = lastWin;
  assert.strictEqual(callWin.loaded, '/x/call.html', 'audio callType still opens call.html');
  console.log('OK call-ui callType');
})();

console.log('OK call-ui');
