'use strict';
// Main-process controller for the Linux call window. Injected BrowserWindow/ipcMain keep it
// unit-testable offline. The engine drives it via show/setState/setDevices; window buttons come
// back through on(event, cb).
function createCallUI(opts) {
  opts = opts || {};
  var BrowserWindow = opts.BrowserWindow;
  var ipcMain = opts.ipcMain;
  var htmlPath = opts.htmlPath;
  var preloadPath = opts.preloadPath;
  var devicesHtmlPath = opts.devicesHtmlPath;
  var incomingHtmlPath = opts.incomingHtmlPath;
  var handlers = {};
  var win = null;
  var devWin = null;      // separate "Tình trạng thiết bị" (MH2) window
  var incWin = null;      // incoming-call ring screen window
  var lastDevices = null;
  var lastState = null;
  var pendingPartner = null;
  var pendingIncomingPartner = null;
  var ready = false;      // window did-finish-load reached
  var queue = [];         // messages sent before the page is ready

  function onAction(_e, msg) {
    if (!msg || !msg.action) return;
    if (msg.action === 'win') { handleWin(win, msg.value); return; }        // call-window controls
    if (msg.action === 'devwin') { handleWin(devWin, msg.value); return; }  // device-window controls
    if (msg.action === 'incwin') { handleWin(incWin, msg.value); return; } // incoming-window controls
    if (msg.action === 'openSettings') { showDevices(); return; }           // gear / "Mở cài đặt"
    var cb = handlers[msg.action];
    if (cb) { try { cb(msg.value); } catch (e) {} }
  }
  function handleWin(w, op) {
    if (!w || w.isDestroyed()) return;
    try {
      if (op === 'minimize') w.minimize();
      else if (op === 'maximize') { w.isMaximized() ? w.unmaximize() : w.maximize(); }
      else if (op === 'close') w.close();
    } catch (e) {}
  }
  // Standalone device-status window (MH2). Independent (no parent) so it can be dragged outside the
  // call window; reuses the same preload bridge + IPC channels.
  function showDevices() {
    if (devWin && !devWin.isDestroyed()) { try { devWin.focus(); } catch (e) {} return; }
    if (!devicesHtmlPath || !BrowserWindow) return;
    devWin = new BrowserWindow({
      width: 420, height: 600, resizable: true, frame: false, title: 'Tình trạng thiết bị',
      backgroundColor: '#ffffff',
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true },
    });
    devWin.on('closed', function () { devWin = null; });
    devWin.webContents.once('did-finish-load', function () {
      if (lastDevices) { try { devWin.webContents.send('zcall-ui:devices', lastDevices); } catch (e) {} }
    });
    devWin.loadFile(devicesHtmlPath);
  }
  ipcMain.on('zcall-ui:action', onAction);

  function send(channel, payload) {
    if (!win || win.isDestroyed()) return;
    if (!ready) { queue.push([channel, payload]); return; }   // deliver after the page loads
    try { win.webContents.send(channel, payload); } catch (e) {}
  }
  function flush() {
    ready = true;
    var q = queue; queue = [];
    for (var i = 0; i < q.length; i++) { try { win.webContents.send(q[i][0], q[i][1]); } catch (e) {} }
  }

  return {
    show: function (partner, opts) {
      opts = opts || {};
      pendingPartner = partner || {};
      // callType seam: opts.callType 0=audio (only path today). A future video window would branch
      // here on opts.callType===1 to load a videoHtmlPath (separate window, mirrors native
      // ZCallMainWindowVideo_v2). Not implemented — audio only.
      if (win && !win.isDestroyed()) { send('zcall-ui:partner', pendingPartner); return; }
      ready = false; queue = [];
      win = new BrowserWindow({
        width: 456, height: 720, resizable: false, frame: false, alwaysOnTop: true,
        title: 'Zalo Call', backgroundColor: '#0068ff',
        webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true },
      });
      win.on('closed', function () {
        win = null; ready = false; queue = [];
        var cb = handlers['end']; if (cb) { try { cb(); } catch (e) {} }
      });
      win.webContents.once('did-finish-load', function () {
        try { win.webContents.send('zcall-ui:partner', pendingPartner); } catch (e) {}
        // Devices may have been set via setDevices() before the window existed (e.g. setupMedia
        // runs before onConfig calls show()); send() drops those since win was null. Re-deliver
        // the last known device list here, mirroring showDevices()'s re-delivery for devWin.
        if (lastDevices) { try { win.webContents.send('zcall-ui:devices', lastDevices); } catch (e) {} }
        flush();
      });
      win.loadFile(htmlPath);
    },
    setState: function (state, data) {
      var payload = { state: state };
      if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k];
      lastState = payload;
      send('zcall-ui:state', payload);
      if (incWin && !incWin.isDestroyed()) { try { incWin.webContents.send('zcall-ui:state', payload); } catch (e) {} }
    },
    setDevices: function (d) {
      lastDevices = d || {};
      send('zcall-ui:devices', lastDevices);
      if (devWin && !devWin.isDestroyed()) { try { devWin.webContents.send('zcall-ui:devices', lastDevices); } catch (e) {} }
    },
    showIncoming: function (partner) {
      pendingIncomingPartner = partner || {};
      if (incWin && !incWin.isDestroyed()) {
        try { incWin.webContents.send('zcall-ui:partner', pendingIncomingPartner); incWin.focus(); } catch (e) {}
        return;
      }
      if (!incomingHtmlPath || !BrowserWindow) return;
      incWin = new BrowserWindow({
        width: 360, height: 560, resizable: false, frame: false, alwaysOnTop: true,
        title: 'Cuộc gọi đến', backgroundColor: '#1A1A1A',
        webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true },
      });
      incWin.on('closed', function () { incWin = null; });
      incWin.webContents.once('did-finish-load', function () {
        try { incWin.webContents.send('zcall-ui:partner', pendingIncomingPartner); } catch (e) {}
        // setState() may have fired before the incoming window's page finished loading (the engine
        // calls showIncoming() then setState('ringing-incoming') in the same tick) — send() would have
        // dropped it since the renderer's listener wasn't registered yet. Re-deliver the latest state
        // here, mirroring showDevices()'s re-delivery of lastDevices to devWin on load.
        if (lastState) { try { incWin.webContents.send('zcall-ui:state', lastState); } catch (e) {} }
      });
      incWin.loadFile(incomingHtmlPath);
    },
    closeIncoming: function () {
      if (incWin && !incWin.isDestroyed()) { try { incWin.destroy(); } catch (e) {} incWin = null; }
    },
    on: function (event, cb) { handlers[event] = cb; },
    close: function () {
      // NOTE: keep the ipcMain 'zcall-ui:action' listener alive for the controller's whole life —
      // it is registered once and serves every call. Removing it here broke the 2nd+ call's buttons.
      if (devWin && !devWin.isDestroyed()) { try { devWin.destroy(); } catch (e) {} devWin = null; }
      if (incWin && !incWin.isDestroyed()) { try { incWin.destroy(); } catch (e) {} incWin = null; }
      if (win && !win.isDestroyed()) {
        var w = win; win = null; ready = false; queue = [];
        try { w.removeAllListeners('closed'); } catch (e) {}
        try { w.destroy(); } catch (e) {}
      }
    },
  };
}
module.exports = { createCallUI: createCallUI };
