const assert = require('assert');
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'assets', 'native');
const NEED = ['accept_audiocall.png','endcall.png','mic.png','mic_off.png','speaker.png','speaker_off.png',
  'setting.png','close.png','more.png','accept_videocall.png','decor-call-wave.png','decor-call-wave@2x.png','decor-call-wave@3x.png','zalo_logo.png',
  'zalo_ringtone.mp3','zalo_ringback.mp3','connecting.mp3','endcall.mp3','busy.mp3','disconnect.mp3'];
const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
for (const f of NEED) {
  const p = path.join(DIR, f);
  assert.ok(fs.existsSync(p), 'missing asset: ' + f);
  const b = fs.readFileSync(p);
  if (f.endsWith('.png')) assert.ok(b.slice(0,8).equals(PNG), 'bad PNG magic: ' + f);
  if (f.endsWith('.mp3')) assert.ok(b.slice(0,3).toString('ascii')==='ID3', 'bad MP3(ID3) magic: ' + f);
}
console.log('OK native-assets');
