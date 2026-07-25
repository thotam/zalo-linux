const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(dir, 'call.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'icons.css'), 'utf8');
const nativeCss = fs.readFileSync(path.join(dir, 'icons-native.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'call.js'), 'utf8');
const preload = fs.readFileSync(path.join(dir, 'preload.js'), 'utf8');

// html wires the stylesheets + scripts
for (const ref of ['icons.css', 'icons-native.css', 'call.css', 'call-format.js', 'sounds.js', 'call.js']) {
  assert.ok(html.includes(ref), 'call.html references ' + ref);
}
// required DOM ids
for (const id of ['id="bg"', 'id="avatar"', 'id="status"', 'id="timer"', 'id="btn-mic"', 'id="btn-end"', 'id="btn-speaker"', 'id="btn-gear"', 'id="mic-menu"']) {
  assert.ok(html.includes(id), 'call.html has ' + id);
}
assert.ok(!html.includes('id="btn-cam"'), 'call.html no longer has btn-cam (replaced by speaker toggle)');
// icon font still wired for the titlebar call icon + chevrons
assert.ok(/@font-face/.test(css) && css.includes('zalo-font.ttf'), 'icons.css @font-face zalo-font.ttf');
for (const cp of ['\\eb9e', '\\ea8d']) {
  assert.ok(css.includes(cp), 'icons.css defines codepoint ' + cp);
}
// native PNG icons wired for the control bar (mic/speaker/end/gear are no longer the font)
for (const png of ['assets/native/mic.png', 'assets/native/endcall.png', 'assets/native/speaker.png', 'assets/native/setting.png']) {
  assert.ok(nativeCss.includes(png), 'icons-native.css references ' + png);
}
// renderer talks to the bridge for the two functional controls
assert.ok(js.includes("action('end'") || js.includes('action("end"'), 'call.js sends end');
assert.ok(js.includes("action('mute'") || js.includes('action("mute"'), 'call.js sends mute');
// preload exposes the bridge, no nodeIntegration leakage
assert.ok(preload.includes('exposeInMainWorld') && preload.includes('zcallUI'), 'preload exposes zcallUI');

// device-status window (MH2) is a separate page
const devHtml = fs.readFileSync(path.join(dir, 'devices.html'), 'utf8');
const devJs = fs.readFileSync(path.join(dir, 'devices.js'), 'utf8');
for (const ref of ['icons.css', 'devices.css', 'devices.js']) {
  assert.ok(devHtml.includes(ref), 'devices.html references ' + ref);
}
for (const id of ['id="sel-mic"', 'id="sel-spk"', 'id="mic-meter"', 'id="dlg-cancel"']) {
  assert.ok(devHtml.includes(id), 'devices.html has ' + id);
}
assert.ok(devHtml.includes('Tình trạng thiết bị'), 'devices.html has the MH2 title');
assert.ok(devJs.includes("action('devwin'") || devJs.includes('action("devwin"'), 'devices.js drives its own window controls');

console.log('OK renderer-structure');
