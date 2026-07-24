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

  eng.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:4242, status:0 } } });
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

  eng2.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:7777, status:0 } } });
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
  // call end emits a "bubble" update so the render writes the chat call-log entry
  const bub = out2.find(m=>m.type==='update' && m.command==='bubble');
  assert.ok(bub, 'end emits a bubble update for the chat call-log');
  // callState 'free' MUST precede the bubble so the header re-render sees callRunning=false
  const idxFree = out2.findIndex(m=>m.command==='callState' && m.data.state==='free');
  const idxBub = out2.findIndex(m=>m.command==='bubble');
  assert.ok(idxFree >= 0 && idxBub > idxFree, 'callState free emitted before bubble (tooltip refresh order)');
  assert.strictEqual(bub.data.partnerId, '6664', 'bubble partnerId = callee');
  assert.ok(bub.data.role, 'bubble role truthy (outgoing)');
  assert.strictEqual(typeof bub.data.duration, 'number', 'bubble duration is seconds');
  assert.strictEqual(bub.data.missed, false, 'answered+ended -> not missed');
  assert.strictEqual(bub.data.reason, 0, 'answered call reason 0');
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

// --- remote decline / hangup: recvSignal 409 must tear the call down (close the window) ---
(async () => {
  const uiCalls3 = []; const uiH3 = {};
  const fakeUi3 = { show:(p)=>uiCalls3.push(['show',p]), setState:(s,d)=>uiCalls3.push(['setState',s,d]),
    setDevices:()=>{}, on:(e,cb)=>{uiH3[e]=cb;}, close:()=>uiCalls3.push(['close']) };
  const out3 = [];
  const eng3 = createMainEngine({
    sendToRender:(m)=>out3.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, ui:fakeUi3, uiCloseDelay:5,
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>9090,
  });
  eng3.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'Z' }], type:1 } });
  eng3.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  assert.ok(uiCalls3.some(c=>c[0]==='show'), 'call window shown');
  // remote party declines / hangs up -> render forwards recvSignal 409
  eng3.handleSendToNative({ type:'recvSignal', command:409, data:{} });
  assert.ok(uiCalls3.some(c=>c[0]==='setState' && c[1]==='ended'), 'recvSignal 409 -> ui ended');
  await new Promise(r=>setTimeout(r,15));
  assert.ok(uiCalls3.some(c=>c[0]==='close'), 'recvSignal 409 -> window closed');
  // and it MUST emit callState 'free' so the render clears its "in another call" flag
  assert.ok(out3.some(m=>m.type==='update' && m.command==='callState' && m.data.state==='free'), 'teardown emits callState free');
  console.log('OK main-engine remote-end');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- remote decline while ringing arrives as control "cancel" -> teardown + callState free ---
(async () => {
  const outC = []; const uiC = []; const hC = {};
  const engC = createMainEngine({
    sendToRender:(m)=>outC.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:(p)=>uiC.push(['show',p]), setState:(s,d)=>uiC.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hC[e]=cb;}, close:()=>uiC.push(['close']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>3131,
  });
  engC.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'Z' }], type:1 } });
  engC.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  // callee declines while ringing -> control cancel
  engC.handleSendToNative({ type:'control', data:{ act:'cancel', data:{ callId:3131 } } });
  assert.ok(uiC.some(c=>c[0]==='setState' && c[1]==='ended'), 'control cancel -> ui ended');
  assert.ok(outC.some(m=>m.type==='update' && m.command==='callState' && m.data.state==='free'), 'control cancel -> callState free (clears in-call flag)');
  const bubC = outC.find(m=>m.command==='bubble');
  assert.ok(bubC && bubC.data.missed===true && bubC.data.reason===2, 'remote cancel/timeout -> missed reason 2 (generic, not reject)');
  console.log('OK main-engine cancel');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- decline via `control answer status=3` (NOT 0): must NOT connect (no timer), must tear down ---
(async () => {
  const outD = []; const uiD = []; const hD = {};
  const engD = createMainEngine({
    sendToRender:(m)=>outD.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:(p)=>uiD.push(['show',p]), setState:(s,d)=>uiD.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hD[e]=cb;}, close:()=>uiD.push(['close']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>2222,
  });
  engD.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'Z' }], type:1 } });
  engD.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  // callee declines -> control answer with status 3 (busy/decline), NOT 0
  engD.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:2222, status:3 } } });
  assert.ok(!uiD.some(c=>c[0]==='setState' && c[1]==='connected'), 'declined answer (status 3) does NOT connect -> no timer');
  assert.ok(!outD.some(m=>m.command===408), 'declined answer sends no 408 answerack');
  assert.ok(uiD.some(c=>c[0]==='setState' && c[1]==='ended'), 'declined answer -> ui ended');
  assert.ok(outD.some(m=>m.type==='update' && m.command==='callState' && m.data.state==='free'), 'declined answer -> callState free');
  const bubD = outD.find(m=>m.command==='bubble');
  assert.ok(bubD && bubD.data.missed===true && bubD.data.reason===3, 'declined -> missed reason 3 (callee rejected)');
  console.log('OK main-engine decline-status');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- no-answer / timeout arrives as `control answer status=6` -> reason 2 (generic), NOT reject ---
(async () => {
  const outT = []; const hT = {};
  const engT = createMainEngine({
    sendToRender:(m)=>outT.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:()=>{}, setState:()=>{}, setDevices:()=>{}, on:(e,cb)=>{hT[e]=cb;}, close:()=>{} },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1717,
  });
  engT.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'Z' }], type:1 } });
  engT.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  engT.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:1717, status:6 } } });
  const bubT = outT.find(m=>m.command==='bubble');
  assert.ok(bubT && bubT.data.missed===true && bubT.data.reason===2, 'no-answer (status 6) -> missed reason 2 (generic, not reject)');
  console.log('OK main-engine timeout-status');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- busy: `control answer status=1` -> reason 1 "Người nhận bận" (RE'd from native) ---
(async () => {
  const outB = []; const hB = {};
  const engB = createMainEngine({
    sendToRender:(m)=>outB.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:()=>{}, setState:()=>{}, setDevices:()=>{}, on:(e,cb)=>{hB[e]=cb;}, close:()=>{} },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1919,
  });
  engB.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'Z' }], type:1 } });
  engB.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  engB.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:1919, status:1 } } });
  const bubB = outB.find(m=>m.command==='bubble');
  assert.ok(bubB && bubB.data.missed===true && bubB.data.reason===1, 'busy (status 1) -> missed reason 1 (Người nhận bận)');
  console.log('OK main-engine busy-status');
})().catch(e=>{ console.error(e); process.exit(1); });
