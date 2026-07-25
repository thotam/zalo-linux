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
  // setupMedia populated the call: extendData available + audio started
  assert.ok(s416.data.session === CONFIG.sessId, '416 carries sessId as session');

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
  MediaSession: FakeSession, ZAudio: SpyAudio, ui: fakeUi, uiCloseDelay: 5, connectDelayMs: 5,
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
  // The caller's answer counts the duration immediately -> connected right away (no 'connecting' pause).
  const conn = uiCalls.find(c=>c[0]==='setState' && c[1]==='connected');
  assert.ok(conn && typeof conn[2].connectedAt === 'number', 'answer -> ui connected immediately + connectedAt');
  assert.ok(!uiCalls.some(c=>c[0]==='setState' && c[1]==='connecting'), 'answer does NOT emit a connecting state (immediate count)');

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

// --- busy: `control answer status=1` -> reason 1 "Người nhận bận" + busy.mp3 outcome (RE'd from native) ---
(async () => {
  const outB = []; const uiB = []; const hB = {};
  const engB = createMainEngine({
    sendToRender:(m)=>outB.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:()=>{}, setState:(s,d)=>uiB.push([s,d]), setDevices:()=>{}, on:(e,cb)=>{hB[e]=cb;}, close:()=>{} },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1919,
  });
  engB.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'Z' }], type:1 } });
  engB.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  engB.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:1919, status:1 } } });
  const bubB = outB.find(m=>m.command==='bubble');
  assert.ok(bubB && bubB.data.missed===true && bubB.data.reason===1, 'busy (status 1) -> missed reason 1 (Người nhận bận)');
  // The end tone for a busy line is busy.mp3, not endcall.mp3 (RE ZaloCall.exe onReceiverBusy).
  const endedB = uiB.find(c=>c[0]==='ended');
  assert.ok(endedB && endedB[1] && endedB[1].outcome==='busy', 'busy (status 1) -> ui ended outcome "busy" (busy.mp3)');
  console.log('OK main-engine busy-status');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- caller receives 407 ringring -> ringing state (ringback), no outbound signal ---
(async () => {
  const outR = []; const uiR = [];
  const engR = createMainEngine({
    sendToRender:(m)=>outR.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:()=>{}, setState:(s,d)=>uiR.push([s,d]), setDevices:()=>{}, on:()=>{}, close:()=>{} },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>5151,
  });
  engR.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'R' }], type:1 } });
  await new Promise(r=>setTimeout(r,20));
  outR.length = 0; uiR.length = 0;
  engR.handleSendToNative({ type:'recvSignal', command:407, data:{ callId:5151 } });
  assert.ok(outR.some(m=>m.command==='callState' && m.data.state==='ringing'), '407 -> callState ringing');
  assert.ok(uiR.some(c=>c[0]==='ringing'), '407 -> ui ringing');
  assert.ok(!outR.some(m=>m.type==='sendSignal'), '407 sends no outbound signal');
  console.log('OK main-engine ringing');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- no-answer: ring timeout fires -> 405 cancel + missed bubble reason 2 ---
(async () => {
  const outN = []; const hN = {};
  const engN = createMainEngine({
    sendToRender:(m)=>outN.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5, ringTimeoutMs:30, connectDelayMs:5,
    ui:{ show:()=>{}, setState:()=>{}, setDevices:()=>{}, on:(e,cb)=>{hN[e]=cb;}, close:()=>{} },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>8181,
  });
  engN.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'N' }], type:1 } });
  engN.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,60));  // > ringTimeoutMs
  assert.ok(outN.some(m=>m.command===405), 'ring timeout -> 405 cancel');
  const bubN = outN.find(m=>m.command==='bubble');
  assert.ok(bubN && bubN.data.missed===true && bubN.data.reason===2, 'ring timeout -> missed reason 2');
  console.log('OK main-engine no-answer-timeout');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- incoming: control request -> 407 ring + ringing-incoming + showIncoming ---
// Real incoming `control request` payload shape (live-RE'd): sessId = data.session (+ params.sessId),
// relays in params.extendData.serverResult + data.rtpAddress, our uid = data.uidTo, caller = data.uidN.
const INC_SESS = 'S'.repeat(160);
const INC = { act:'request', act_type:'voip', _caller:{ name:'Caller X', avatar:'http://a/c.png' },
  data:{ callId:6001, uidFrom:'999', uidN:'333', uidTo:'444', status:'0', ts:String(Date.now()),
    codec:'[{"name":"opus/16000/1","payload":112}]',
    session: INC_SESS, rtpAddress:'10.0.0.2:4200', rtcpAddress:'10.0.0.2:4200',
    params: JSON.stringify({ rtpIP:'10.0.0.2:4200', sessId: INC_SESS,
      extendData: JSON.stringify({ callType:0, srtpMode:1,
        serverResult:[{rtp:'10.0.0.2:4200', rtcp:'10.0.0.2:4200', rtt:50, recv:14},
                      {rtp:'10.0.0.3:4200', rtcp:'10.0.0.3:4200', rtt:80, recv:11}] }) }) } };
(async () => {
  const outI = []; const uiI = []; const hI = {};
  const engI = createMainEngine({
    sendToRender:(m)=>outI.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5, connectDelayMs:5,
    ui:{ show:()=>{}, showIncoming:(p)=>uiI.push(['showIncoming',p]), setState:(s,d)=>uiI.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hI[e]=cb;}, close:()=>uiI.push(['close']), closeIncoming:()=>uiI.push(['closeIncoming']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1,
  });
  engI.handleSendToNative({ type:'control', data: JSON.parse(JSON.stringify(INC)) });
  await new Promise(r=>setTimeout(r,10));
  assert.ok(outI.some(m=>m.command===407 && m.data.callId===6001 && String(m.data.callerId)==='333'), 'incoming -> 407 ringring, callerId = uidN (routing id)');
  assert.ok(outI.some(m=>m.command==='callState' && m.data.state==='ringing-incoming'), 'incoming -> ringing-incoming');
  assert.ok(uiI.some(c=>c[0]==='showIncoming' && c[1].name==='Caller X'), 'ui.showIncoming(caller)');
  // busy path
  const busyCtrl = JSON.parse(JSON.stringify(INC)); busyCtrl.inCallStatus='zalo'; busyCtrl.data.callId=6002;
  outI.length=0;
  engI.handleSendToNative({ type:'control', data: busyCtrl });
  assert.ok(outI.some(m=>m.command===402 && m.data.status===1 && m.data.callId===6002), 'busy -> 402 status 1');
  console.log('OK main-engine incoming-ring');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- incoming accept -> 402 status 0 + media + connected ---
(async () => {
  const outA = []; const uiA = []; const hA = {};
  const engA = createMainEngine({
    sendToRender:(m)=>outA.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5, connectDelayMs:5,
    ui:{ show:(p)=>uiA.push(['show',p]), showIncoming:(p)=>uiA.push(['showIncoming',p]), setState:(s,d)=>uiA.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hA[e]=cb;}, close:()=>uiA.push(['close']), closeIncoming:()=>uiA.push(['closeIncoming']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1,
  });
  engA.handleSendToNative({ type:'control', data: JSON.parse(JSON.stringify(INC)) });
  await new Promise(r=>setTimeout(r,10));
  hA['accept']();
  await new Promise(r=>setTimeout(r,20));
  // Media-first: setupMedia opens the relay as the callee, then 402 answer carries our extendData.
  const ans = outA.find(m=>m.command===402);
  assert.ok(ans && ans.data.status===0 && ans.data.session===INC_SESS, 'accept -> 402 status 0 + session (from data.session)');
  assert.strictEqual(String(ans.data.callerId), '333', 'accept 402 callerId = uidN (routing id)');
  assert.ok(ans.data.codec.includes('opus/16000/1'), '402 opus codec');
  assert.ok(ans.data.extendData && ans.data.extendData.length > 2, '402 carries our extendData (relay+p2p)');
  assert.ok(uiA.some(c=>c[0]==='closeIncoming'), 'accept closes incoming window');
  assert.ok(uiA.some(c=>c[0]==='show'), 'accept opens call window');
  assert.ok(uiA.some(c=>c[0]==='setState' && c[1]==='connected'), 'accept -> connected (media up)');
  // test-hygiene: setupMedia started c._iv (setInterval) — tear the call down so the process can exit.
  engA.stop();
  // An ANSWERED incoming call gets an engine call-log bubble (role 0, not missed) — the app doesn't
  // sync answered-incoming logs to us, so we provide it.
  const bubAns = outA.find(m=>m.command==='bubble');
  assert.ok(bubAns && bubAns.data.role===0 && bubAns.data.missed===false, 'answered incoming -> engine bubble role 0, not missed');
  console.log('OK main-engine incoming-accept');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- incoming decline -> 402 status 3 + teardown role 0 ---
(async () => {
  const outD2 = []; const uiD2 = []; const hD2 = {};
  const engD2 = createMainEngine({
    sendToRender:(m)=>outD2.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:()=>{}, showIncoming:(p)=>uiD2.push(['showIncoming',p]), setState:(s,d)=>uiD2.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hD2[e]=cb;}, close:()=>uiD2.push(['close']), closeIncoming:()=>uiD2.push(['closeIncoming']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1,
  });
  engD2.handleSendToNative({ type:'control', data: JSON.parse(JSON.stringify(INC)) });
  await new Promise(r=>setTimeout(r,10));
  hD2['decline']();
  const ans3 = outD2.find(m=>m.command===402 && m.data.status===3);
  assert.ok(ans3, 'decline -> 402 status 3');
  assert.strictEqual(ans3.data.session, INC_SESS, 'decline 402 carries session (so the reject registers)');
  assert.strictEqual(String(ans3.data.callerId), '333', 'decline 402 callerId = uidN (routing id, so the reject reaches the caller)');
  // The app logs INCOMING calls natively -> the engine must NOT emit its own bubble (would double-log).
  assert.ok(!outD2.some(m=>m.command==='bubble'), 'incoming decline emits NO engine bubble (native logs incoming)');
  assert.ok(outD2.some(m=>m.command==='callState' && m.data.state==='free'), 'incoming decline -> callState free');
  assert.ok(uiD2.some(c=>c[0]==='closeIncoming'), 'decline closes incoming window');
  console.log('OK main-engine incoming-decline');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- incoming remote cancel (caller hangs up while ringing) -> close incoming + callState free ---
(async () => {
  const outRC = []; const uiRC = []; const hRC = {};
  const engRC = createMainEngine({
    sendToRender:(m)=>outRC.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:()=>{}, showIncoming:(p)=>uiRC.push(['showIncoming',p]), setState:(s,d)=>uiRC.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hRC[e]=cb;}, close:()=>uiRC.push(['close']), closeIncoming:()=>uiRC.push(['closeIncoming']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1,
  });
  engRC.handleSendToNative({ type:'control', data: JSON.parse(JSON.stringify(INC)) });
  await new Promise(r=>setTimeout(r,10));
  engRC.handleSendToNative({ type:'control', data:{ act:'cancel', data:{ callId:6001 } } });
  assert.ok(uiRC.some(c=>c[0]==='closeIncoming'), 'remote cancel closes incoming window');
  assert.ok(outRC.some(m=>m.command==='callState' && m.data.state==='free'), 'remote cancel -> callState free');
  console.log('OK main-engine incoming-remote-cancel');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- outgoing: remote ringing arrives as `control ring_ring` (NOT recvSignal 407) -> ringing state ---
(async () => {
  const outRR = []; const uiRR = [];
  const engRR = createMainEngine({
    sendToRender:(m)=>outRR.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5, connectDelayMs:5, ringTimeoutMs:100000,
    ui:{ show:()=>{}, setState:(s,d)=>uiRR.push([s,d]), setDevices:()=>{}, on:()=>{}, close:()=>{}, showIncoming:()=>{}, closeIncoming:()=>{} },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>5252,
  });
  engRR.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'RR' }], type:1 } });
  engRR.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  outRR.length = 0; uiRR.length = 0;
  engRR.handleSendToNative({ type:'control', data:{ act:'ring_ring', data:{ callId:5252, status:0 } } });
  assert.ok(outRR.some(m=>m.command==='callState' && m.data.state==='ringing'), 'control ring_ring -> callState ringing');
  assert.ok(uiRR.some(c=>c[0]==='ringing'), 'control ring_ring -> ui ringing (ringback)');
  assert.ok(!outRR.some(m=>m.type==='sendSignal'), 'control ring_ring sends no outbound signal');
  engRR.stop();
  console.log('OK main-engine outgoing-ring_ring');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- speaker mute gates inbound playback (RE ZaloCall.exe muteSpeaker = output mute) + a duplicate
//     `control answer status:0` is ignored (native state machine only answers from the ringing state) ---
(async () => {
  const outS = []; const hS = {};
  let spySession = null, playCount = 0;
  class SpySession extends FakeSession { constructor(o){ super(o); spySession = this; } }
  class CountAudio extends FakeAudio { play(){ playCount++; } }
  const engS = createMainEngine({
    sendToRender:(m)=>outS.push(m), MediaSession:SpySession, ZAudio:CountAudio, uiCloseDelay:5, connectDelayMs:100000, ringTimeoutMs:100000,
    ui:{ show:()=>{}, setState:()=>{}, setDevices:()=>{}, on:(e,cb)=>{hS[e]=cb;}, close:()=>{}, showIncoming:()=>{}, closeIncoming:()=>{} },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>8888,
  });
  engS.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'S' }], type:1 } });
  engS.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  engS.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:8888, status:0 } } });
  await new Promise(r=>setTimeout(r,5));

  // default: inbound media is played out
  spySession._h['media']({ payload: Buffer.alloc(4) });
  assert.strictEqual(playCount, 1, 'inbound media played out by default');
  // speaker muted: media still arrives but is NOT played out
  hS['toggleSpeaker'](true);
  spySession._h['media']({ payload: Buffer.alloc(4) });
  assert.strictEqual(playCount, 1, 'speaker muted -> inbound media not played out');
  // unmuted again: playback resumes
  hS['toggleSpeaker'](false);
  spySession._h['media']({ payload: Buffer.alloc(4) });
  assert.strictEqual(playCount, 2, 'speaker unmuted -> playback resumes');

  // a duplicate `control answer status:0` for the already-connected call is a no-op (no 2nd 408)
  const n408 = outS.filter(m=>m.command===408).length;
  engS.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:8888, status:0 } } });
  await new Promise(r=>setTimeout(r,5));
  assert.strictEqual(outS.filter(m=>m.command===408).length, n408, 'duplicate answer ignored -> no second 408');

  engS.stop();   // clear c._iv / c._connTimer so the process can exit
  console.log('OK main-engine speaker-mute + dup-answer');
})().catch(e=>{ console.error(e); process.exit(1); });
