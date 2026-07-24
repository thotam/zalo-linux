const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'engine.js');
const { createEngine } = require(MOD);

// Fakes so the engine runs with no device/network/addon.
class FakeSession {
  constructor(opts) { this.opts = opts; this._h = {}; this.sock = { address: () => ({ port: 55555 }) }; this.sent = 0; this.closed = false; }
  on(ev, cb) { this._h[ev] = cb; }
  async open() { return { results: [{ host: '10.0.0.1', recv: 3, rtt: 20, flowToken: Buffer.alloc(4, 1) }], host: '10.0.0.1', port: 4200, flowToken: Buffer.alloc(4, 1) }; }
  send() { this.sent++; }
  close() { this.closed = true; }
}
class FakeAudio { constructor() { this.started = false; this.stopped = false; } start(cb) { this.started = true; this._cb = cb; } play() {} stop() { this.stopped = true; } }

const CONFIG = { sessId: 'A'.repeat(154), servers: [{ rtpaddr: '10.0.0.1:4200' }], rtpIP: '10.0.0.1:4200', fromId: 111, toId: 222, changeZRTP: { enable: 0 } };
const signals = [];
const engine = createEngine({
  MediaSession: FakeSession,
  ZAudio: FakeAudio,
  os: { networkInterfaces: () => ({ eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.9' }] }) },
  randomCallId: () => 4242,
});
engine.onCallSignal((type, data) => { signals.push({ type, data }); return type === 401 ? Promise.resolve(CONFIG) : Promise.resolve({ ok: true }); });

(async () => {
  // makeCall intent → engine drives 401 then 416
  engine.sendDataToNative({ type: 'request', command: 'makeCall', data: { partner: [{ id: '6664' }], type: 1 } });
  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(signals[0].type, 401, 'first signal is 401 requestcall');
  assert.strictEqual(signals[0].data.calleeId, '6664', '401 calleeId = original id');
  assert.strictEqual(signals[1].type, 416, 'second signal is 416 request');
  assert.strictEqual(signals[1].data.rtpAddress, '10.0.0.1:4200', '416 rtpAddress = selected relay');
  assert.ok(signals[1].data.codec.includes('opus/16000/1'), '416 codec = opus');
  const ext = JSON.parse(signals[1].data.extendData);
  assert.ok(ext.serverResult.length >= 1 && ext.serverAddr.length === 1 && ext.srtpMode === 1, '416 extendData well-formed');
  assert.strictEqual(signals[1].data.session, CONFIG.sessId, '416 session = sessId');

  // answer control → engine sends 408 answerack
  engine.sendDataToNative({ type: 'control', data: { act_type: 'voip', act: 'answer', data: { callId: 4242, params: '{"rtpSerIp":"10.0.0.1:4200"}' } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(signals.some((s) => s.type === 408), 'answer → 408 answerack sent');

  // end_call → teardown (no throw)
  engine.sendDataToNative({ type: 'control', data: { act_type: 'voip', act: 'end_call', data: { callId: 4242 } } });

  cp.execFileSync(process.execPath, ['--check', MOD]);
  console.log('OK engine-outgoing');
})().catch((e) => { console.error(e); process.exit(1); });
