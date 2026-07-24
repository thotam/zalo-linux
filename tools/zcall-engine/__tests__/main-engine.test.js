const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'main-engine.js');
const { createMainEngine } = require(MOD);

class FakeSession {
  constructor(o){ this.o=o; this._h={}; this.sock={address:()=>({port:55555})}; }
  on(ev,cb){ this._h[ev]=cb; }
  async open(){ return { results:[{host:'10.0.0.1',recv:3,rtt:20,flowToken:Buffer.alloc(4,1)}], host:'10.0.0.1', port:4200, flowToken:Buffer.alloc(4,1) }; }
  send(){} close(){ this.closed=true; }
}
class FakeAudio {
  constructor(){ this.muted=null; this.inDev=null; this.outDev=null; }
  start(cb){ this.started=true; this._cb=cb; }
  play(){}
  stop(){ this.stopped=true; }
  setMute(v){ this.muted=v; }
  listDevices(){ return { capture:[{index:0,name:'mic0',isDefault:true}], playback:[{index:0,name:'spk0',isDefault:true}] }; }
  setInputDevice(i){ this.inDev=i; }
  setOutputDevice(i){ this.outDev=i; }
}

const CONFIG = { sessId:'A'.repeat(154), servers:[{rtpaddr:'10.0.0.1:4200'}], rtpIP:'10.0.0.1:4200', fromId:111, toId:222, changeZRTP:{enable:0} };
const out = [];
const eng = createMainEngine({
  sendToRender: (m)=>out.push(m),
  MediaSession: FakeSession, ZAudio: FakeAudio,
  os: { networkInterfaces: ()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
  randomCallId: ()=>4242,
});

(async () => {
  eng.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{id:'6664'}], type:1 } });
  await new Promise(r=>setTimeout(r,10));
  assert.strictEqual(out[0].type, 'sendSignal', 'emit sendSignal');
  assert.strictEqual(out[0].command, 401, '401 requestcall');
  assert.strictEqual(out[0].data.calleeId, '6664', '401 calleeId');

  eng.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  const s416 = out.find(m=>m.command===416);
  assert.ok(s416, '416 emitted after config');
  assert.strictEqual(s416.data.rtpAddress, '10.0.0.1:4200', '416 selected relay');
  assert.ok(s416.data.codec.includes('opus/16000/1'), '416 opus codec');
  const ext = JSON.parse(s416.data.extendData);
  assert.ok(ext.serverResult.length>=1 && ext.serverAddr.length===1 && ext.srtpMode===1, '416 extendData');

  eng.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:4242 } } });
  await new Promise(r=>setTimeout(r,10));
  assert.ok(out.some(m=>m.command===408), '408 answerack after answer');

  eng.handleSendToNative({ type:'control', data:{ act:'end_call', data:{ callId:4242 } } });

  cp.execFileSync(process.execPath, ['--check', MOD]);
  console.log('OK main-engine');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- UI-driven engine ---
const uiCalls = []; const uiHandlers = {};
const fakeUi = {
  show: (p) => uiCalls.push(['show', p]),
  setState: (s, d) => uiCalls.push(['setState', s, d]),
  setDevices: (d) => uiCalls.push(['setDevices', d]),
  on: (e, cb) => { uiHandlers[e] = cb; },
  close: () => uiCalls.push(['close']),
};
const out2 = [];
let lastAudio = null;
class SpyAudio extends FakeAudio { constructor(o){ super(o); lastAudio = this; } }
const eng2 = createMainEngine({
  sendToRender: (m) => out2.push(m),
  MediaSession: FakeSession, ZAudio: SpyAudio, ui: fakeUi, uiCloseDelay: 5,
  os: { networkInterfaces: () => ({ eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.9' }] }) },
  randomCallId: () => 7777,
});

(async () => {
  eng2.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'Tâm Tho', avatar:'http://a/x.png' }], type:1 } });
  eng2.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  assert.ok(uiCalls.some(c=>c[0]==='show' && c[1].name==='Tâm Tho' && c[1].avatar==='http://a/x.png'), 'ui.show(partner)');
  assert.ok(uiCalls.some(c=>c[0]==='setState' && c[1]==='calling'), 'ui calling');
  assert.ok(uiCalls.some(c=>c[0]==='setDevices' && c[1].capture.length===1), 'ui devices from listDevices');

  eng2.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:7777 } } });
  await new Promise(r=>setTimeout(r,10));
  const conn = uiCalls.find(c=>c[0]==='setState' && c[1]==='connected');
  assert.ok(conn && typeof conn[2].connectedAt === 'number', 'ui connected + connectedAt');

  // window actions route back to engine/audio
  uiHandlers['mute'](true);
  assert.strictEqual(lastAudio.muted, true, 'mute -> audio.setMute');
  uiHandlers['selectInput'](0);
  assert.strictEqual(lastAudio.inDev, 0, 'selectInput -> audio.setInputDevice');
  uiHandlers['selectOutput'](0);
  assert.strictEqual(lastAudio.outDev, 0, 'selectOutput -> audio.setOutputDevice');

  uiHandlers['end']();
  assert.ok(out2.some(m=>m.command===409), 'end -> 409 endcall signal');
  assert.ok(uiCalls.some(c=>c[0]==='setState' && c[1]==='ended'), 'ui ended');
  await new Promise(r=>setTimeout(r,15));
  assert.ok(uiCalls.some(c=>c[0]==='close'), 'ui closed after delay');

  // cancel path: pressing End while still ringing (not answered) -> 405 cancel, not 409
  eng2.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'X' }], type:1 } });
  eng2.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  out2.length = 0;
  uiHandlers['end']();
  assert.ok(out2.some(m=>m.command===405), 'end while ringing -> 405 cancel');
  assert.ok(!out2.some(m=>m.command===409), 'no 409 while ringing');

  console.log('OK main-engine ui');
})().catch(e=>{ console.error(e); process.exit(1); });
