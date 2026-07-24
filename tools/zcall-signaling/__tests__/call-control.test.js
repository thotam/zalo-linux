const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'call-control.js');
const { pickAddr, buildRingArgs, buildExtendData, OPUS_CODEC } = require(MOD);

const cfg = {
  toId: 222,
  sessId: 'S'.repeat(154),
  rtpIP: '1.1.1.1|1000',
  rtcpIP: '1.1.1.1|1001',
  servers: [{ rtpaddr: '2.2.2.2|2000', rtcpaddr: '2.2.2.2|2001' }],
};

// pickAddr sources
assert.deepStrictEqual(pickAddr(cfg, null, 'config'), { rtp: '1.1.1.1|1000', rtcp: '1.1.1.1|1001' }, 'config addr');
assert.deepStrictEqual(pickAddr(cfg, null, 'server0'), { rtp: '2.2.2.2|2000', rtcp: '2.2.2.2|2001' }, 'server0 addr');
assert.deepStrictEqual(pickAddr(cfg, { ip: '3.3.3.3', port: '3000' }, 'relay'), { rtp: '3.3.3.3:3000', rtcp: '3.3.3.3:3000' }, 'relay addr uses colon');

// buildRingArgs positional order: [calleeId, rtcp, rtp, codec, extendData, session, callId]
// calleeId defaults to config.toId, but the original (19-digit) id wins when provided.
const a = buildRingArgs({ config: cfg, callId: 99, addrSource: 'config' });
assert.deepStrictEqual(a, ['222', '1.1.1.1|1001', '1.1.1.1|1000', '[]', '', 'S'.repeat(154), 99], 'ring args default calleeId=toId');
assert.strictEqual(buildRingArgs({ calleeId: '6664457779001834719', config: cfg, callId: 99 })[0], '6664457779001834719', 'original calleeId used when given');
assert.strictEqual(buildRingArgs({ config: cfg, callId: 99, addrSource: 'server0' })[1], '2.2.2.2|2001', 'server0 rtcp in slot 1');

// buildRingArgs with the connect payload (§I): selected relay as rtp/rtcp, real codec, extendData
// (object → JSON string) fills slots 2,1 / 3 / 4.
const ext = buildExtendData({
  results: [{ host: '9.9.9.9', recv: 5, rtt: 20 }, { host: '8.8.8.8', recv: 2, rtt: 40 }],
  selectedHost: '9.9.9.9',
  p2p: [{ ip: '192.168.1.5', port: 5000, type: 0 }],
});
assert.strictEqual(ext.srtpMode, 1, 'extendData srtpMode:1');
assert.strictEqual(ext.newZrtc, 1, 'extendData newZrtc:1');
assert.deepStrictEqual(ext.serverAddr, [{ rtp: '9.9.9.9:4200', rtcp: '9.9.9.9:4200', tpType: 0 }], 'serverAddr = selected relay');
assert.strictEqual(ext.serverResult.length, 2, 'serverResult per replying relay');
assert.deepStrictEqual(ext.serverResult[0], { rtp: '9.9.9.9:4200', rtcp: '9.9.9.9:4200', recv: 5, rtt: 20, spTcp: 1, tpType: 0 }, 'serverResult[0]');
assert.deepStrictEqual(ext.p2p, [{ ip: '192.168.1.5', port: 5000, type: 0 }], 'p2p candidates');

const a2 = buildRingArgs({ calleeId: '6664', config: cfg, callId: 7, rtpAddress: '9.9.9.9:4200', codec: OPUS_CODEC, extendData: ext });
assert.strictEqual(a2[1], '9.9.9.9:4200', 'rtcpAddress = selected relay');
assert.strictEqual(a2[2], '9.9.9.9:4200', 'rtpAddress = selected relay');
assert.ok(a2[3].includes('opus/16000/1'), 'codec = real opus');
assert.ok(a2[4].includes('serverResult') && a2[4].includes('srtpMode'), 'extendData serialized to JSON string');
assert.strictEqual(a2[5], cfg.sessId, 'session = sessId');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK call-control');
