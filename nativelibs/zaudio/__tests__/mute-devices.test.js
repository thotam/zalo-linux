const assert = require('assert');
const path = require('path');
const { ZAudio } = require(path.join(__dirname, '..', 'build', 'Release', 'zaudio.node'));

const a = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20 });

// setMute exists and is safe to toggle without a running device.
assert.strictEqual(typeof a.setMute, 'function', 'setMute is a method');
a.setMute(true);
a.setMute(false);
a.setMute(true);

// Device enumeration — shape only; a headless host may report zero devices.
assert.strictEqual(typeof a.listDevices, 'function', 'listDevices is a method');
const d = a.listDevices();
assert.ok(d && Array.isArray(d.capture) && Array.isArray(d.playback), 'listDevices() -> {capture:[],playback:[]}');
for (const dev of d.capture.concat(d.playback)) {
  assert.strictEqual(typeof dev.index, 'number', 'device.index');
  assert.strictEqual(typeof dev.name, 'string', 'device.name');
  assert.strictEqual(typeof dev.isDefault, 'boolean', 'device.isDefault');
}
// Selection setters are safe without a running device.
assert.strictEqual(typeof a.setInputDevice, 'function', 'setInputDevice is a method');
assert.strictEqual(typeof a.setOutputDevice, 'function', 'setOutputDevice is a method');
a.setInputDevice(-1);
a.setOutputDevice(-1);
a.setInputDevice(0);

console.log('OK zaudio mute+devices (cap ' + d.capture.length + ', play ' + d.playback.length + ')');
