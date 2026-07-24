const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'requestcall.js');
const { parseConfig, srtpMasterKey, buildRequestUrl } = require(MOD);
const { decodeToString } = require(path.join(__dirname, '..', 'zpw.js'));

// srtpMasterKey = first 30 ASCII bytes of sessId
const sess = 'A'.repeat(154);
const key = srtpMasterKey(sess);
assert.ok(Buffer.isBuffer(key) && key.length === 30, '30-byte key');
assert.strictEqual(key.toString('ascii'), 'A'.repeat(30), 'first 30 chars');
assert.throws(() => srtpMasterKey('short'), /30/, 'too-short sessId throws');

// parseConfig validates sessId length + servers
const good = JSON.stringify({ sessId: sess, servers: [{ rtpaddr: '1.2.3.4:4200' }], changeZRTP: { enable: 0 } });
const cfg = parseConfig(good);
assert.strictEqual(cfg.sessId.length, 154, 'sessId parsed');
assert.strictEqual(cfg.changeZRTP.enable, 0, 'changeZRTP parsed');
// variable-length sessId is accepted (observed 152 across accounts)
const cfg152 = parseConfig(JSON.stringify({ sessId: 'A'.repeat(152), servers: [{ rtpaddr: '1.2.3.4:4200' }] }));
assert.strictEqual(cfg152.sessId.length, 152, '152-char sessId accepted');
assert.throws(() => parseConfig(JSON.stringify({ sessId: 'x', servers: [] })), /sessId|servers/, 'bad config throws');

// buildRequestUrl re-encrypts params with overrides, keeps other query keys
const secretKey = Buffer.alloc(16, 7).toString('base64');
const sampleUrl = 'https://voicecall-wpa.chat.zalo.me/api/voicecall/requestcall?zpw_ver=1&zpw_type=2&params=OLDCIPHER';
const url = buildRequestUrl({ sampleUrl, sampleParamsPlain: { calleeId: '111', callId: 10, imei: 'x' }, secretKey, overrides: { callId: 99 } });
assert.ok(url.startsWith('https://voicecall-wpa.chat.zalo.me/api/voicecall/requestcall?'), 'base url kept');
assert.ok(url.includes('zpw_ver=1') && url.includes('zpw_type=2'), 'other query kept');
const m = url.match(/[?&]params=([^&]+)/);
assert.ok(m, 'params present');
const decoded = JSON.parse(decodeToString(m[1], secretKey));
assert.strictEqual(decoded.callId, 99, 'override applied');
assert.strictEqual(decoded.calleeId, '111', 'sample field kept');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK requestcall');
