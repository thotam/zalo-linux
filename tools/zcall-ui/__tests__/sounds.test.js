// tools/zcall-ui/__tests__/sounds.test.js
const assert = require('assert');
const path = require('path');
const { createSounds } = require('../sounds.js');

function mk() {
  const log = [];
  const make = (name) => ({ name, loop:false, play(){ log.push('play:'+this.name+(this.loop?':loop':'')); }, pause(){ log.push('pause:'+this.name); } });
  return { log, s: createSounds({ make }) };
}

let { log, s } = mk();
s.apply('calling');
assert.ok(log.some(l=>l.startsWith('play:connecting.mp3')), 'calling (dialing) -> connecting tone before ringback');
({ log, s } = mk());
s.apply('ringing');
assert.ok(log.some(l=>l.startsWith('play:zalo_ringback.mp3')), 'ringing -> ringback');
s.apply('connecting');
assert.ok(log.some(l=>l==='pause:zalo_ringback.mp3'), 'connecting stops ringback');
assert.ok(log.some(l=>l.startsWith('play:connecting.mp3')), 'connecting -> connecting.mp3');
s.apply('connected');
assert.ok(log.filter(l=>l.startsWith('pause:')).length>=1, 'connected stops loops');

({ log, s } = mk());
s.apply('ringing-incoming');
assert.ok(log.some(l=>l.startsWith('play:zalo_ringtone.mp3')), 'incoming -> ringtone');

({ log, s } = mk());
s.apply('ended', 'busy');
assert.ok(log.some(l=>l.startsWith('play:busy.mp3')), 'ended busy -> busy.mp3');
({ log, s } = mk());
s.apply('ended');
assert.ok(log.some(l=>l.startsWith('play:endcall.mp3')), 'ended default -> endcall.mp3');

require('child_process').execFileSync(process.execPath, ['--check', path.join(__dirname,'..','sounds.js')]);
console.log('OK sounds');
