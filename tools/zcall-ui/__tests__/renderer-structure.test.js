const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(dir, 'call.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'icons.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'call.js'), 'utf8');
const preload = fs.readFileSync(path.join(dir, 'preload.js'), 'utf8');

// html wires the stylesheets + scripts
for (const ref of ['icons.css', 'call.css', 'call-format.js', 'call.js']) {
  assert.ok(html.includes(ref), 'call.html references ' + ref);
}
// required DOM ids
for (const id of ['id="bg"', 'id="avatar"', 'id="status"', 'id="timer"', 'id="btn-mic"', 'id="btn-end"', 'id="btn-cam"', 'id="btn-gear"', 'id="mic-menu"']) {
  assert.ok(html.includes(id), 'call.html has ' + id);
}
// icon font wired + the real Zalo codepoints
assert.ok(/@font-face/.test(css) && css.includes('zalo-font.ttf'), 'icons.css @font-face zalo-font.ttf');
for (const cp of ['\\eb9e', '\\ec59', '\\ec5b', '\\ed1a', '\\ea8d']) {
  assert.ok(css.includes(cp), 'icons.css defines codepoint ' + cp);
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
